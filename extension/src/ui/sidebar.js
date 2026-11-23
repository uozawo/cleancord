// Left sidebar: servers & DMs, saved conversations, data package browser, and tasks.

import { app } from '../state.js';
import {
  h, $, $$, esc, avatarUrl, guildIconUrl, guildInitials, channelIcon, dmName, humanBytes, fmtNum, copyText,
  CHANNEL, isThread, fill,
} from '../util.js';
import { canHaveThreads, isMessageable } from '../discord.js';
import { DataPackage } from '../package/datapkg.js';
import { toast, menu, confirmDialog } from './dom.js';
import * as dialogs from './dialogs.js';
import { Job } from '../jobs.js';
import { slimForBulk } from '../bulk.js';

const ui = { collapsed: new Set(), expanded: new Set(), loadingThreads: new Set(), pkgCollapsed: new Set(), pkgProgress: null };

export function mount() {
  const sb = $('#sidebar');
  fill(sb, 
    h('nav', { class: 'tabs', id: 'side-tabs' },
      ...[['chats', 'Chats'], ['saved', 'Saved'], ['package', 'Data package'], ['jobs', 'Tasks']].map(([k, label]) =>
        h('button', { class: 'tab', dataset: { tab: k }, onclick: () => { if (app.sidebar.tab !== k) app.sidebar.filter = ''; app.sidebar.tab = k; render(); } }, label))),
    h('div', { class: 'side-body', id: 'side-body' }),
  );
}

// Re-rendering rebuilds the list, so remember where each list was scrolled (per tab and per server)
// and put it back afterwards. Otherwise expanding threads, collapsing a category, ticking boxes or a
// background reconnect would jump the list back to the top.
const scrollMem = new Map();
let railTop = 0;
const scrollKey = () => `${app.sidebar.tab}:${app.sidebar.tab === 'chats' ? app.sidebar.guildId : ''}`;
// The conversation / server that was last brought into view. When another one becomes active by other
// means than a click in the list (a link, jump, launcher, Saved tab…), scroll its row into view once.
let shownConv = null;
let shownGuild = null;

function revealIn(scroller, el) {
  const box = scroller.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  if (r.top >= box.top && r.bottom <= box.bottom) return;
  scroller.scrollTop += r.top - box.top - (box.height - r.height) / 2;
}

function applyFilter() {
  const q = (app.sidebar.filter || '').toLowerCase();
  if (!q) return;
  for (const r of $$('#side-body .side-list [data-name]')) r.hidden = !r.dataset.name.toLowerCase().includes(q);
}

function restoreScroll() {
  const rail = $('#side-body .rail');
  if (rail) {
    rail.scrollTop = railTop;
    const on = $('.rail-item.active', rail);
    if (on && shownGuild !== app.sidebar.guildId) revealIn(rail, on);
    shownGuild = app.sidebar.guildId;
    railTop = rail.scrollTop;
    rail.addEventListener('scroll', () => { railTop = rail.scrollTop; }, { passive: true });
  }
  const list = $('#side-body .side-list');
  if (list) {
    const key = scrollKey();
    applyFilter();
    list.scrollTop = scrollMem.get(key) || 0;
    list.dataset.scrollKey = key;
    list.addEventListener('scroll', () => scrollMem.set(key, list.scrollTop), { passive: true });
  }
}

// Read the positions straight from the lists about to be replaced (a scroll event may still be pending).
function saveScroll() {
  const rail = $('#side-body .rail');
  if (rail) railTop = rail.scrollTop;
  const list = $('#side-body .side-list');
  if (list && list.dataset.scrollKey) scrollMem.set(list.dataset.scrollKey, list.scrollTop);
}

export function render() {
  for (const t of $$('#side-tabs .tab')) t.classList.toggle('active', t.dataset.tab === app.sidebar.tab);
  const body = $('#side-body');
  if (!body) return;
  // A re-render (threads loaded, DM list refreshed…) must not steal the focus from the filter box.
  const fa = document.activeElement;
  const typing = fa && fa.matches('#side-body .side-filter input') ? [fa.selectionStart, fa.selectionEnd] : null;
  const refocus = () => {
    const inp = typing && $('#side-body .side-filter input');
    if (inp && document.activeElement !== inp && (!document.activeElement || document.activeElement === document.body)) {
      inp.focus();
      try { inp.setSelectionRange(...typing); } catch { /* not supported */ }
    }
  };
  saveScroll();
  let pending;
  switch (app.sidebar.tab) {
    case 'saved': pending = renderSaved(body); break;
    case 'package': renderPackage(body); break;
    case 'jobs': pending = renderJobs(body); break;
    default: renderChats(body);
  }
  if (pending) pending.then(() => { restoreScroll(); highlight(); refocus(); });
  else { restoreScroll(); highlight(); refocus(); }
}

export function highlight() {
  const id = app.conv && app.conv.channelId;
  const key = app.conv && app.conv.key;
  let active = null;
  for (const r of $$('#side-body [data-open]')) {
    const on = r.dataset.open === id || r.dataset.open === key;
    r.classList.toggle('active', on);
    if (on && !active && !r.hidden) active = r;
  }
  if (!key) { shownConv = null; return; }
  const list = active && active.closest('.side-list');
  if (!list || shownConv === key) return;
  shownConv = key;
  revealIn(list, active);
}

let jobsSig = '';
const jobsSignature = () => {
  const j = app.jobs;
  return [j.current ? `${j.current.id}:${j.current.status}` : '', j.queue.map((q) => q.job.id).join(','), j.history.length, j.history[0] && j.history[0].status].join('|');
};
const currentJobLabel = (j) => `${j.status}${j.paused && j.pauseReason ? `: ${j.pauseReason}` : ''} · ${j.progress.label || ''}`;

export function renderJobsIfVisible() {
  if (app.sidebar.tab !== 'jobs') return;
  // Progress ticks only update the label: rebuilding the list on every tick swallowed clicks.
  const label = $('#side-body .task.current .muted');
  if (label && jobsSignature() === jobsSig) { label.textContent = currentJobLabel(app.jobs.current); return; }
  render();
}

// ---------------- chats ----------------
export async function selectGuild(gid) {
  // Clicking the current server again (or following a link into it) keeps the ticks and the filter.
  if (gid !== app.sidebar.guildId) app.sidebar.checked.clear();
  if (gid !== app.sidebar.guildId || app.sidebar.tab !== 'chats') app.sidebar.filter = '';
  app.sidebar.guildId = gid;
  app.sidebar.tab = 'chats';
  render();
  if (gid !== '@me') {
    try { await app.loadGuildChannels(gid); } catch (e) { app.handleError(e); }
    render();
  }
}

export async function expandThreads(ch) {
  if (ui.expanded.has(ch.id) && app.threadsByParent.has(ch.id)) { ui.expanded.delete(ch.id); render(); return; }
  ui.expanded.add(ch.id);
  if (!app.threadsByParent.has(ch.id)) {
    ui.loadingThreads.add(ch.id);
    render();
    try { await app.loadThreads(ch); } catch (e) { app.handleError(e); }
    ui.loadingThreads.delete(ch.id);
  }
  render();
}

function renderChats(body) {
  const gid = app.sidebar.guildId;
  const rail = h('div', { class: 'rail' },
    h('button', { class: 'rail-item' + (gid === '@me' ? ' active' : ''), title: 'Direct messages', onclick: () => selectGuild('@me') }, h('span', { class: 'rail-dm' }, '✉')),
    h('div', { class: 'rail-sep' }),
    ...app.guilds.map((g) => {
      const icon = guildIconUrl(g, 64);
      return h('button', { class: 'rail-item' + (gid === g.id ? ' active' : ''), title: g.name, onclick: () => selectGuild(g.id) },
        icon ? h('img', { src: icon, alt: '', loading: 'lazy' }) : h('span', { class: 'rail-initials' }, guildInitials(g.name)));
    }));
  const panel = h('div', { class: 'side-panel' });
  if (!app.me) {
    panel.append(h('div', { class: 'empty-side' }, h('p', null, 'Not connected to Discord.'), h('button', { class: 'btn primary sm', onclick: () => dialogs.showAccount() }, 'How to connect')));
  } else if (gid === '@me') {
    renderDmPanel(panel);
  } else {
    renderGuildPanel(panel, gid);
  }
  fill(body, h('div', { class: 'chats' }, rail, panel));
}

function filterBox(placeholder) {
  const input = h('input', { class: 'input sm', placeholder, value: app.sidebar.filter, type: 'search' });
  input.addEventListener('input', () => {
    app.sidebar.filter = input.value;
    const q = input.value.toLowerCase();
    for (const r of $$('#side-body .side-list [data-name]')) r.hidden = q && !r.dataset.name.toLowerCase().includes(q);
  });
  return input;
}

function checkbox(id) {
  return h('input', {
    type: 'checkbox', class: 'row-check', checked: app.sidebar.checked.has(id), title: 'Select for export / purge',
    onclick: (e) => e.stopPropagation(),
    onchange: (e) => { e.target.checked ? app.sidebar.checked.add(id) : app.sidebar.checked.delete(id); renderSelectionFooter(); },
  });
}

function renderSelectionFooter() {
  const foot = $('#side-foot');
  if (!foot) return;
  const n = app.sidebar.checked.size;
  foot.hidden = !n;
  if (!n) return;
  fill(foot, 
    h('span', null, `${n} selected`),
    h('button', { class: 'btn sm', onclick: () => dialogs.showExport({ targets: checkedTargets() }) }, 'Export'),
    h('button', { class: 'btn sm danger', onclick: () => dialogs.showPurge({ targets: checkedTargets() }) }, 'Purge'),
    h('button', { class: 'link-btn', onclick: () => { app.sidebar.checked.clear(); render(); } }, 'Clear'),
  );
}

function checkedTargets() {
  const out = [];
  for (const id of app.sidebar.checked) {
    const c = app.channels.get(id);
    if (!c) continue;
    if (c.type === CHANNEL.DM || c.type === CHANNEL.GROUP_DM) out.push({ type: 'dm', id: c.id, name: c.name || dmName(c, app.me.id), channelType: c.type });
    else out.push({ type: 'channel', id: c.id, guildId: c.guild_id, name: `#${c.name}`, channelType: c.type, guildName: app.guildName(c.guild_id) });
  }
  return out;
}

function renderDmPanel(panel) {
  const head = h('div', { class: 'side-head' },
    h('div', { class: 'side-title' }, 'Direct messages'),
    h('div', { class: 'side-actions' },
      h('button', { class: 'icon-btn', title: 'Export all DMs', onclick: () => dialogs.showExport({ targets: app.dms.map((c) => ({ type: 'dm', id: c.id, name: c.name || dmName(c, app.me.id), channelType: c.type })) }) }, '⇩'),
      h('button', { class: 'icon-btn', title: 'More', onclick: (e) => menu(e.currentTarget, [
        { label: 'Open DM with a user ID…', onClick: () => dialogs.showOpenDm() },
        { label: 'Friends & blocked users…', onClick: () => dialogs.showFriends() },
        { label: 'Select all DMs', onClick: () => { for (const c of app.dms) app.sidebar.checked.add(c.id); render(); } },
        { label: 'Copy DM list (names + IDs)', onClick: () => copyText(app.dms.map((c) => `${c.name || dmName(c, app.me.id)}\t${c.id}`).join('\n')).then(() => toast('Copied')) },
        '-',
        { label: 'Refresh DM list', onClick: () => app.refreshDms().catch(app.handleError) },
      ]) }, '⋯')),
  );
  const list = h('div', { class: 'side-list' });
  for (const c of app.dms) {
    const name = c.name || dmName(c, app.me.id);
    const other = (c.recipients || []).find((u) => u.id !== app.me.id) || (c.recipients || [])[0];
    const av = c.type === CHANNEL.GROUP_DM
      ? (c.icon ? h('img', { class: 'av', src: `https://cdn.discordapp.com/channel-icons/${c.id}/${c.icon}.png?size=32`, alt: '' }) : h('span', { class: 'av group' }, '👥'))
      : h('img', { class: 'av', src: avatarUrl(other, 32), alt: '', loading: 'lazy' });
    list.append(h('div', { class: 'row', dataset: { open: c.id, name }, onclick: () => app.openChannel(c) }, checkbox(c.id), av, h('span', { class: 'row-name' }, name)));
  }
  if (!app.dms.length) list.append(h('div', { class: 'muted pad' }, 'No open DMs. Closed DMs can be reopened with “Open DM with a user ID”.'));
  panel.append(head, h('div', { class: 'side-filter' }, filterBox('Filter DMs')), list, h('div', { class: 'side-foot', id: 'side-foot', hidden: true }));
  renderSelectionFooter();
}

function sortChannels(list) {
  const textish = (c) => (c.type === CHANNEL.VOICE || c.type === CHANNEL.STAGE ? 1 : 0);
  return list.sort((a, b) => textish(a) - textish(b) || (a.position ?? 0) - (b.position ?? 0) || a.name.localeCompare(b.name));
}

function renderGuildPanel(panel, gid) {
  const g = app.guilds.find((x) => x.id === gid) || { id: gid, name: 'Server' };
  const channels = app.guildChannels.get(gid);
  const head = h('div', { class: 'side-head' },
    h('div', { class: 'side-title', title: g.name }, g.name),
    h('div', { class: 'side-actions' },
      h('button', { class: 'icon-btn', title: 'Search this server', onclick: () => dialogs.showSearch({ guildId: gid }) }, '🔍'),
      h('button', { class: 'icon-btn', title: 'Export server', onclick: () => dialogs.showExport({ targets: [{ type: 'guild', guildId: gid, id: gid, name: g.name }] }) }, '⇩'),
      h('button', { class: 'icon-btn danger', title: 'Purge server', onclick: () => dialogs.showPurge({ targets: [{ type: 'guild', guildId: gid, id: gid, name: g.name }] }) }, '🗑'),
      h('button', { class: 'icon-btn', title: 'More', onclick: (e) => menu(e.currentTarget, [
        { label: 'Select all channels', onClick: () => { for (const c of channels || []) if (isMessageable(c) || canHaveThreads(c)) app.sidebar.checked.add(c.id); render(); } },
        { label: 'Load a thread or forum post by ID…', onClick: () => dialogs.showLoadThread() },
        { label: 'Copy channel list (names + IDs)', onClick: () => copyText((channels || []).filter((c) => c.type !== 4).map((c) => `#${c.name}\t${c.id}`).join('\n')).then(() => toast('Copied')) },
        { label: 'Copy server ID', onClick: () => copyText(gid).then(() => toast('Copied')) },
        '-',
        { label: 'Refresh channels', onClick: async () => { app.threadsByParent.clear(); await app.loadGuildChannels(gid, true).catch(app.handleError); render(); } },
      ]) }, '⋯')),
  );
  const list = h('div', { class: 'side-list' });
  if (!channels) {
    list.append(h('div', { class: 'muted pad' }, 'Loading channels…'));
  } else {
    const cats = channels.filter((c) => c.type === CHANNEL.CATEGORY).sort((a, b) => a.position - b.position);
    const groups = [{ id: null, name: null }, ...cats];
    for (const cat of groups) {
      const kids = sortChannels(channels.filter((c) => c.type !== CHANNEL.CATEGORY && (c.parent_id || null) === cat.id));
      if (!kids.length) continue;
      if (cat.id) {
        const collapsed = ui.collapsed.has(cat.id);
        list.append(h('div', { class: 'cat', onclick: () => { collapsed ? ui.collapsed.delete(cat.id) : ui.collapsed.add(cat.id); render(); } }, h('span', { class: 'caret' }, collapsed ? '▸' : '▾'), h('span', { class: 'cat-name', title: cat.name }, cat.name.toUpperCase())));
        if (collapsed) continue;
      }
      for (const c of kids) list.append(...channelRows(c));
    }
    if (!list.childElementCount) list.append(h('div', { class: 'muted pad' }, 'No channels you can see in this server.'));
  }
  panel.append(head, h('div', { class: 'side-filter' }, filterBox('Filter channels')), list, h('div', { class: 'side-foot', id: 'side-foot', hidden: true }));
  renderSelectionFooter();
}

function channelRows(c, depth = 0) {
  const rows = [];
  const threadsOk = canHaveThreads(c);
  const expanded = ui.expanded.has(c.id);
  const row = h('div', {
    class: `row ch depth-${depth}`, dataset: { open: c.id, name: c.name },
    onclick: () => app.openChannel(c),
  },
  checkbox(c.id),
  h('span', { class: 'ch-icon' }, channelIcon(c)),
  h('span', { class: 'row-name' }, c.name),
  threadsOk ? h('button', { class: 'thread-toggle', title: 'Show threads', onclick: (e) => { e.stopPropagation(); expandThreads(c); } }, ui.loadingThreads.has(c.id) ? '…' : expanded ? '▾🧵' : '▸🧵') : null);
  rows.push(row);
  if (expanded) {
    const threads = app.threadsByParent.get(c.id) || [];
    if (!threads.length && !ui.loadingThreads.has(c.id)) rows.push(h('div', { class: 'muted pad-s depth-1' }, 'No threads found'));
    for (const t of threads) {
      const archived = t.thread_metadata && t.thread_metadata.archived;
      rows.push(h('div', { class: 'row ch depth-1', dataset: { open: t.id, name: t.name }, onclick: () => app.openChannel(t) },
        checkbox(t.id), h('span', { class: 'ch-icon' }, '🧵'), h('span', { class: 'row-name' }, t.name), archived ? h('span', { class: 'tag' }, 'archived') : null));
    }
  }
  return rows;
}

// ---------------- saved ----------------
async function renderSaved(body) {
  fill(body, h('div', { class: 'muted pad' }, 'Loading…'));
  const convs = (await app.ws.listConvs()).filter((c) => !c.key.startsWith('exp:')).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  const list = h('div', { class: 'side-list' });
  for (const c of convs) {
    list.append(h('div', { class: 'row saved', dataset: { open: c.key, name: c.title }, onclick: () => app.openSavedConversation(c.key) },
      h('span', { class: 'ch-icon' }, c.kind === 'search' ? '🔍' : c.kind === 'package' ? '📦' : '#'),
      h('div', { class: 'row-main' }, h('div', { class: 'row-name' }, c.title), h('div', { class: 'muted small' }, `${c.subtitle ? c.subtitle + ' · ' : ''}${fmtNum(c.count || 0)} msgs${c.complete ? ' · complete' : ''}`)),
      h('button', { class: 'icon-btn', title: 'Remove from workspace', onclick: async (e) => { e.stopPropagation(); await app.removeConversation(c.key); } }, '✕')));
  }
  if (!convs.length) list.append(h('div', { class: 'muted pad' }, 'Conversations you load are kept here, so you can come back to them (even offline) without fetching again.'));
  fill(body, h('div', { class: 'side-panel full' },
    h('div', { class: 'side-head' }, h('div', { class: 'side-title' }, `Saved in “${app.ws.name}”`),
      convs.length ? h('button', { class: 'link-btn danger', onclick: async () => {
        if (!(await confirmDialog({ title: 'Remove all saved conversations?', message: 'This only clears Cleancord’s local copy. Nothing on Discord is touched.', confirmLabel: 'Remove all', danger: true }))) return;
        for (const c of convs) await app.ws.deleteConv(c.key);
        await app.setConversation(null);
        render();
      } }, 'Remove all') : null),
    h('div', { class: 'side-filter' }, filterBox('Filter')), list));
  highlight();
}

// ---------------- data package ----------------
function renderPackage(body) {
  const panel = h('div', { class: 'side-panel full' });
  if (!app.pkg) {
    const input = h('input', { type: 'file', accept: '.zip,application/zip', hidden: true, onchange: () => input.files[0] && openPackage(input.files[0]) });
    panel.append(
      h('div', { class: 'side-head' }, h('div', { class: 'side-title' }, 'Discord data package')),
      h('div', { class: 'pad' },
        h('p', null, 'Browse the ZIP Discord sends when you request your data (Settings → Data & Privacy → Request all of my data). It is read on this computer only.'),
        h('p', { class: 'muted small' }, 'The package lists every message you ever sent, including in servers and DMs you can no longer find in the app, so it is the most complete way to purge your history.'),
        ui.pkgProgress ? h('div', { class: 'muted' }, ui.pkgProgress) : h('button', { class: 'btn primary', onclick: () => input.click() }, 'Open package ZIP…'),
        input));
    fill(body, panel);
    return;
  }
  const pkg = app.pkg;
  const tree = pkg.tree();
  const list = h('div', { class: 'side-list' });
  const section = (key, title, items) => {
    if (!items.length) return;
    const collapsed = ui.pkgCollapsed.has(key);
    list.append(h('div', { class: 'cat', onclick: () => { collapsed ? ui.pkgCollapsed.delete(key) : ui.pkgCollapsed.add(key); render(); } },
      h('span', { class: 'caret' }, collapsed ? '▸' : '▾'), h('span', { class: 'cat-name', title }, `${title} (${items.length})`),
      h('button', { class: 'link-btn', onclick: (e) => { e.stopPropagation(); items.forEach((c) => app.sidebar.pkgChecked.add(c.id)); render(); } }, 'select all')));
    if (collapsed) return;
    for (const c of items) {
      list.append(h('div', { class: 'row', dataset: { open: `pkg:${c.id}`, name: c.title }, onclick: () => openPackageChannel(c.id) },
        h('input', { type: 'checkbox', class: 'row-check', checked: app.sidebar.pkgChecked.has(c.id), onclick: (e) => e.stopPropagation(),
          onchange: (e) => { e.target.checked ? app.sidebar.pkgChecked.add(c.id) : app.sidebar.pkgChecked.delete(c.id); renderPkgFoot(); } }),
        h('span', { class: 'row-name' }, c.title),
        h('span', { class: 'muted small' }, humanBytes(c.size))));
    }
  };
  section('dms', 'Direct messages', tree.dms);
  section('groups', 'Group DMs', tree.groups);
  for (const g of tree.servers) section(`g:${g.id}`, g.name, g.channels);
  section('other', 'Other', tree.other);
  panel.append(
    h('div', { class: 'side-head' },
      h('div', { class: 'side-title', title: pkg.name }, `📦 ${pkg.user.global_name || pkg.user.username}`),
      h('button', { class: 'link-btn', onclick: () => { app.pkg = null; app.sidebar.pkgChecked.clear(); render(); } }, 'Close')),
    h('div', { class: 'muted small pad-s' }, `${fmtNum(pkg.channels.size)} conversations · offline, no Discord API used`),
    h('div', { class: 'side-filter' }, filterBox('Filter')),
    list,
    h('div', { class: 'side-foot', id: 'pkg-foot', hidden: true }));
  fill(body, panel);
  renderPkgFoot();
}

function renderPkgFoot() {
  const foot = $('#pkg-foot');
  if (!foot) return;
  const ids = [...app.sidebar.pkgChecked];
  foot.hidden = !ids.length;
  if (!ids.length) return;
  fill(foot, 
    h('span', null, `${ids.length} selected`),
    h('button', { class: 'btn sm', onclick: () => exportPackage(ids) }, 'Export'),
    h('button', { class: 'btn sm', onclick: () => analyticsPackage(ids) }, 'Stats'),
    h('button', { class: 'btn sm danger', onclick: () => deletePackage(ids) }, 'Delete on Discord'),
    h('button', { class: 'link-btn', onclick: () => { app.sidebar.pkgChecked.clear(); render(); } }, 'Clear'),
  );
}

async function openPackage(file) {
  ui.pkgProgress = 'Reading package…';
  render();
  try {
    app.pkg = await DataPackage.open(file, (done, total) => { ui.pkgProgress = `Reading package… ${done}/${total}`; const m = $('#side-body .pad .muted'); if (m) m.textContent = ui.pkgProgress; });
    app.log('ok', `Opened data package with ${app.pkg.channels.size} conversations`);
  } catch (e) {
    toast(e.message, 'error');
    app.log('error', `Data package: ${e.message}`);
  }
  ui.pkgProgress = null;
  render();
}

export async function importPackageChannel(id) {
  const c = app.pkg.channels.get(id);
  const key = `pkg:${id}`;
  let conv = await app.ws.getConv(key);
  if (!conv) {
    const msgs = await app.pkg.messages(id);
    await app.ws.putMessages(key, msgs);
    const guildName = c.guildId ? (app.pkg.guilds.get(c.guildId) || {}).name : null;
    conv = { key, kind: 'package', title: c.title, subtitle: guildName ? `${guildName} · data package` : 'Data package', channelId: id, guildId: c.guildId || null, count: msgs.length, complete: true };
    await app.ws.putConv(conv);
    if (!app.channels.has(id)) app.channels.set(id, { id, name: c.kind === 'guild' ? c.name || c.title.replace(/^#/, '') : c.title, type: c.kind === 'dm' ? 1 : c.kind === 'group' ? 3 : 0, guild_id: c.guildId });
  }
  return conv;
}

async function openPackageChannel(id) {
  try {
    const conv = await importPackageChannel(id);
    await app.setConversation(conv);
  } catch (e) { app.handleError(e); }
}

async function exportPackage(ids) {
  const sources = [];
  for (const id of ids) {
    const conv = await importPackageChannel(id);
    const c = app.pkg.channels.get(id);
    const folder = c.kind === 'guild' ? ['Data package', (app.pkg.guilds.get(c.guildId) || {}).name || c.guildId, `${conv.title.replace(/^#/, '')} (${id})`] : ['Data package', c.kind === 'group' ? 'Group DMs' : 'Direct messages', `${conv.title} (${id})`];
    sources.push({ type: 'conv', convKey: conv.key, title: conv.title.replace(/^#/, ''), guildId: conv.guildId, channelId: id, folder });
  }
  dialogs.showExport({ convSources: sources, title: `${ids.length} package conversation(s)` });
}

async function analyticsPackage(ids) {
  const all = [];
  for (const id of ids) all.push(...(await app.ws.getMessages((await importPackageChannel(id)).key)));
  dialogs.showAnalytics({ messages: all, title: `${ids.length} package conversation(s)` });
}

async function deletePackage(ids) {
  const items = [];
  for (const id of ids) {
    const conv = await importPackageChannel(id);
    for (const m of await app.ws.getMessages(conv.key)) if (!m._deleted && !m._noAccess) items.push(slimForBulk(m));
  }
  if (!items.length) return toast('Nothing left to delete in those conversations');
  const ok = await confirmDialog({
    title: `Delete ${fmtNum(items.length)} messages on Discord?`,
    message: `This deletes every message from the selected ${ids.length} package conversation(s) on Discord, one by one, using your delay settings. Messages in servers you've left can't be deleted and will be skipped.\n\nThis cannot be undone.`,
    confirmLabel: 'Delete messages', danger: true,
  });
  if (!ok) return;
  app.startJob(new Job({ type: 'bulk', title: `Delete ${fmtNum(items.length)} package messages`, params: { action: 'delete', items }, resumable: true, ws: app.ws }));
  app.sidebar.tab = 'jobs';
  render();
}

// ---------------- jobs ----------------
async function renderJobs(body) {
  const saved = (await app.ws.listJobs()).filter((j) => !app.jobs.current || j.id !== app.jobs.current.id).filter((j) => !app.jobs.queue.some((q) => q.job.id === j.id));
  const jobRow = (j, extra) => h('div', { class: `task ${j.status || ''}` },
    h('div', { class: 'task-title' }, j.title),
    h('div', { class: 'muted small' }, extra),
  );
  const out = h('div', { class: 'side-panel full' }, h('div', { class: 'side-head' }, h('div', { class: 'side-title' }, 'Tasks')));
  const list = h('div', { class: 'side-list pad-s' });
  const cur = app.jobs.current;
  // The status panel is hidden on narrow windows, so the running task can be paused / stopped here too.
  if (cur) {
    list.append(h('div', { class: `task current ${cur.status || ''}` },
      h('div', { class: 'task-title' }, cur.title),
      h('div', { class: 'muted small' }, currentJobLabel(cur)),
      h('div', { class: 'task-btns' },
        cur.paused ? h('button', { class: 'btn sm primary', onclick: () => cur.resume() }, '▶ Resume') : h('button', { class: 'btn sm', onclick: () => cur.pause('by you') }, '⏸ Pause'),
        h('button', { class: 'btn sm danger', onclick: () => cur.cancel() }, '■ Stop'))));
  }
  jobsSig = jobsSignature();
  for (const q of app.jobs.queue) list.append(jobRow(q.job, 'queued'));
  if (saved.length) {
    list.append(h('div', { class: 'cat' }, 'Unfinished (can resume)'));
    for (const j of saved) {
      list.append(h('div', { class: 'task interrupted' },
        h('div', { class: 'task-title' }, j.title),
        h('div', { class: 'muted small' }, `Stopped ${new Date(j.savedAt).toLocaleString()}${j.progress && j.progress.total ? ` · ${fmtNum(j.progress.done)}/${fmtNum(j.progress.total)}` : ''}`),
        h('div', { class: 'task-btns' },
          h('button', { class: 'btn sm primary', onclick: (e) => { e.currentTarget.disabled = true; app.resumeJob(j); } }, '▶ Resume'),
          h('button', { class: 'btn sm ghost', onclick: async () => { await app.ws.deleteJob(j.id); render(); } }, 'Discard'))));
    }
  }
  if (app.jobs.history.length) {
    list.append(h('div', { class: 'cat' }, 'Recent'));
    for (const j of app.jobs.history) {
      const stats = Object.entries(j.stats || {}).filter(([, v]) => v).map(([k, v]) => `${k} ${fmtNum(v)}`).join(', ');
      list.append(jobRow(j, `${j.status}${j.error ? ': ' + j.error.message : ''}${stats ? ` · ${stats}` : ''}`));
    }
  }
  if (!list.childElementCount) list.append(h('div', { class: 'muted pad' }, 'No tasks yet. Long operations (load all, purge, export, bulk edits) show up here and can be resumed if Cleancord is closed.'));
  out.append(list);
  fill(body, out);
}

export { esc };
