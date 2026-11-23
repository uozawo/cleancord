// All dialogs: connection, settings, search, purge, export, bulk actions, reactions, analytics, workspaces, help.

import { app } from '../state.js';
import { S, saveSettings, DEFAULT_SETTINGS } from '../settings.js';
import {
  h, $, esc, fmtNum, avatarUrl, userName, userTag, copyText, downloadBlob, parseDiscordLink, isSnowflake, dmName,
  CHANNEL, sanitizeFilename, parseDateInput, uid, emojiUrl, humanBytes, fill,
} from '../util.js';
import { openModal, confirmDialog, promptDialog, toast, buildForm } from './dom.js';
import { HAS_TYPES, parseIdList, describeCriteria } from '../criteria.js';
import { Job } from '../jobs.js';
import { slimForBulk, computeEdit } from '../bulk.js';
import { DEFAULT_EXPORT_OPTIONS, BUILTIN_PRESETS, applyPreset } from '../export/exporter.js';
import { ZipFileSink, MemoryZipSink, FolderSink, canPickFiles, canPickFolders } from '../export/sinks.js';
import { isMessageable, canHaveThreads } from '../discord.js';
import { computeAnalytics, analyticsCsv } from '../analytics.js';
import { makeContext, emojiHtml } from '../render.js';
import { burstCount } from '../api.js';
import { listWorkspaces, saveWorkspaceList, deleteWorkspaceDb } from '../db.js';
import * as feed from './feed.js';
import * as sidebar from './sidebar.js';
import * as status from './status.js';

export function mount() {}

const mine = (m) => m.author && app.me && m.author.id === app.me.id;
const toIso = (v, end) => { const d = parseDateInput(v, end); return d ? d.toISOString() : null; };
const dateVal = (iso) => (iso ? new Date(iso).toISOString().slice(0, 10) : '');

// ---------------- connection ----------------
export async function showAccount() {
  const auth = await app.getAuth();
  const me = app.me;
  const statusEl = me
    ? h('div', { class: 'account-card' }, h('img', { class: 'av lg', src: avatarUrl(me, 64), alt: '' }),
      h('div', null, h('div', { class: 'strong' }, userName(me)), h('div', { class: 'muted small' }, `${userTag(me)} · ${me.id}`),
        h('div', { class: 'muted small' }, app.authSource === 'manual' ? 'Using a token you pasted' : 'Session picked up automatically from your Discord tab')))
    : h('div', { class: 'form-note warn' }, auth ? 'A session was found but Discord rejected it. Reload discord.com, or paste a fresh token below.' : 'Not connected.');
  const tokenInput = h('input', { class: 'input', type: 'password', placeholder: 'Paste a token (optional)', autocomplete: 'off', spellcheck: 'false' });
  openModal({
    title: 'Discord connection', width: 560,
    body: h('div', { class: 'form' },
      statusEl,
      h('div', { class: 'form-section' }, 'Connect automatically (recommended)'),
      h('ol', { class: 'steps' },
        h('li', null, 'Open ', h('a', { href: 'https://discord.com/app', target: '_blank', rel: 'noopener' }, 'discord.com'), ' in this browser and log in.'),
        h('li', null, 'Click around once (open any channel). Cleancord picks up the session from the requests your Discord tab already makes.'),
        h('li', null, 'Come back here; it connects on its own.')),
      h('p', { class: 'muted small' }, 'The session is kept in memory only (chrome.storage.session) and is wiped when you close the browser. It is only ever sent to discord.com.'),
      h('div', { class: 'form-section' }, 'Or use a token'),
      tokenInput,
      h('p', { class: 'muted small' }, 'Never paste a token someone else gave you, and never share yours: it gives full access to your account.')),
    actions: [
      { label: 'Forget session', kind: 'ghost', onClick: async () => { await app.forgetSession(); toast('Session forgotten'); } },
      app.authSource === 'manual' ? { label: 'Use auto-detected', kind: 'ghost', onClick: async () => { await app.useAutoToken(); } } : null,
      { label: 'Use token', kind: 'primary', onClick: async () => {
        if (!tokenInput.value.trim()) { toast('Paste a token first, or connect automatically via discord.com', 'error'); return false; }
        await app.setManualToken(tokenInput.value);
      } },
    ].filter(Boolean),
  });
}
export const showConnectHelp = showAccount;

// ---------------- settings ----------------
export function showSettings() {
  const f = buildForm([
    { type: 'section', label: 'Appearance' },
    { type: 'row', items: [
      { key: 'theme', type: 'select', label: 'Theme', value: S.theme, options: [['dark', 'Dark'], ['light', 'Light'], ['midnight', 'Midnight (black)']] },
      { key: 'density', type: 'select', label: 'Layout', value: S.density, options: [['cozy', 'Cozy'], ['compact', 'Compact']] },
      { key: 'pageSize', type: 'select', label: 'Messages per page', value: S.pageSize, options: [[50, '50'], [100, '100'], [200, '200'], [500, '500']] },
    ] },
    { type: 'row', items: [
      { key: 'dateFormat', type: 'select', label: 'Date format', value: S.dateFormat, options: [['locale', 'System'], ['iso', '2024-12-31'], ['mdy', '12/31/2024'], ['dmy', '31/12/2024'], ['ymd', '2024/12/31']] },
      { key: 'timeFormat', type: 'select', label: 'Time format', value: S.timeFormat, options: [['24h', '24-hour'], ['12h', '12-hour']] },
      { key: 'timezone', type: 'select', label: 'Time zone', value: S.timezone, options: [['local', 'Local'], ['utc', 'UTC']] },
    ] },
    { key: 'hideSystem', type: 'toggle', label: 'Hide system messages (joins, pins, calls…) in the feed', value: S.hideSystem },
    { key: 'showLauncher', type: 'toggle', label: 'Show the Cleancord button on discord.com', value: S.showLauncher },
    { type: 'section', label: 'Speed & safety', hint: 'Slower is safer. Discord can rate-limit or flag accounts that make many requests quickly.' },
    { type: 'row', items: [
      { key: 'modifyDelay', type: 'number', label: 'Delete/edit delay (s)', value: S.modifyDelay, min: 0, max: 60, step: 0.1 },
      { key: 'searchDelay', type: 'number', label: 'Search delay (s)', value: S.searchDelay, min: 0, max: 60, step: 0.1 },
      { key: 'delaySpread', type: 'number', label: 'Random spread ± (s)', value: S.delaySpread, min: 0, max: 30, step: 0.1 },
    ] },
    { key: 'finalPassCount', type: 'number', label: 'Purge final pass: re-check this many newest messages per channel', value: S.finalPassCount, min: 0, max: 1000 },
    { key: 'confirmDestructive', type: 'toggle', label: 'Ask before deleting', value: S.confirmDestructive },
    { type: 'section', label: 'Names & roles' },
    { key: 'lookupMembers', type: 'toggle', label: 'Look up server nicknames and role colors (one request per person, cached)', value: S.lookupMembers },
    { key: 'memberCacheHours', type: 'number', label: 'Keep looked-up names for (hours)', value: S.memberCacheHours, min: 1, max: 720 },
  ]);
  openModal({
    title: 'Settings', width: 640, body: f.el,
    actions: [
      { label: 'Reset to defaults', kind: 'ghost', onClick: async () => { await saveSettings({ ...DEFAULT_SETTINGS, focusMode: S.focusMode }); toast('Settings reset'); } },
      { label: 'Save', kind: 'primary', onClick: async () => {
        const v = f.values();
        await saveSettings({
          ...v,
          pageSize: Number(v.pageSize),
          modifyDelay: Math.max(0, Number(v.modifyDelay) || 0),
          searchDelay: Math.max(0, Number(v.searchDelay) || 0),
          delaySpread: Math.max(0, Number(v.delaySpread) || 0),
          finalPassCount: Math.max(0, Number(v.finalPassCount) || 0),
          memberCacheHours: Math.max(1, Number(v.memberCacheHours) || 24),
        });
        feed.refresh({ keepPage: true });
        toast('Settings saved', 'ok');
      } },
    ],
  });
}

// ---------------- help ----------------
export function showHelp() {
  openModal({
    title: 'How Cleancord works', width: 680,
    body: h('div', { class: 'help' },
      h('h3', null, 'Privacy'),
      h('ul', null,
        h('li', null, 'Cleancord has no server. It only talks to discord.com (API) and Discord’s CDN (images/files). The extension’s security policy blocks every other address, so even a bug couldn’t send data elsewhere.'),
        h('li', null, 'Your session token is read from your own Discord tab, kept in memory, and wiped when the browser closes.'),
        h('li', null, 'Loaded messages are stored in your browser (IndexedDB) so you can come back to them. Remove them any time from the Saved tab or by deleting the workspace.')),
      h('h3', null, 'Basics'),
      h('ul', null,
        h('li', null, 'Pick a DM or channel on the left. 100 messages load at first; use “Load older” or “Load all”.'),
        h('li', null, 'Search uses Discord’s own search (content, author, mentions, has:, dates, pinned, author type). Results load 25 at a time; “Load all results” keeps going.'),
        h('li', null, 'Filter refines what is loaded (regex, author, attachment name, dates, categories like Calls, Pinned, Replies; plus Inverse).'),
        h('li', null, 'Tick messages (shift-click for a range) to delete, edit, strip attachments, remove reactions or export them.'),
        h('li', null, 'Purge works on a DM, channels, threads or a whole server, and can also strip attachments or remove reactions. Tick several channels/DMs on the left for a multi-channel purge or export.'),
        h('li', null, 'Long tasks can be paused, stopped, and resumed later from the Tasks tab, even after closing Cleancord.')),
      h('h3', null, 'Good to know'),
      h('ul', null,
        h('li', null, 'Discord only lets you delete other people’s messages where you have Manage Messages, and never in DMs. Call messages and some system messages can’t be deleted by anyone.'),
        h('li', null, 'Automating a user account is against Discord’s Terms of Service. Keep the delays reasonable (Settings) to stay under rate limits.'),
        h('li', null, 'Closed DMs don’t appear in Discord’s list. Reopen one with “Open DM with a user ID”, or use your data package, which lists every channel you ever wrote in.'),
        h('li', null, 'Exports with media can be large. “Save into a folder” streams files straight to disk and can be resumed.'))),
  });
}

// ---------------- workspaces ----------------
export async function showWorkspaces() {
  const { workspaces, current } = await listWorkspaces();
  const list = h('div', { class: 'ws-list' }, workspaces.map((w) => h('div', { class: `ws-row${w === current ? ' current' : ''}` },
    h('span', { class: 'strong' }, w), w === current ? h('span', { class: 'tag' }, 'current') : null,
    h('span', { class: 'spacer' }),
    w !== current ? h('button', { class: 'btn sm', onclick: async () => { m.close(); await app.switchWorkspace(w); } }, 'Switch') : null,
    w !== current ? h('button', { class: 'btn sm danger', onclick: async () => {
      if (!(await confirmDialog({ title: `Delete workspace “${w}”?`, message: 'All conversations saved in it are removed from this browser. Nothing on Discord changes.', confirmLabel: 'Delete', danger: true }))) return;
      await deleteWorkspaceDb(w);
      await saveWorkspaceList(workspaces.filter((x) => x !== w), current);
      m.close();
      showWorkspaces();
    } }, 'Delete') : null)));
  const importInput = h('input', { type: 'file', accept: '.ndjson,.json', hidden: true, onchange: async () => {
    const file = importInput.files[0];
    if (!file) return;
    try {
      const n = await app.ws.importFrom(file, (c) => { importBtn.textContent = `Importing… ${fmtNum(c)}`; });
      toast(`Imported ${fmtNum(n)} records`, 'ok');
      sidebar.render();
    } catch (e) { toast(e.message, 'error'); }
    importBtn.textContent = 'Import into this workspace…';
  } });
  const importBtn = h('button', { class: 'btn sm', onclick: () => importInput.click() }, 'Import into this workspace…');
  const m = openModal({
    title: 'Workspaces', width: 560,
    body: h('div', { class: 'form' },
      h('p', { class: 'muted small' }, 'A workspace keeps loaded conversations, unfinished tasks and caches. Use several to keep things apart, or export one to move it to another browser.'),
      list,
      h('div', { class: 'form-row' },
        h('button', { class: 'btn sm', onclick: async () => {
          const name = (await promptDialog({ title: 'New workspace', label: 'Name', placeholder: 'e.g. Old server cleanup' }) || '').trim();
          if (!name) return;
          m.close();
          await app.switchWorkspace(name);
        } }, '+ New workspace'),
        h('button', { class: 'btn sm', onclick: () => exportWorkspace() }, 'Export this workspace…'),
        importBtn, importInput)),
  });
}

async function exportWorkspace() {
  const name = `cleancord-workspace-${sanitizeFilename(app.ws.name)}.ndjson`;
  try {
    if (canPickFiles()) {
      const handle = await window.showSaveFilePicker({ suggestedName: name, types: [{ description: 'Cleancord workspace', accept: { 'application/x-ndjson': ['.ndjson'] } }] });
      const w = await handle.createWritable();
      await app.ws.exportTo((s) => w.write(s));
      await w.close();
    } else {
      const parts = [];
      await app.ws.exportTo(async (s) => { parts.push(s); });
      downloadBlob(new Blob(parts, { type: 'application/x-ndjson' }), name);
    }
    toast('Workspace exported', 'ok');
  } catch (e) { if (e.name !== 'AbortError') toast(e.message, 'error'); }
}

// ---------------- search ----------------
export function showSearch({ guildId = null, channelId = null, criteria = null, channelIds = null } = {}) {
  if (!guildId && !channelId) {
    if (app.conv && app.conv.channelId && app.conv.kind !== 'package') { guildId = app.conv.guildId; channelId = app.conv.channelId; } else if (app.sidebar.guildId && app.sidebar.guildId !== '@me') guildId = app.sidebar.guildId;
  }
  if (!guildId && !channelId) return toast('Open a DM or pick a server first', 'error');
  const c = criteria || {};
  const checkedHere = guildId ? [...app.sidebar.checked].filter((id) => (app.channels.get(id) || {}).guild_id === guildId) : [];
  const scopeOpts = [];
  if (guildId) {
    if (channelId) scopeOpts.push(['channel', `This channel (${app.channelName(channelId)})`]);
    scopeOpts.push(['guild', `Whole server (${app.guildName(guildId)})`]);
    if (checkedHere.length) scopeOpts.push(['checked', `The ${checkedHere.length} channel(s) ticked on the left`]);
  }
  const authorIds = c.authorIds || [];
  const isMe = authorIds.length === 1 && app.me && authorIds[0] === app.me.id;
  const f = buildForm([
    guildId ? { key: 'scope', type: 'radio', label: 'Where', value: channelIds && channelIds.length > 1 ? 'checked' : channelId || (channelIds && channelIds.length === 1) ? 'channel' : 'guild', options: scopeOpts } : { type: 'note', label: `In this DM: ${app.channelName(channelId)}` },
    { key: 'content', type: 'text', label: 'Contains', value: c.content || '', placeholder: 'words or phrase' },
    { key: 'from', type: 'radio', label: 'From', inline: true, value: isMe ? 'me' : authorIds.length ? 'ids' : 'anyone', options: [['anyone', 'Anyone'], ['me', 'Me'], ['ids', 'User IDs']] },
    { key: 'authorIds', type: 'text', label: 'User IDs (comma separated)', value: isMe ? '' : authorIds.join(', '), when: (v) => v.from === 'ids' },
    { key: 'mentions', type: 'text', label: 'Mentions user IDs', value: (c.mentions || []).join(', ') },
    { key: 'has', type: 'checks', label: 'Has', value: c.has || [], options: HAS_TYPES },
    { type: 'row', items: [
      { key: 'after', type: 'date', label: 'After', value: dateVal(c.after) },
      { key: 'before', type: 'date', label: 'Before', value: dateVal(c.before) },
      { key: 'pinned', type: 'select', label: 'Pinned', value: c.pinned || 'any', options: [['any', 'Any'], ['only', 'Only pinned'], ['exclude', 'Not pinned']] },
      { key: 'authorType', type: 'select', label: 'Author type', value: c.authorType || '', options: [['', 'Any'], ['user', 'People'], ['bot', 'Bots'], ['webhook', 'Webhooks']] },
    ] },
  ]);
  openModal({
    title: 'Search messages', width: 620, body: f.el,
    actions: [
      { label: 'Cancel', kind: 'ghost' },
      { label: 'Search', kind: 'primary', onClick: async () => {
        const v = f.values();
        const crit = {
          content: v.content, authorIds: v.from === 'me' ? [app.me.id] : v.from === 'ids' ? parseIdList(v.authorIds) : [],
          mentions: parseIdList(v.mentions), has: v.has, after: toIso(v.after), before: toIso(v.before, true),
          pinned: v.pinned, authorType: v.authorType,
        };
        let scope; let ids = null; let label;
        if (guildId) {
          scope = { guildId };
          if (v.scope === 'channel') { ids = [channelId || channelIds[0]]; label = `#${app.channelName(ids[0])}`; } else if (v.scope === 'checked') { ids = checkedHere.length ? checkedHere : channelIds; label = `${ids.length} channels`; } else label = app.guildName(guildId);
        } else { scope = { channelId }; label = app.channelName(channelId); }
        app.runSearch({ criteria: crit, scope, channelIds: ids, label });
      } },
    ],
  });
}

// ---------------- purge ----------------
function targetsFromConv() {
  const conv = app.conv;
  if (!conv) return { targets: [], criteria: null };
  if (conv.kind === 'channel') {
    const ch = app.channels.get(conv.channelId) || {};
    if (!conv.guildId) return { targets: [{ type: 'dm', id: conv.channelId, name: conv.title }] };
    return { targets: [{ type: 'channel', id: conv.channelId, guildId: conv.guildId, name: conv.title, channelType: ch.type }] };
  }
  if (conv.kind === 'search') {
    const crit = conv.criteria || {};
    if (conv.scope && conv.scope.channelId) return { targets: [{ type: 'dm', id: conv.scope.channelId, name: app.channelName(conv.scope.channelId) }], criteria: crit };
    if (conv.channelIds && conv.channelIds.length) return { targets: conv.channelIds.map((id) => ({ type: 'channel', id, guildId: conv.guildId, name: `#${app.channelName(id)}` })), criteria: crit };
    return { targets: [{ type: 'guild', id: conv.guildId, guildId: conv.guildId, name: app.guildName(conv.guildId) }], criteria: crit };
  }
  return { targets: [], criteria: null };
}

export function showPurge({ targets = null, fromConv = false, criteria = null } = {}) {
  if (!app.me) return toast('Connect to Discord first', 'error');
  if (!targets || !targets.length) {
    const t = targetsFromConv();
    targets = t.targets;
    criteria = criteria || t.criteria;
  }
  if (!targets.length) return toast('Open a conversation, or tick DMs/channels on the left, or use a server’s 🗑 button', 'error');
  const c = criteria || {};
  const isDmOnly = targets.every((t) => t.type === 'dm');
  const hasGuild = targets.some((t) => t.type === 'guild');
  const hasChannel = targets.some((t) => t.type === 'channel');
  const authorIds = (c.authorIds || []).filter((id) => id !== app.me.id);
  const f = buildForm([
    { type: 'custom', el: h('div', { class: 'targets' }, h('span', { class: 'muted small' }, 'Targets: '), targets.slice(0, 12).map((t) => h('span', { class: 'chip' }, `${t.type === 'guild' ? '🏠 ' : t.type === 'dm' ? '✉ ' : ''}${t.name}`)), targets.length > 12 ? h('span', { class: 'chip' }, `+${targets.length - 12} more`) : null) },
    { type: 'section', label: 'What to remove' },
    { key: 'mode', type: 'radio', value: 'delete', options: [
      ['delete', 'Delete messages'],
      ['attachments', 'Remove attachments only', 'keeps the text; messages that would end up empty are skipped or deleted'],
      ['reactions', 'Remove reactions only', 'scans the full history; no messages are deleted'],
    ] },
    { key: 'authorMode', type: 'radio', label: 'Whose messages', inline: true, value: authorIds.length ? 'ids' : 'me', when: (v) => v.mode !== 'reactions',
      options: isDmOnly ? [['me', 'Mine']] : [['me', 'Mine'], ['ids', 'Specific users'], ['anyone', 'Everyone (needs Manage Messages)']] },
    { key: 'authorIds', type: 'text', label: 'User IDs', value: authorIds.join(', '), placeholder: 'comma separated', when: (v) => v.mode !== 'reactions' && v.authorMode === 'ids' },
    { key: 'reactionWho', type: 'radio', label: 'Whose reactions', inline: true, value: 'me', when: (v) => v.mode === 'reactions',
      options: [['me', 'Mine'], ['ids', 'Specific users'], ['all', 'All reactions (needs Manage Messages)']] },
    { key: 'reactionIds', type: 'text', label: 'User IDs', placeholder: 'comma separated', when: (v) => v.mode === 'reactions' && v.reactionWho === 'ids' },
    { key: 'reactionEmoji', type: 'text', label: 'Only this emoji (optional)', placeholder: 'e.g. 👍 or custom emoji name', when: (v) => v.mode === 'reactions' },
    { type: 'section', label: 'Only messages that…', hint: 'leave empty for all' },
    { key: 'content', type: 'text', label: 'Contain', value: c.content || '' },
    { key: 'has', type: 'checks', label: 'Have', value: c.has || [], options: HAS_TYPES },
    { key: 'mentions', type: 'text', label: 'Mention user IDs', value: (c.mentions || []).join(', ') },
    { type: 'row', items: [
      { key: 'after', type: 'date', label: 'Sent after', value: dateVal(c.after) },
      { key: 'before', type: 'date', label: 'Sent before', value: dateVal(c.before) },
      { key: 'pinned', type: 'select', label: 'Pinned messages', value: c.pinned === 'only' ? 'only' : 'any', options: [['any', 'Include'], ['exclude', 'Skip pinned'], ['only', 'Only pinned']] },
    ] },
    { key: 'systemGroups', type: 'checks', label: 'Also delete these system messages (when allowed)', value: [], when: (v) => v.mode === 'delete',
      options: [['pins', 'Pin notices'], ['threads', 'Thread created'], ['joins', 'Joins'], ['boosts', 'Boosts'], ['other', 'Other']] },
    { type: 'section', label: 'Options' },
    { key: 'keepAttachments', type: 'toggle', label: 'Keep messages that have attachments', value: false, when: (v) => v.mode === 'delete' },
    { key: 'emptyPolicy', type: 'select', label: 'If removing attachments would leave a message empty', value: 'skip', options: [['skip', 'Skip it'], ['delete', 'Delete the message']], when: (v) => v.mode === 'attachments' },
    { key: 'includeThreads', type: 'toggle', label: 'Include threads and forum posts', value: true, when: () => hasChannel || hasGuild },
    { key: 'scan', type: 'radio', label: 'Method', value: 'search', when: (v) => v.mode !== 'reactions', options: [
      ['search', 'Discord search (fast)'],
      ['history', 'Scan the full history (slow, finds everything search misses)'],
    ] },
    { key: 'finalPass', type: 'number', label: 'Final pass: re-check the newest N messages in each channel touched (search misses very recent messages)', value: S.finalPassCount, min: 0, max: 1000, when: (v) => v.mode !== 'reactions' && v.scan === 'search' },
    { key: 'finalPassScope', type: 'select', label: 'Final pass covers', value: 'touched', options: [['touched', 'Channels where messages were found'], ['all', 'Every channel in the server']], when: (v) => hasGuild && v.mode !== 'reactions' && v.scan === 'search' },
    { type: 'note', label: `Speed: ${S.modifyDelay}s between changes, ${S.searchDelay}s between searches (±${S.delaySpread}s). Change in Settings.` },
    { type: 'note', kind: 'warn', label: 'Deleted messages cannot be recovered. Export first if you want a copy.' },
  ]);
  openModal({
    title: 'Purge', width: 660, body: f.el,
    actions: [
      { label: 'Cancel', kind: 'ghost' },
      { label: 'Start purge', kind: 'danger', onClick: async () => {
        const v = f.values();
        const params = {
          targets: targets.map((t) => ({ ...t, guildId: t.guildId || (t.type === 'guild' ? t.id : null) })),
          mode: v.mode,
          authorMode: v.authorMode || 'me',
          authorIds: parseIdList(v.authorIds),
          criteria: { content: v.content, has: v.has, mentions: parseIdList(v.mentions), after: toIso(v.after), before: toIso(v.before, true), pinned: v.pinned === 'any' ? null : v.pinned, authorType: c.authorType || '' },
          systemGroups: v.systemGroups || [],
          keepAttachments: !!v.keepAttachments,
          emptyPolicy: v.emptyPolicy || 'skip',
          includeThreads: v.includeThreads !== false,
          scan: v.mode === 'reactions' ? 'history' : v.scan,
          finalPass: Number(v.finalPass) || 0,
          finalPassScope: v.finalPassScope || 'touched',
          reactionUsers: v.reactionWho === 'all' ? ['*'] : v.reactionWho === 'ids' ? parseIdList(v.reactionIds) : ['@me'],
          reactionEmoji: (v.reactionEmoji || '').replace(/:/g, '').trim(),
        };
        if (params.mode !== 'reactions' && params.authorMode === 'ids' && !params.authorIds.length) { toast('Enter at least one user ID', 'error'); return false; }
        if (params.mode === 'reactions' && v.reactionWho === 'ids' && !params.reactionUsers.length) { toast('Enter at least one user ID', 'error'); return false; }
        const what = params.mode === 'delete' ? 'delete' : params.mode === 'attachments' ? 'strip attachments from' : 'remove reactions on';
        const whose = params.mode === 'reactions' ? '' : params.authorMode === 'me' ? 'your ' : params.authorMode === 'ids' ? `${params.authorIds.length} user(s)' ` : 'everyone’s ';
        const ok = await confirmDialog({
          title: 'Start purge?',
          message: `This will ${what} ${whose}messages in ${targets.length === 1 ? targets[0].name : `${targets.length} places`}.\nFilter: ${describeCriteria(params.criteria)}\n\nIt can’t be undone.`,
          confirmLabel: 'Yes, purge', danger: true,
        });
        if (!ok) return false;
        const title = `Purge ${targets.length === 1 ? targets[0].name : `${targets.length} targets`}${params.mode !== 'delete' ? ` (${params.mode})` : ''}`;
        app.startJob(new Job({ type: 'purge', title, params, resumable: true, ws: app.ws }));
      } },
    ],
  });
}

// ---------------- export ----------------
async function loadPresets() {
  const { exportPresets = [], exportOptions = null } = await chrome.storage.local.get(['exportPresets', 'exportOptions']);
  return { custom: exportPresets, last: exportOptions };
}

function optionsToFields(o, { live, hasPackageOnly }) {
  const P = o.preview || {};
  const D = o.download || {};
  return [
    { key: 'formats', type: 'checks', label: 'Formats (none = media only)', value: Object.entries(o.formats || {}).filter(([, v]) => v).map(([k]) => k), options: [['html', 'HTML (Discord look)'], ['json', 'JSON'], ['csv', 'CSV'], ['txt', 'Plain text']] },
    { type: 'row', when: (v) => v.formats.includes('html'), items: [
      { key: 'messagesPerPage', type: 'number', label: 'Messages per HTML page', value: o.messagesPerPage, min: 50, max: 100000 },
      { key: 'theme', type: 'select', label: 'HTML theme', value: o.theme, options: [['dark', 'Dark'], ['light', 'Light'], ['midnight', 'Midnight']] },
      { key: 'imageMode', type: 'select', label: 'Images in HTML', value: o.imageMode, options: [['hover-safe', 'Small, grow on hover (≤400px)'], ['hover-full', 'Small, full size on hover'], ['safe', 'Up to 400px'], ['full', 'Full size']] },
    ] },
    { key: 'preview', type: 'checks', label: 'Show inline in HTML', when: (v) => v.formats.includes('html'), value: Object.entries(P).filter(([, v]) => v).map(([k]) => k),
      options: [['images', 'Images'], ['videos', 'Videos'], ['audio', 'Audio'], ['embedImages', 'Embedded images'], ['embedVideos', 'Embedded videos']] },
    { key: 'download', type: 'checks', label: 'Download for offline viewing', value: Object.entries(D).filter(([, v]) => v).map(([k]) => k),
      options: [['images', 'Images'], ['videos', 'Videos'], ['audio', 'Audio'], ['files', 'Other files'], ['embedImages', 'Embedded images'], ['embedVideos', 'Embedded videos'], ['avatars', 'Avatars'], ['emojis', 'Custom emojis'], ['stickers', 'Stickers']] },
    { key: 'maxFileMB', type: 'number', label: 'Skip files larger than (MB, 0 = no limit)', value: o.maxFileMB || 0, min: 0 },
    { type: 'row', items: [
      { key: 'artistMode', type: 'toggle', label: 'Group media by author (artist mode)', value: !!o.artistMode },
      { key: 'includeReactions', type: 'toggle', label: 'Include reactions', value: o.includeReactions !== false },
    ] },
    { type: 'row', items: [
      live ? { key: 'includeThreads', type: 'toggle', label: 'Include threads & forum posts', value: o.includeThreads !== false } : { type: 'note', label: '' },
      live ? { key: 'separateThreads', type: 'toggle', label: 'Threads in their own folders', value: o.separateThreads !== false } : { type: 'note', label: '' },
    ] },
    hasPackageOnly ? { type: 'note', label: '' } : { key: 'lookupMembers', type: 'toggle', label: 'Server nicknames & role colors', value: o.lookupMembers !== false },
  ];
}

function fieldsToOptions(v) {
  const set = (arr, keys) => Object.fromEntries(keys.map((k) => [k, (arr || []).includes(k)]));
  return {
    formats: set(v.formats, ['html', 'json', 'csv', 'txt']),
    messagesPerPage: Math.max(50, Number(v.messagesPerPage) || 1000),
    theme: v.theme || 'dark',
    imageMode: v.imageMode || 'hover-safe',
    preview: set(v.preview, ['images', 'videos', 'audio', 'embedImages', 'embedVideos']),
    download: set(v.download, ['images', 'videos', 'audio', 'files', 'embedImages', 'embedVideos', 'avatars', 'emojis', 'stickers']),
    maxFileMB: Math.max(0, Number(v.maxFileMB) || 0),
    artistMode: !!v.artistMode,
    includeReactions: !!v.includeReactions,
    includeThreads: v.includeThreads !== false,
    separateThreads: v.separateThreads !== false,
    lookupMembers: v.lookupMembers !== false,
  };
}

function folderForChannel(ch, guildName) {
  if (!ch.guild_id) return ['Direct Messages', `${ch.name || dmName(ch, app.me && app.me.id)} (${ch.id})`];
  return [guildName || app.guildName(ch.guild_id), `${ch.name} (${ch.id})`];
}

export async function showExport({ targets = null, current = false, selection = false, convSources = null, title = null } = {}) {
  if (!targets && !current && !selection && !convSources) {
    if (app.conv) current = true;
    else return toast('Open a conversation, or tick DMs/channels on the left first', 'error');
  }
  const live = !!(targets && targets.length);
  const cv = app.conv;
  const canFetchAll = !!(current && !selection && cv && cv.kind === 'channel' && !cv.complete && !(cv.doneChannels && cv.doneChannels[cv.channelId]) && !feed.filtersActive());
  let summary;
  if (selection) summary = `${fmtNum(app.selected.size)} selected message(s) from ${app.conv.title}`;
  else if (current) summary = `${app.conv.title}: ${fmtNum(app.view.length)} message(s)${app.view.length !== app.messages.length ? ' (filtered)' : ''}`;
  else if (convSources) summary = title || `${convSources.length} conversation(s)`;
  else summary = targets.length === 1 ? targets[0].name : `${targets.length} conversations`;

  let { custom, last } = await loadPresets();
  let options = applyPreset(DEFAULT_EXPORT_OPTIONS, last || {});
  const hasPackageOnly = !!convSources || (current && app.conv && app.conv.kind === 'package');
  const container = h('div');
  let form;
  const presetSel = h('select', { class: 'input' });
  // Rebuilt after saving or deleting a preset, so the list never offers a stale one.
  const fillPresets = (value = '') => {
    fill(presetSel,
      h('option', { value: '' }, 'Choose a preset…'),
      h('optgroup', { label: 'Built in' }, BUILTIN_PRESETS.map((p, i) => h('option', { value: `b${i}` }, p.name))),
      custom.length ? h('optgroup', { label: 'Yours' }, custom.map((p, i) => h('option', { value: `c${i}` }, p.name))) : null);
    presetSel.value = value;
    if (delBtn) delBtn.hidden = !custom.length;
  };
  let delBtn = null;
  fillPresets();
  const drawForm = () => {
    form = buildForm([
      canFetchAll ? { key: 'fetchAll', type: 'toggle', value: true, label: `Fetch the whole conversation from Discord first (only ${fmtNum(app.messages.length)} messages are loaded now)` } : null,
      ...optionsToFields(options, { live: live || canFetchAll, hasPackageOnly }),
      ...(live ? [
        { type: 'section', label: 'Only messages…', hint: 'optional' },
        { type: 'row', items: [
          { key: 'after', type: 'date', label: 'Sent after' },
          { key: 'before', type: 'date', label: 'Sent before' },
        ] },
        { type: 'row', items: [
          { key: 'authorIds', type: 'text', label: 'From user IDs', placeholder: 'comma separated' },
          { key: 'content', type: 'text', label: 'Containing' },
        ] },
        { key: 'keep', type: 'toggle', label: 'Also keep the fetched messages in this workspace', value: false },
      ] : []),
      canFetchAll ? { key: 'keep', type: 'toggle', label: 'Keep the fetched messages in this workspace', value: true, when: (vv) => vv.fetchAll } : null,
      { type: 'section', label: 'Save to' },
      { key: 'target', type: 'radio', value: canPickFolders() ? 'folder' : canPickFiles() ? 'zip' : 'memory', options: [
        canPickFolders() ? ['folder', 'A folder on your computer', 'streams files straight to disk; can be resumed if interrupted'] : null,
        canPickFiles() ? ['zip', 'A .zip file', 'streams to disk; restart from scratch if interrupted'] : null,
        ['memory', 'Download a .zip', 'built in memory; fine for small exports'],
      ].filter(Boolean) },
    ]);
    fill(container, form.el);
  };
  presetSel.addEventListener('change', () => {
    const v = presetSel.value;
    if (!v) return;
    const p = v[0] === 'b' ? BUILTIN_PRESETS[Number(v.slice(1))] : custom[Number(v.slice(1))];
    options = applyPreset(DEFAULT_EXPORT_OPTIONS, p);
    drawForm();
  });
  drawForm();
  const body = h('div', { class: 'form' },
    h('div', { class: 'targets' }, h('span', { class: 'muted small' }, 'Exporting: '), h('span', { class: 'chip' }, summary)),
    h('div', { class: 'form-row' }, presetSel,
      h('button', { class: 'btn sm ghost', onclick: async () => {
        const name = ((await promptDialog({ title: 'Save preset', label: 'Preset name' })) || '').trim();
        if (!name) return;
        const list = [...custom.filter((p) => p.name !== name), { name, options: fieldsToOptions(form.values()) }];
        await chrome.storage.local.set({ exportPresets: list });
        custom = list;
        fillPresets(`c${list.length - 1}`);
        toast('Preset saved', 'ok');
      } }, 'Save as preset'),
      delBtn = h('button', { class: 'btn sm ghost', hidden: !custom.length, onclick: async () => {
        const v = presetSel.value;
        if (!v || v[0] !== 'c') return toast('Pick one of your presets first');
        custom = custom.filter((_, i) => i !== Number(v.slice(1)));
        await chrome.storage.local.set({ exportPresets: custom });
        fillPresets();
        toast('Preset deleted');
      } }, 'Delete preset')),
    container);

  openModal({
    title: 'Export', width: 700, body,
    actions: [
      { label: 'Cancel', kind: 'ghost' },
      { label: 'Start export', kind: 'primary', onClick: async () => {
        const v = form.values();
        const opts = fieldsToOptions(v);
        const anyFormat = Object.values(opts.formats).some(Boolean);
        const anyDl = Object.values(opts.download).some(Boolean);
        if (!anyFormat && !anyDl) { toast('Pick at least one format or something to download', 'error'); return false; }
        await chrome.storage.local.set({ exportOptions: opts });
        const rootName = sanitizeFilename(`Cleancord ${summary}`.slice(0, 60));
        const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ').replace(':', '-');
        // Pick the destination first, while the click still counts as a user gesture.
        let sink;
        let dirHandle = null;
        try {
          if (v.target === 'folder') {
            const root = await FolderSink.pick();
            dirHandle = await root.getDirectoryHandle(sanitizeFilename(`${rootName} ${stamp}`), { create: true });
            sink = new FolderSink(dirHandle);
          } else if (v.target === 'zip') {
            sink = await ZipFileSink.pick(`${rootName} ${stamp}.zip`);
          } else {
            sink = new MemoryZipSink(`${rootName} ${stamp}.zip`);
          }
        } catch (e) {
          if (e.name === 'AbortError') return false;
          throw e;
        }
        const job = new Job({ type: 'export', title: `Export ${summary}`, resumable: !!dirHandle, ws: app.ws });
        const sources = [];
        if (canFetchAll && v.fetchAll) {
          const ch = app.channels.get(cv.channelId) || { id: cv.channelId, name: cv.title.replace(/^#/, ''), guild_id: cv.guildId, type: cv.channelType };
          sources.push({ type: 'channel', channelId: cv.channelId, guildId: cv.guildId || null, title: (ch.name || cv.title).replace(/^#/, ''), channelType: ch.type, folder: folderForChannel(ch) });
        } else if (selection || current) {
          const conv = app.conv;
          const list = selection ? app.messages.filter((m) => app.selected.has(m.id)) : app.view;
          const unfiltered = current && !selection && app.view.length === app.messages.length;
          let convKey = conv.key;
          let temp = false;
          if (!unfiltered) {
            convKey = `exp:${job.id}:sel`;
            await app.ws.putMessages(convKey, list);
            await app.ws.putConv({ key: convKey, kind: conv.kind, temp: true, title: conv.title, guildId: conv.guildId, channelId: conv.channelId, count: list.length });
            temp = true;
          }
          const ch = conv.channelId && app.channels.get(conv.channelId);
          const folder = conv.kind === 'search' ? ['Search results', conv.title.slice(0, 60)]
            : conv.kind === 'package' ? ['Data package', `${conv.title.replace(/^#/, '')} (${conv.channelId})`]
              : ch ? folderForChannel(ch) : [conv.title];
          sources.push({ type: 'conv', convKey, temp, title: conv.title.replace(/^#/, '').replace(/^Search: /, 'search '), guildId: conv.guildId, channelId: conv.channelId, folder, showChannel: conv.kind === 'search' });
        } else if (convSources) {
          sources.push(...convSources);
        } else {
          for (const t of targets) {
            if (t.type === 'guild') {
              const chans = await app.loadGuildChannels(t.guildId);
              for (const c of chans) {
                if (!isMessageable(c) && !canHaveThreads(c)) continue;
                if (c.type === CHANNEL.CATEGORY) continue;
                sources.push({ type: 'channel', channelId: c.id, guildId: t.guildId, title: c.name, channelType: c.type, folder: folderForChannel(c, t.name) });
              }
            } else {
              const c = app.channels.get(t.id) || { id: t.id, name: t.name.replace(/^#/, ''), guild_id: t.guildId, type: t.channelType };
              sources.push({ type: 'channel', channelId: t.id, guildId: t.guildId || null, title: (c.name || t.name).replace(/^#/, ''), channelType: c.type, folder: folderForChannel(c) });
            }
          }
        }
        job.params = {
          rootName, sources, options: opts, target: v.target, dirHandle, keepInWorkspace: !!v.keep,
          criteria: live ? { after: toIso(v.after), before: toIso(v.before, true), authorIds: parseIdList(v.authorIds), content: v.content || '' } : null,
        };
        job.runtime = { sink };
        app.startJob(job).then(() => { if (v.target === 'folder') toast('Export saved to the folder you picked', 'ok', 6000); });
      } },
    ],
  });
}

// ---------------- bulk actions ----------------
export function showBulkEdit(list, single = false) {
  const own = list.filter((m) => mine(m) && !m._package);
  if (!own.length) return toast('You can only edit your own messages', 'error');
  const preview = h('div', { class: 'preview' });
  const f = buildForm([
    own.length < list.length ? { type: 'note', kind: 'warn', label: `${list.length - own.length} message(s) by other people will be skipped.` } : null,
    { key: 'mode', type: 'radio', label: 'Change', inline: true, value: single ? 'replace' : 'find', options: [['replace', 'Replace all text'], ['find', 'Find & replace'], ['append', 'Add to end'], ['prepend', 'Add to start']] },
    { key: 'text', type: 'textarea', label: 'Text', rows: 5, value: single ? own[0].content || '' : '', when: (v) => v.mode !== 'find' },
    { key: 'find', type: 'text', label: 'Find', when: (v) => v.mode === 'find' },
    { key: 'replace', type: 'text', label: 'Replace with', when: (v) => v.mode === 'find' },
    { type: 'row', when: (v) => v.mode === 'find', items: [
      { key: 'regex', type: 'toggle', label: 'Regular expression', value: false },
      { key: 'ignoreCase', type: 'toggle', label: 'Ignore case', value: true },
    ] },
    { type: 'custom', el: preview },
  ].filter(Boolean), { onChange: () => drawPreview() });
  function drawPreview() {
    const e = f.values();
    let rows = [];
    try {
      rows = own.slice(0, 3).map((m) => {
        const next = computeEdit(m.content, e);
        return h('div', { class: 'preview-row' }, h('div', { class: 'muted small' }, 'Before'), h('div', { class: 'pre-line' }, m.content || '(empty)'), h('div', { class: 'muted small' }, 'After'), h('div', { class: 'pre-line' + (next === m.content ? ' muted' : '') }, next === m.content ? '(unchanged)' : next || '(empty)'));
      });
    } catch (err) { rows = [h('div', { class: 'form-note warn' }, `Invalid pattern: ${err.message}`)]; }
    fill(preview, h('div', { class: 'form-section' }, `Preview${own.length > 3 ? ` (first 3 of ${own.length})` : ''}`), ...rows);
  }
  drawPreview();
  openModal({
    title: single ? 'Edit message' : `Edit ${fmtNum(own.length)} messages`, width: 620, body: f.el,
    actions: [
      { label: 'Cancel', kind: 'ghost' },
      { label: single ? 'Save' : 'Apply edits', kind: 'primary', onClick: async () => {
        const e = f.values();
        if (e.mode === 'find' && !e.find) { toast('Enter text to find', 'error'); return false; }
        if (e.mode === 'find' && e.regex) { try { new RegExp(e.find); } catch (err) { toast(err.message, 'error'); return false; } }
        app.startJob(new Job({ type: 'bulk', title: `Edit ${fmtNum(own.length)} message(s)`, params: { action: 'edit', items: own.map(slimForBulk), edit: e }, resumable: true, ws: app.ws }));
      } },
    ],
  });
}

export function showBulkAttachments(list) {
  const own = list.filter((m) => mine(m) && m.attachments && m.attachments.length && !m._package);
  if (!own.length) return toast('None of these are your messages with attachments', 'error');
  const total = own.reduce((s, m) => s + m.attachments.length, 0);
  const f = buildForm([
    { type: 'note', label: `${fmtNum(own.length)} message(s) with ${fmtNum(total)} attachment(s).` },
    { key: 'filter', type: 'text', label: 'Only attachments whose name contains (empty = all)', placeholder: 'e.g. .png or SPOILER_' },
    { key: 'emptyPolicy', type: 'radio', label: 'If a message would end up empty', value: 'skip', options: [['skip', 'Leave it alone'], ['delete', 'Delete the message']] },
  ]);
  openModal({
    title: 'Remove attachments', width: 520, body: f.el,
    actions: [
      { label: 'Cancel', kind: 'ghost' },
      { label: 'Remove', kind: 'danger', onClick: async () => {
        const v = f.values();
        app.startJob(new Job({ type: 'bulk', title: `Remove attachments from ${fmtNum(own.length)} message(s)`, params: { action: 'attachments', items: own.map(slimForBulk), attachments: v }, resumable: true, ws: app.ws }));
      } },
    ],
  });
}

export function showBulkReactions(list) {
  const withR = list.filter((m) => m.reactions && m.reactions.length);
  if (!withR.length) return toast('None of these messages have reactions', 'error');
  const f = buildForm([
    { key: 'who', type: 'radio', label: 'Remove', value: 'me', options: [['me', 'My reactions'], ['ids', 'Reactions from specific users (needs Manage Messages)'], ['all', 'All reactions (needs Manage Messages)']] },
    { key: 'ids', type: 'text', label: 'User IDs', when: (v) => v.who === 'ids' },
    { key: 'emoji', type: 'text', label: 'Only this emoji (optional)', placeholder: '👍 or custom emoji name' },
  ]);
  openModal({
    title: `Remove reactions on ${fmtNum(withR.length)} message(s)`, width: 520, body: f.el,
    actions: [
      { label: 'Cancel', kind: 'ghost' },
      { label: 'Remove', kind: 'danger', onClick: async () => {
        const v = f.values();
        const users = v.who === 'all' ? ['*'] : v.who === 'ids' ? parseIdList(v.ids) : ['@me'];
        if (!users.length) { toast('Enter at least one user ID', 'error'); return false; }
        app.startJob(new Job({ type: 'bulk', title: `Remove reactions on ${fmtNum(withR.length)} message(s)`, params: { action: 'reactions', items: withR.map(slimForBulk), reactions: { users, emoji: (v.emoji || '').replace(/:/g, '').trim() } }, resumable: true, ws: app.ws }));
      } },
    ],
  });
}

// ---------------- reactions viewer ----------------
export function showReactions(m) {
  if (!m.reactions || !m.reactions.length) return;
  const ctx = makeContext({ mode: 'export', media: (k, u) => u });
  let active = 0;
  const tabs = h('div', { class: 'react-tabs' });
  const list = h('div', { class: 'react-users' });
  // The conversation the message belongs to: the user may switch conversations while this is open.
  const convKey = app.conv && app.conv.key;
  const emojiKey = (e) => e.id || e.name;
  const refreshMessage = async () => {
    try {
      const fresh = await app.api.fetchMessage(m.channel_id, m.id);
      if (!fresh) return;
      Object.assign(m, fresh);
      if (!fresh.reactions) m.reactions = [];
      if (convKey) await app.ws.putMessages(convKey, [m]);
      if (app.conv && app.conv.key === convKey) feed.render();
    } catch { /* ignore */ }
  };
  const drawTabs = () => fill(tabs, ...m.reactions.map((r, i) => h('button', { class: `react-tab${i === active ? ' on' : ''}`, html: `${emojiHtml(r.emoji, ctx)} <span>${Number(r.count) || 0}</span>`, onclick: () => { active = i; drawTabs(); drawUsers(); } })));
  const drawUsers = async () => {
    const r = m.reactions[active];
    if (!r) { fill(list, h('div', { class: 'muted' }, 'No reactions left.')); return; }
    fill(list, h('div', { class: 'muted' }, 'Loading…'));
    try {
      const users = await app.api.allReactionUsers(m.channel_id, m.id, r.emoji, 0);
      const burst = burstCount(r) ? await app.api.allReactionUsers(m.channel_id, m.id, r.emoji, 1) : [];
      const rows = [...users.map((u) => [u, false]), ...burst.map((u) => [u, true])].map(([u, isBurst]) => h('div', { class: 'react-user' },
        h('img', { class: 'av', src: avatarUrl(u, 32), alt: '' }), h('span', { class: 'strong' }, userName(u)), h('span', { class: 'muted small' }, userTag(u)), isBurst ? h('span', { class: 'tag' }, 'super') : null,
        h('span', { class: 'spacer' }),
        h('button', { class: 'btn sm', onclick: async (e) => {
          e.target.disabled = true;
          try {
            await app.api.deleteReaction(m.channel_id, m.id, r.emoji, app.me && u.id === app.me.id ? '@me' : u.id, undefined, isBurst ? 1 : 0);
            e.target.closest('.react-user').remove();
            await refreshMessage();
            // Keep the same emoji selected; if its last reaction is gone, show the first remaining one.
            const i = m.reactions.findIndex((x) => emojiKey(x.emoji) === emojiKey(r.emoji));
            if (i >= 0) { active = i; drawTabs(); } else { active = 0; drawTabs(); drawUsers(); }
          } catch (err) { toast(err.message, 'error'); e.target.disabled = false; }
        } }, app.me && u.id === app.me.id ? 'Remove mine' : 'Remove')));
      fill(list, ...(rows.length ? rows : [h('div', { class: 'muted' }, 'Nobody (anymore).')]));
    } catch (e) { fill(list, h('div', { class: 'form-note warn' }, e.message)); }
  };
  drawTabs();
  drawUsers();
  openModal({
    title: 'Reactions', width: 520,
    body: h('div', null, tabs, list),
    actions: [
      { label: 'Remove this emoji for everyone', kind: 'ghost', onClick: async () => {
        const r = m.reactions[active];
        if (!r) return false;
        await app.api.deleteEmojiReactions(m.channel_id, m.id, r.emoji);
        await refreshMessage();
        active = 0; drawTabs(); drawUsers();
        return false;
      } },
      { label: 'Remove all reactions', kind: 'danger', onClick: async () => {
        if (!(await confirmDialog({ title: 'Remove all reactions?', message: 'Needs the Manage Messages permission.', confirmLabel: 'Remove all', danger: true }))) return false;
        await app.api.deleteAllReactions(m.channel_id, m.id);
        await refreshMessage();
      } },
    ],
  });
}

// ---------------- misc small dialogs ----------------
export function showImage(url, href) {
  openModal({ title: 'Image', width: 1000, className: 'lightbox', body: h('div', { class: 'lightbox-body' }, h('img', { src: url, alt: '' }), h('a', { href: href || url, target: '_blank', rel: 'noopener noreferrer' }, 'Open original')) });
}

export async function showJump() {
  const v = await promptDialog({ title: 'Jump to message', label: 'Message link or ID', placeholder: 'https://discord.com/channels/…' });
  if (v) app.openLink(v);
}

export async function showLoadThread() {
  const v = await promptDialog({ title: 'Load a thread or forum post', label: 'Thread link or ID', hint: 'Right-click the thread in Discord → Copy Link (or Copy Channel ID with Developer Mode on). Works even if the starter message was deleted.' });
  if (!v) return;
  const p = parseDiscordLink(v);
  const id = p && (p.channelId || p.id);
  if (!id) return toast('That is not a thread link or ID', 'error');
  app.openChannel(id);
}

export async function showOpenDm() {
  const v = await promptDialog({ title: 'Open DM with a user', label: 'User ID', hint: 'Reopens a closed DM so its messages can be loaded, exported or purged. Turn on Developer Mode in Discord to copy user IDs.' });
  if (!v) return;
  if (!isSnowflake(v)) return toast('That is not a user ID', 'error');
  try {
    const ch = await app.api.openDm(v.trim());
    await app.refreshDms();
    app.openChannel(ch.id);
  } catch (e) { app.handleError(e); }
}

export async function showFriends() {
  const body = h('div', { class: 'friends' }, h('div', { class: 'muted' }, 'Loading…'));
  openModal({ title: 'Friends & blocked users', width: 560, body });
  try {
    const rel = await app.api.relationships();
    const groups = [[1, 'Friends'], [2, 'Blocked'], [3, 'Incoming requests'], [4, 'Outgoing requests']];
    fill(body, ...groups.map(([type, label]) => {
      const people = rel.filter((r) => r.type === type);
      if (!people.length) return null;
      return h('div', null, h('div', { class: 'form-section' }, `${label} (${people.length})`), people.map((r) => h('div', { class: 'react-user' },
        h('img', { class: 'av', src: avatarUrl(r.user, 32), alt: '' }), h('span', { class: 'strong' }, r.nickname || userName(r.user)), h('span', { class: 'muted small' }, userTag(r.user)),
        h('span', { class: 'spacer' }),
        h('button', { class: 'btn sm ghost', onclick: () => copyText(r.user.id).then(() => toast('ID copied')) }, 'Copy ID'),
        h('button', { class: 'btn sm', onclick: async () => { try { const ch = await app.api.openDm(r.user.id); await app.refreshDms(); app.openChannel(ch.id); } catch (e) { app.handleError(e); } } }, 'Open DM'))));
    }).filter(Boolean));
    if (!body.childElementCount) body.append(h('div', { class: 'muted' }, 'No relationships found.'));
  } catch (e) { fill(body, h('div', { class: 'form-note warn' }, e.message)); }
}

// ---------------- analytics ----------------
export function showAnalytics({ messages = null, title = null } = {}) {
  const list = messages || app.view;
  if (!list.length) return toast('Load some messages first', 'error');
  const gid = app.conv && app.conv.guildId;
  const members = new Map();
  if (gid) for (const [k, v] of app.members) if (k.startsWith(gid + ':') && v) members.set(k.split(':')[1], v);
  const ctx = makeContext({ mode: 'export', guildId: gid, roles: (gid && app.roles.get(gid)) || new Map(), members, channels: app.channelNames() });
  for (const m of list) {
    if (m.author) ctx.users.set(m.author.id, m.author);
    for (const u of m.mentions || []) ctx.users.set(u.id, u);
  }
  const out = h('div', { class: 'analytics' });
  let includeReplies = true;
  let data;
  const table = (title2, rows, cols) => h('div', { class: 'an-block' }, h('div', { class: 'form-section' }, title2),
    rows.length ? h('table', { class: 'an-table' }, h('tbody', null, rows.slice(0, 25).map((r) => h('tr', null, cols.map((c) => h('td', { class: c.cls || '' }, c.get(r))))))) : h('div', { class: 'muted small' }, 'None'));
  const draw = () => {
    data = computeAnalytics(list, ctx, { includeReplies });
    const max = Math.max(1, ...data.months.map((m) => m.count));
    fill(out, 
      h('div', { class: 'muted' }, `${fmtNum(data.total)} messages${title ? ' · ' + title : app.conv ? ' · ' + app.conv.title : ''} · @everyone ${data.everyone} · @here ${data.here}`),
      h('label', { class: 'toggle' }, h('input', { type: 'checkbox', checked: includeReplies, onchange: (e) => { includeReplies = e.target.checked; draw(); } }), h('span', null, 'Count reply pings as mentions')),
      h('div', { class: 'an-grid' },
        table('Most mentioned people', data.users, [{ get: (r) => r.name }, { get: (r) => r.tag || r.id, cls: 'muted small' }, { get: (r) => fmtNum(r.count), cls: 'num' }]),
        table('Most active authors', data.authors, [{ get: (r) => r.name }, { get: (r) => r.tag, cls: 'muted small' }, { get: (r) => fmtNum(r.count), cls: 'num' }]),
        table('Role mentions', data.roles, [{ get: (r) => '@' + r.name }, { get: (r) => fmtNum(r.count), cls: 'num' }]),
        table('Channel mentions', data.channels, [{ get: (r) => '#' + r.name }, { get: (r) => fmtNum(r.count), cls: 'num' }])),
      h('div', { class: 'form-section' }, 'Messages per month'),
      h('div', { class: 'an-bars' }, data.months.map((m) => h('div', { class: 'an-bar', title: `${m.id}: ${fmtNum(m.count)}` }, h('div', { class: 'an-fill', style: { height: `${(m.count / max) * 100}%` } }), h('span', null, m.id.slice(2))))),
    );
  };
  draw();
  openModal({
    title: 'Analytics', width: 820, body: out,
    actions: [{ label: 'Download CSV', kind: 'primary', onClick: () => { downloadBlob(new Blob([analyticsCsv(data)], { type: 'text/csv' }), `cleancord-analytics-${sanitizeFilename(title || (app.conv && app.conv.title) || 'messages')}.csv`); return false; } }],
  });
}

export { esc, humanBytes, uid, emojiUrl, status };
