// Main conversation view: header actions, quick filters, selection bar, message feed and pager.

import { app } from '../state.js';
import { S, saveSettings } from '../settings.js';
import {
  h, $, $$, esc, fmtNum, copyText, messageLink, parseDateInput, isSystem, attachmentKind, messageBody, cmpId, debounce, fill,
} from '../util.js';
import { makeContext, renderMessage, shouldGroup } from '../render.js';
import { toast, menu, confirmDialog } from './dom.js';
import * as dialogs from './dialogs.js';
import { Job } from '../jobs.js';
import { slimForBulk } from '../bulk.js';

let lastClicked = null;

export const CATEGORIES = [
  ['mine', 'Mine'], ['attachments', 'Attachments'], ['images', 'Images'], ['videos', 'Videos'], ['links', 'Links'],
  ['embeds', 'Embeds'], ['reactions', 'Reactions'], ['pinned', 'Pinned'], ['edited', 'Edited'], ['replies', 'Replies'],
  ['forwarded', 'Forwarded'], ['stickers', 'Stickers'], ['polls', 'Polls'], ['threads', 'Thread starters'],
  ['system', 'System'], ['calls', 'Calls'], ['pins', 'Pin notices'], ['deleted', 'Deleted on Discord'],
];

export function mount() {
  const main = $('#main');
  fill(main, 
    h('div', { class: 'conv-head', id: 'conv-head' }),
    h('div', { class: 'filterbar', id: 'filterbar', hidden: true }),
    h('div', { class: 'selbar', id: 'selbar', hidden: true }),
    h('div', { class: 'feed-wrap' }, h('div', { class: 'feed', id: 'feed' })),
    h('div', { class: 'pager', id: 'pager' }),
  );
  $('#feed').addEventListener('click', onFeedClick);
  // Like Discord: when you are at the newest message, stay there while images and embeds finish
  // loading (they grow the messages after the feed was scrolled).
  // (Chrome's scroll anchoring is switched off while pinned, or it would move us off the bottom first.)
  const wrap = $('.feed-wrap', main);
  wrap.addEventListener('scroll', () => {
    // Content that grows under us (images loading one after another) also fires scroll events.
    // Only stop following the newest message when the reader actually moved up.
    if (pinned && wrap.scrollTop >= pinnedTop - 1) { pinnedTop = wrap.scrollTop; return; }
    setPinned(wrap);
  }, { passive: true });
  new ResizeObserver(() => { if (pinned && app.conv && S.sortOrder !== 'desc') stickBottom(wrap); }).observe($('#feed'));
  $('#feed').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.classList.contains('md-spoiler')) e.target.classList.toggle('revealed');
  });
}

// ---------------- filters ----------------
function category(m, c) {
  const b = messageBody(m);
  switch (c) {
    case 'mine': return m.author && app.me && m.author.id === app.me.id;
    case 'attachments': return b.attachments.length > 0;
    case 'images': return b.attachments.some((a) => attachmentKind(a) === 'image') || b.embeds.some((e) => e.type === 'image' || e.type === 'gifv' || e.image);
    case 'videos': return b.attachments.some((a) => attachmentKind(a) === 'video') || b.embeds.some((e) => e.video);
    case 'links': return /https?:\/\/\S/.test(b.content);
    case 'embeds': return b.embeds.length > 0;
    case 'reactions': return !!(m.reactions && m.reactions.length);
    case 'pinned': return !!m.pinned;
    case 'edited': return !!m.edited_timestamp;
    case 'replies': return m.type === 19;
    case 'forwarded': return !!(m.message_snapshots && m.message_snapshots.length);
    case 'stickers': return b.stickers.length > 0;
    case 'polls': return !!m.poll;
    case 'threads': return !!m.thread || m.type === 18;
    case 'system': return isSystem(m);
    case 'calls': return m.type === 3;
    case 'pins': return m.type === 6;
    case 'deleted': return !!m._deleted;
    default: return true;
  }
}

function buildMatcher(f) {
  let re = null;
  if (f.text && f.regex) { try { re = new RegExp(f.text, 'i'); } catch { re = /$^/; } }
  const text = (f.text || '').toLowerCase();
  const author = (f.author || '').toLowerCase();
  const att = (f.attachment || '').toLowerCase();
  const after = parseDateInput(f.after);
  const before = parseDateInput(f.before, true);
  const active = !!(f.text || f.author || f.attachment || after || before || f.categories.length || f.channel);
  const test = (m) => {
    const b = messageBody(m);
    if (f.text) {
      const hay = b.content + ' ' + b.embeds.map((e) => `${e.title || ''} ${e.description || ''}`).join(' ');
      if (re ? !re.test(hay) : !hay.toLowerCase().includes(text)) return false;
    }
    if (author) {
      const a = m.author || {};
      if (a.id !== f.author && !`${a.username || ''} ${a.global_name || ''}`.toLowerCase().includes(author)) return false;
    }
    if (att && !b.attachments.some((x) => (x.filename || '').toLowerCase().includes(att))) return false;
    const t = m.timestamp ? new Date(m.timestamp) : null;
    if (after && t && t < after) return false;
    if (before && t && t > before) return false;
    if (f.channel && m.channel_id !== f.channel) return false;
    for (const c of f.categories) if (!category(m, c)) return false;
    return true;
  };
  return { active, test: (m) => (active ? (f.inverse ? !test(m) : test(m)) : true) };
}

export function filtersActive() {
  const f = app.filters;
  return !!(f.text || f.author || f.attachment || f.after || f.before || f.categories.length || f.channel || f.inverse);
}

export function resetFilters(redraw = true) {
  app.filters = { text: '', regex: false, author: '', attachment: '', after: '', before: '', categories: [], inverse: false, channel: '' };
  drawFilterBar();
  if (redraw) refresh();
}

function computeView() {
  const { test } = buildMatcher(app.filters);
  app.view = app.messages.filter((m) => (!S.hideSystem || !isSystem(m) || app.filters.categories.includes('system')) && test(m));
}

// ---------------- render ----------------
// Where the next render() leaves the feed: 'top', 'bottom', or null to keep the reader's place
// (selection changes, member names arriving, edits, deletions, "Load older", background loading).
let pendingScroll = 'bottom';
let keepAnchors = null;
let pinned = true;
let pinnedTop = 0;
function setPinned(wrap) {
  pinned = wrap.scrollHeight - wrap.scrollTop - wrap.clientHeight < 4;
  if (pinned) pinnedTop = wrap.scrollTop;
  wrap.style.overflowAnchor = pinned ? 'none' : '';
}
function stickBottom(wrap) {
  wrap.scrollTop = wrap.scrollHeight;
  pinnedTop = wrap.scrollTop;
}

// Messages currently on screen (top to bottom) with their offset from the top of the feed viewport.
function visibleAnchors() {
  const wrap = $('#feed') && $('#feed').parentElement;
  if (!wrap) return [];
  const box = wrap.getBoundingClientRect();
  const out = [];
  for (const el of $$('#feed .msg')) {
    const r = el.getBoundingClientRect();
    if (r.bottom <= box.top) continue;
    if (r.top >= box.bottom || out.length >= 30) break;
    out.push({ id: el.dataset.id, offset: r.top - box.top });
  }
  return out;
}

export function refresh({ keepPage = false } = {}) {
  const anchors = keepPage && app.page >= 0 ? visibleAnchors() : [];
  computeView();
  const pages = pageCount();
  if (!anchors.length) {
    // A new conversation or filter, or nothing was on screen yet (first load): start at the newest end.
    app.page = S.sortOrder === 'desc' ? 0 : pages - 1;
    pendingScroll = S.sortOrder === 'desc' ? 'top' : 'bottom';
  } else {
    // Older messages may have been added (or some deleted) before the ones on screen, which shifts
    // page boundaries: stay on the page that holds what the reader was looking at.
    for (const a of anchors) {
      const idx = indexInList(a.id);
      if (idx >= 0) { app.page = Math.floor(idx / Math.max(10, S.pageSize)); break; }
    }
  }
  app.page = Math.max(0, Math.min(app.page, pages - 1));
  keepAnchors = anchors;
  render();
}

function pageCount() {
  return Math.max(1, Math.ceil(app.view.length / Math.max(10, S.pageSize)));
}

export function setBusy(b) {
  const f = $('#feed');
  if (f) f.classList.toggle('busy', b);
  const btn = $('#load-older');
  if (btn) { btn.disabled = b; btn.textContent = b ? 'Loading…' : btn.dataset.label; }
}

function makeCtx(list) {
  const gid = app.conv && app.conv.guildId;
  const members = new Map();
  if (gid) {
    for (const m of list) {
      for (const id of [m.author && m.author.id, ...(m.mentions || []).map((u) => u.id)]) {
        if (!id) continue;
        const mem = app.members.get(`${gid}:${id}`);
        if (mem) members.set(id, mem);
      }
    }
  }
  return makeContext({
    mode: 'app', settings: S, meId: app.me && app.me.id, guildId: gid,
    roles: (gid && app.roles.get(gid)) || new Map(), members, channels: app.channelNames(),
    selected: app.selected,
    showChannel: !!(app.conv && app.conv.kind === 'search' && app.conv.guildId),
  });
}

function ensureMembers(list) {
  const conv = app.conv;
  const gid = conv && conv.guildId;
  if (!gid || !S.lookupMembers || conv.kind === 'package' || !app.me) return;
  const ids = [...new Set(list.map((m) => m.author && m.author.id).filter(Boolean))].filter((id) => !app.members.has(`${gid}:${id}`));
  if (!ids.length) return;
  app.getMembers(gid, ids).then(() => { if (app.conv && app.conv.key === conv.key) render(); }).catch(() => {});
}

export function render() {
  drawHeader();
  drawSelectionBar();
  const feed = $('#feed');
  if (!feed) return;
  const conv = app.conv;
  const wrap = feed.parentElement;
  const mode = pendingScroll;
  const anchors = mode ? null : (keepAnchors || visibleAnchors());
  const overflowing = wrap.scrollHeight > wrap.clientHeight + 2;
  const stick = S.sortOrder === 'desc' ? wrap.scrollTop < 4 : overflowing && wrap.scrollHeight - wrap.scrollTop - wrap.clientHeight < 4;
  const prevTop = wrap.scrollTop;
  pendingScroll = null;
  keepAnchors = null;
  if (!conv) { fill(feed, welcome()); $('#pager').replaceChildren(); pendingScroll = 'bottom'; return; }
  const size = Math.max(10, S.pageSize);
  const list = S.sortOrder === 'desc' ? [...app.view].reverse() : app.view;
  const start = app.page * size;
  const slice = list.slice(start, start + size);
  ensureMembers(slice);
  const ctx = makeCtx(slice);
  let html = '';
  let prev = null;
  for (const m of slice) {
    html += renderMessage(m, ctx, { grouped: S.sortOrder !== 'desc' && shouldGroup(prev, m) });
    prev = m;
  }
  const canOlder = (conv.kind === 'channel' || conv.kind === 'search') && !conv.complete && !(conv.doneChannels && conv.doneChannels[conv.channelId]);
  const atOldEdge = S.sortOrder === 'desc' ? app.page === pageCount() - 1 : app.page === 0;
  const olderBtn = canOlder && atOldEdge
    ? `<div class="load-more"><button class="btn sm" id="load-older" data-label="${conv.kind === 'search' ? 'Load more results' : 'Load older messages'}">${conv.kind === 'search' ? 'Load more results' : 'Load older messages'}</button> <button class="btn sm ghost" id="load-all-inline">Load everything</button></div>`
    : (conv.kind === 'channel' && atOldEdge && app.messages.length ? '<div class="load-more muted">Beginning of the conversation</div>' : '');
  let empty = '';
  if (!slice.length) {
    empty = app.messages.length
      ? `<div class="empty">No messages match your filters. <button class="link-btn" id="reset-filters">Reset filters</button></div>`
      : `<div class="empty">${conv.kind === 'search' && conv.complete ? 'No results.' : conv.complete || (conv.doneChannels && conv.doneChannels[conv.channelId]) ? 'No messages here.' : 'No messages loaded yet.'}</div>`;
  }
  feed.innerHTML = S.sortOrder === 'desc' ? html + empty + olderBtn : olderBtn + empty + html;
  const lo = $('#load-older', feed);
  if (lo) lo.addEventListener('click', () => app.loadOlder());
  const la = $('#load-all-inline', feed);
  if (la) la.addEventListener('click', () => loadAll());
  const rf = $('#reset-filters', feed);
  if (rf) rf.addEventListener('click', () => resetFilters());
  drawPager();
  if (mode === 'bottom' || (!mode && stick && S.sortOrder !== 'desc')) stickBottom(wrap);
  else if (mode === 'top' || (!mode && stick)) wrap.scrollTop = 0;
  else {
    const box = wrap.getBoundingClientRect();
    const a = (anchors || []).find((x) => document.getElementById(`m-${x.id}`));
    if (a) wrap.scrollTop += document.getElementById(`m-${a.id}`).getBoundingClientRect().top - box.top - a.offset;
    else wrap.scrollTop = prevTop;
  }
  setPinned(wrap);
}

function welcome() {
  return h('div', { class: 'welcome' },
    h('h1', null, 'Cleancord'),
    h('p', { class: 'muted' }, 'Search, export, edit and purge your Discord messages. Everything runs in this browser; nothing is sent anywhere except Discord itself.'),
    h('div', { class: 'welcome-grid' },
      card('💬', 'Open a conversation', 'Pick a DM or a server channel on the left. Loaded messages are saved in your workspace.'),
      card('🔍', 'Search', 'Use Discord’s search by content, author, mentions, attachments, dates and more.', () => dialogs.showSearch(app.sidebar.guildId !== '@me' ? { guildId: app.sidebar.guildId } : {})),
      card('🗑', 'Purge', 'Delete your messages, attachments or reactions in DMs, channels or whole servers.', () => dialogs.showPurge({})),
      card('⇩', 'Export', 'Save to HTML, JSON, CSV or text, with images, videos and files for offline viewing.', () => dialogs.showExport({})),
      card('📦', 'Data package', 'Browse the ZIP Discord gives you and clean up every message you ever sent.', () => { app.sidebar.tab = 'package'; import('./sidebar.js').then((s) => s.render()); }),
    ),
    !app.me ? h('div', { class: 'form-note warn' }, 'Not connected yet. ', h('button', { class: 'link-btn', onclick: () => dialogs.showAccount() }, 'How to connect')) : null);
}
function card(icon, title, text, onclick) {
  return h(onclick ? 'button' : 'div', { class: 'wcard', onclick }, h('div', { class: 'wcard-icon' }, icon), h('div', { class: 'wcard-title' }, title), h('div', { class: 'muted small' }, text));
}

function drawHeader() {
  const head = $('#conv-head');
  if (!head) return;
  const conv = app.conv;
  if (!conv) { fill(head, h('div', { class: 'conv-title' }, h('span', { class: 'muted' }, 'No conversation open'))); return; }
  const loaded = app.messages.length;
  const meta = [
    `${fmtNum(loaded)} loaded`,
    conv.kind === 'search' && conv.total != null ? `${fmtNum(conv.total)} results on Discord` : '',
    conv.complete || (conv.doneChannels && conv.doneChannels[conv.channelId]) ? 'complete' : '',
    app.view.length !== loaded ? `${fmtNum(app.view.length)} shown` : '',
  ].filter(Boolean).join(' · ');
  const btn = (label, title, onclick, cls = '') => h('button', { class: `btn sm ${cls}`, title, onclick }, label);
  const actions = [];
  if (conv.kind === 'channel') {
    actions.push(btn('↻', 'Load newer messages', () => app.loadNewer()));
    actions.push(btn('⇣ Load all', 'Load the whole history (resumable)', () => loadAll()));
    actions.push(btn('🔍 Search', 'Search with Discord', () => dialogs.showSearch({ guildId: conv.guildId, channelId: conv.channelId })));
  } else if (conv.kind === 'search') {
    actions.push(btn('⇣ Load all results', 'Load every result (resumable)', () => loadAll()));
    actions.push(btn('🔍 Edit search', 'Change the search', () => dialogs.showSearch({ ...(conv.scope || {}), criteria: conv.criteria, channelIds: conv.channelIds })));
  } else if (conv.kind === 'package') {
    actions.push(btn('⤓ Fetch details', 'Look up reactions, edits and replies on Discord for these messages', () => {
      if (taskRunning('pkgFetch')) return;
      app.startJob(new Job({ type: 'pkgFetch', title: `Fetch details: ${conv.title}`, params: { convKey: conv.key }, resumable: true, ws: app.ws }));
    }));
  }
  actions.push(btn(`⚲ Filter${filtersActive() ? ' •' : ''}`, 'Filter loaded messages', () => toggleFilterBar(), filtersActive() ? 'on' : ''));
  actions.push(btn('⇩ Export', 'Export', () => dialogs.showExport({ current: true })));
  if (conv.kind === 'package') actions.push(btn('🗑 Delete on Discord', 'Delete these messages on Discord', () => deleteMessages(app.view.filter((m) => !m._deleted && !m._noAccess), 'all shown messages'), 'danger'));
  else actions.push(btn('🗑 Purge', 'Purge messages', () => dialogs.showPurge({ fromConv: true }), 'danger'));
  actions.push(h('button', { class: 'btn sm', title: 'More', onclick: (e) => menu(e.currentTarget, [
    { label: 'Jump to message (link or ID)…', onClick: () => dialogs.showJump() },
    { label: 'Load a thread or forum post by ID…', onClick: () => dialogs.showLoadThread() },
    { label: 'Mention analytics…', onClick: () => dialogs.showAnalytics() },
    conv.channelId ? { label: 'Open in Discord', onClick: () => window.open(`https://discord.com/channels/${conv.guildId || '@me'}/${conv.channelId}`, '_blank', 'noopener') } : null,
    conv.channelId ? { label: 'Copy channel ID', onClick: () => copyText(conv.channelId).then(() => toast('Copied')) } : null,
    { label: S.sortOrder === 'desc' ? 'Show oldest first' : 'Show newest first', onClick: () => saveSettings({ sortOrder: S.sortOrder === 'desc' ? 'asc' : 'desc' }).then(() => refresh()) },
    { label: S.hideSystem ? 'Show system messages' : 'Hide system messages', onClick: () => saveSettings({ hideSystem: !S.hideSystem }).then(() => refresh({ keepPage: true })) },
    '-',
    { label: 'Remove local copy from workspace', danger: true, onClick: () => app.removeConversation(conv.key) },
  ]) }, '⋯'));
  fill(head, 
    h('div', { class: 'conv-title' }, h('div', { class: 'conv-name', title: conv.title }, conv.title), h('div', { class: 'muted small' }, [conv.subtitle, meta].filter(Boolean).join(' · '))),
    h('div', { class: 'conv-actions' }, actions),
  );
}

// A double-click (or another click while it runs) must not queue the same task twice.
function taskRunning(type) {
  const key = app.conv && app.conv.key;
  const jobs = app.jobs ? [app.jobs.current, ...app.jobs.queue.map((q) => q.job)] : [];
  const busy = jobs.some((j) => j && j.type === type && !j.cancelled && j.params && j.params.convKey === key);
  if (busy) toast('Already running for this conversation (see Tasks)');
  return busy;
}
function loadAll() {
  if (!taskRunning('loadAll')) app.loadAll();
}

function toggleFilterBar() {
  const bar = $('#filterbar');
  bar.hidden = !bar.hidden;
  if (!bar.hidden) drawFilterBar();
}

function drawFilterBar() {
  const bar = $('#filterbar');
  if (!bar) return;
  const f = app.filters;
  const apply = debounce(() => { refresh(); drawHeader(); }, 200);
  const input = (key, placeholder, type = 'text') => {
    const el = h('input', { class: 'input sm', placeholder, type, value: f[key] || '' });
    el.addEventListener('input', () => { f[key] = el.value; apply(); });
    return el;
  };
  const chips = CATEGORIES.map(([k, label]) => {
    const on = f.categories.includes(k);
    return h('button', { class: `chip-btn${on ? ' on' : ''}`, onclick: (e) => {
      f.categories = on ? f.categories.filter((x) => x !== k) : [...f.categories, k];
      e.currentTarget.classList.toggle('on');
      drawFilterBar();
      refresh();
    } }, label);
  });
  const chanIds = app.conv && app.conv.kind === 'search' ? [...new Set(app.messages.map((m) => m.channel_id))] : [];
  fill(bar, 
    h('div', { class: 'filter-row' },
      input('text', 'Message contains…'),
      h('label', { class: 'check sm' }, h('input', { type: 'checkbox', checked: f.regex, onchange: (e) => { f.regex = e.target.checked; apply(); } }), 'regex'),
      input('author', 'Author name or ID'),
      input('attachment', 'Attachment name'),
      h('span', { class: 'muted small' }, 'From'), input('after', '', 'date'),
      h('span', { class: 'muted small' }, 'to'), input('before', '', 'date'),
      chanIds.length > 1 ? h('select', { class: 'input sm', onchange: (e) => { f.channel = e.target.value; refresh(); } },
        h('option', { value: '' }, 'All channels'), chanIds.map((id) => h('option', { value: id, selected: f.channel === id }, `#${app.channelName(id)}`))) : null,
      h('label', { class: 'check sm', title: 'Show messages that do NOT match' }, h('input', { type: 'checkbox', checked: f.inverse, onchange: (e) => { f.inverse = e.target.checked; refresh(); } }), 'inverse'),
      h('button', { class: 'link-btn', onclick: () => resetFilters() }, 'Reset')),
    h('div', { class: 'filter-row chips' }, chips),
  );
}

function drawSelectionBar() {
  const bar = $('#selbar');
  if (!bar) return;
  const n = app.selected.size;
  const conv = app.conv;
  if (!conv) { bar.hidden = true; return; }
  bar.hidden = false;
  const sel = () => app.messages.filter((m) => app.selected.has(m.id));
  fill(bar, 
    h('span', { class: 'sel-count' }, n ? `${fmtNum(n)} selected` : 'Select messages to act on them'),
    h('button', { class: 'link-btn', onclick: () => { for (const m of app.view) app.selected.add(m.id); render(); } }, `Select all shown (${fmtNum(app.view.length)})`),
    h('button', { class: 'link-btn', onclick: () => { const size = Math.max(10, S.pageSize); const list = S.sortOrder === 'desc' ? [...app.view].reverse() : app.view; for (const m of list.slice(app.page * size, app.page * size + size)) app.selected.add(m.id); render(); } }, 'Select page'),
    n ? h('button', { class: 'link-btn', onclick: () => { app.selected.clear(); render(); } }, 'Clear') : null,
    h('span', { class: 'spacer' }),
    n ? h('button', { class: 'btn sm danger', onclick: () => deleteMessages(sel(), `${n} selected message(s)`) }, '🗑 Delete') : null,
    n ? h('button', { class: 'btn sm', onclick: () => dialogs.showBulkEdit(sel()) }, '✎ Edit') : null,
    n ? h('button', { class: 'btn sm', onclick: () => dialogs.showBulkAttachments(sel()) }, '📎 Remove attachments') : null,
    n ? h('button', { class: 'btn sm', onclick: () => dialogs.showBulkReactions(sel()) }, '☺ Remove reactions') : null,
    n ? h('button', { class: 'btn sm', onclick: () => dialogs.showExport({ selection: true }) }, '⇩ Export') : null,
  );
}

function drawPager() {
  const p = $('#pager');
  if (!p) return;
  const pages = pageCount();
  if (!app.conv) { p.replaceChildren(); return; }
  // Paging forward continues at the top of the next page, paging back at the bottom of the previous
  // one; « opens the first page at its start and » the last page at its end.
  const go = (i, where) => {
    const next = Math.max(0, Math.min(pages - 1, i));
    if (next === app.page) return;
    pendingScroll = where || (next > app.page ? 'top' : 'bottom');
    app.page = next;
    render();
  };
  const pageInput = h('input', { class: 'input sm page-input', type: 'number', min: 1, max: pages, value: app.page + 1 });
  pageInput.addEventListener('change', () => { if (pageInput.value !== '') go(Number(pageInput.value) - 1); pageInput.value = app.page + 1; });
  fill(p, 
    h('button', { class: 'btn sm ghost', title: 'First page', disabled: app.page === 0, onclick: () => go(0, 'top') }, '«'),
    h('button', { class: 'btn sm ghost', title: 'Previous page', disabled: app.page === 0, onclick: () => go(app.page - 1, 'bottom') }, '‹'),
    h('span', null, 'Page ', pageInput, ` of ${fmtNum(pages)}`),
    h('button', { class: 'btn sm ghost', title: 'Next page', disabled: app.page >= pages - 1, onclick: () => go(app.page + 1, 'top') }, '›'),
    h('button', { class: 'btn sm ghost', title: 'Last page', disabled: app.page >= pages - 1, onclick: () => go(pages - 1, 'bottom') }, '»'),
    h('span', { class: 'muted small' }, S.sortOrder === 'desc' ? 'newest first' : 'oldest first'),
    h('select', { class: 'input sm', title: 'Messages per page', onchange: (e) => saveSettings({ pageSize: Number(e.target.value) }).then(() => refresh()) },
      [50, 100, 200, 500].map((n) => h('option', { value: n, selected: S.pageSize === n }, `${n} / page`))),
  );
}

// ---------------- interactions ----------------
export async function jumpTo(id) {
  if (!id) return;
  let idx = indexInList(id);
  if (idx < 0 && app.messages.some((m) => m.id === id)) {
    toast('That message is hidden by your filters; resetting them.');
    resetFilters(false);
    computeView();
    idx = indexInList(id);
  }
  const conv = app.conv;
  if (idx < 0 && conv && conv.kind === 'channel') {
    try {
      const around = await app.api.messages(conv.channelId, { around: id, limit: 50 });
      if (around && around.length) {
        await app.ws.putMessages(conv.key, around);
        if (!app.conv || app.conv.key !== conv.key) return; // the user opened something else meanwhile
        app.mergeMessages(around);
        computeView();
        idx = indexInList(id);
      }
    } catch (e) { app.handleError(e); return; }
  }
  if (idx < 0) { toast('Message not found in this conversation', 'error'); return; }
  app.page = Math.floor(idx / Math.max(10, S.pageSize));
  pendingScroll = null;
  render();
  const el = document.getElementById(`m-${id}`);
  if (el) {
    el.scrollIntoView({ block: 'center' });
    el.classList.add('flash');
    setTimeout(() => el.classList.remove('flash'), 2000);
  }
}
function indexInList(id) {
  const list = S.sortOrder === 'desc' ? [...app.view].reverse() : app.view;
  return list.findIndex((m) => m.id === id);
}

function findMessage(id) {
  return app.messages.find((m) => m.id === id);
}

let lastDelete = { key: '', at: 0 };
async function deleteMessages(list, label) {
  if (!list.length) return toast('Nothing to delete');
  const key = list.map((m) => m.id).join(',');
  const mine = list.filter((m) => m.author && app.me && m.author.id === app.me.id).length;
  if (S.confirmDestructive) {
    const ok = await confirmDialog({
      title: `Delete ${fmtNum(list.length)} message(s)?`,
      message: `${label}\n${mine < list.length ? `${fmtNum(list.length - mine)} of them were sent by other people; that only works where you have the Manage Messages permission (never in DMs).\n` : ''}\nThis deletes them on Discord and cannot be undone.`,
      confirmLabel: 'Delete', danger: true,
    });
    if (!ok) return;
  }
  if (key === lastDelete.key && Date.now() - lastDelete.at < 1500) return; // second click of a double-click
  lastDelete = { key, at: Date.now() };
  app.startJob(new Job({ type: 'bulk', title: `Delete ${fmtNum(list.length)} message(s)`, params: { action: 'delete', items: list.map(slimForBulk) }, resumable: true, ws: app.ws }));
}

function onFeedClick(e) {
  const t = e.target;
  const sel = t.closest('[data-select]');
  if (sel) {
    const id = sel.dataset.select;
    const list = S.sortOrder === 'desc' ? [...app.view].reverse() : app.view;
    if (e.shiftKey && lastClicked) {
      const a = list.findIndex((m) => m.id === lastClicked);
      const b = list.findIndex((m) => m.id === id);
      if (a >= 0 && b >= 0) {
        const on = sel.checked;
        for (const m of list.slice(Math.min(a, b), Math.max(a, b) + 1)) on ? app.selected.add(m.id) : app.selected.delete(m.id);
        lastClicked = id;
        render();
        return;
      }
    }
    sel.checked ? app.selected.add(id) : app.selected.delete(id);
    sel.closest('.msg').classList.toggle('selected', sel.checked);
    lastClicked = id;
    drawSelectionBar();
    return;
  }
  const spoiler = t.closest('.md-spoiler, .att-spoiler');
  if (spoiler && !spoiler.classList.contains('revealed')) { e.preventDefault(); spoiler.classList.add('revealed'); return; }
  const jump = t.closest('[data-jump]');
  if (jump) { e.preventDefault(); jumpTo(jump.dataset.jump); return; }
  const lb = t.closest('[data-lightbox]');
  if (lb) { e.preventDefault(); dialogs.showImage(lb.dataset.lightbox, lb.getAttribute('href')); return; }
  const react = t.closest('[data-reactions]');
  if (react) { const m = findMessage(react.dataset.reactions); if (m) dialogs.showReactions(m); return; }
  const thread = t.closest('[data-thread]');
  if (thread) { app.openChannel(thread.dataset.thread); return; }
  const act = t.closest('[data-act]');
  if (act) {
    const m = findMessage(act.dataset.id);
    if (!m) return;
    const link = messageLink(m, app.conv && app.conv.guildId);
    switch (act.dataset.act) {
      case 'copylink': copyText(link).then(() => toast('Link copied')); break;
      case 'copyid': copyText(m.id).then(() => toast('ID copied')); break;
      case 'open': window.open(link, '_blank', 'noopener'); break;
      case 'edit': dialogs.showBulkEdit([m], true); break;
      case 'rmatt': dialogs.showBulkAttachments([m]); break;
      case 'reactions': dialogs.showReactions(m); break;
      case 'delete': deleteMessages([m], 'This message'); break;
      default: break;
    }
  }
}

export { esc, cmpId };
