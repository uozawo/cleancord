// Cleancord app entry point: connection, data loading, jobs, and glue between UI modules.

import { app } from './state.js';
import { S, loadSettings, onSettings } from './settings.js';
import { createApi, ApiError, pausableSleep } from './api.js';
import { Workspace, listWorkspaces, saveWorkspaceList } from './db.js';
import { Job, JobManager } from './jobs.js';
import { createPurgeHandler } from './purge.js';
import { createBulkHandler } from './bulk.js';
import { createExportHandler } from './export/exporter.js';
import { FolderSink } from './export/sinks.js';
import { loadHistory, loadNewer, loadSearch, listThreads } from './discord.js';
import { describeCriteria } from './criteria.js';
import {
  dmName, cmpId, isThread, sleep, jitterMs, minOfIds, maxOfIds, CHANNEL, parseDiscordLink, uid,
} from './util.js';
import * as sidebar from './ui/sidebar.js';
import * as feed from './ui/feed.js';
import * as status from './ui/status.js';
import * as dialogs from './ui/dialogs.js';
import { toast } from './ui/dom.js';

// ---------------- logging ----------------
app.log = (level, msg) => {
  const line = { t: Date.now(), level, msg: String(msg) };
  app.logLines.push(line);
  if (app.logLines.length > 1000) app.logLines.splice(0, app.logLines.length - 1000);
  status.appendLog(line);
};

// ---------------- auth ----------------
let authCache;
async function getAuth() {
  if (authCache !== undefined) return authCache;
  const { manualAuth, capturedAuth } = await chrome.storage.session.get(['manualAuth', 'capturedAuth']);
  authCache = manualAuth || capturedAuth || null;
  app.authSource = manualAuth ? 'manual' : capturedAuth ? 'auto' : null;
  return authCache;
}
app.getAuth = getAuth;
app.setManualToken = async (token) => {
  token = String(token || '').trim().replace(/^"|"$/g, '');
  if (!token) return;
  await chrome.storage.session.set({ manualAuth: { token, headers: {}, at: Date.now() } });
};
app.useAutoToken = async () => { await chrome.storage.session.remove('manualAuth'); };
app.forgetSession = async () => {
  await chrome.storage.session.remove(['manualAuth', 'capturedAuth']);
  authCache = null;
  app.me = null;
  app.guilds = [];
  app.dms = [];
  sidebar.render();
  status.renderAccount();
};

// The background refreshes the captured session about once a minute while a Discord tab is open.
// Only reconnect (and redraw the sidebar) when the token actually changed, e.g. another account.
let connectedToken = null;
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'session' || (!changes.capturedAuth && !changes.manualAuth)) return;
  authCache = undefined;
  getAuth().then((a) => {
    if (((a && a.token) || null) !== connectedToken) connect();
  });
});

// ---------------- Discord data ----------------
app.connect = connect;
let lastMeId = null;
let connectSeq = 0;
async function connect() {
  // A newer connect (the session changed meanwhile) wins; an older one must not overwrite its results.
  const seq = ++connectSeq;
  const auth = await getAuth();
  if (seq !== connectSeq) return false;
  connectedToken = (auth && auth.token) || null;
  status.renderAccount();
  if (!auth) {
    app.me = null;
    sidebar.render();
    feed.refresh();
    return false;
  }
  try {
    const me = await app.api.me();
    if (seq !== connectSeq) return false;
    app.me = me;
    if (lastMeId && lastMeId !== app.me.id) {
      // Another account: channel lists, threads and roles cached for the previous one don't apply.
      app.channels.clear();
      app.guildChannels.clear();
      app.threadsByParent.clear();
      app.roles.clear();
      app.sidebar.checked.clear();
      app.sidebar.guildId = '@me';
    }
    lastMeId = app.me.id;
    status.renderAccount();
    app.log('ok', `Connected as ${app.me.global_name || app.me.username}`);
    const [guilds, dms] = await Promise.all([app.api.guilds(), app.api.dms()]);
    if (seq !== connectSeq) return false;
    app.guilds = guilds || [];
    setDms(dms || []);
    sidebar.render();
    feed.refresh();
    handleHash().catch(handleError);
    return true;
  } catch (e) {
    if (seq !== connectSeq) return false;
    app.me = null;
    status.renderAccount();
    sidebar.render();
    if (e.name === 'AuthError') app.log('error', 'Discord rejected the session. Open discord.com in this browser (and log in), or paste a token in the account menu.');
    else app.log('error', `Could not connect: ${e.message}`);
    return false;
  }
}

function setDms(dms) {
  app.dms = dms.sort((a, b) => cmpId(b.last_message_id || b.id, a.last_message_id || a.id));
  for (const c of app.dms) app.channels.set(c.id, { ...c, name: dmName(c, app.me && app.me.id) });
}
app.refreshDms = async () => { setDms((await app.api.dms()) || []); sidebar.render(); };

app.loadGuildChannels = async (gid, force = false) => {
  if (!force && app.guildChannels.has(gid)) return app.guildChannels.get(gid);
  const list = await app.api.guildChannels(gid);
  for (const c of list) { c.guild_id = gid; app.channels.set(c.id, c); }
  app.guildChannels.set(gid, list);
  app.getRoles(gid).catch(() => {});
  return list;
};

app.loadThreads = async (parent) => {
  const threads = await listThreads(app.api, parent, null, app.log);
  for (const t of threads) { t.guild_id = t.guild_id || parent.guild_id; app.channels.set(t.id, t); }
  app.threadsByParent.set(parent.id, threads);
  return threads;
};

app.getRoles = async (gid) => {
  if (app.roles.has(gid)) return app.roles.get(gid);
  let roles = [];
  try { roles = await app.api.guildRoles(gid); } catch {
    try { roles = ((await app.api.guild(gid)) || {}).roles || []; } catch { roles = []; }
  }
  const map = new Map((roles || []).map((r) => [r.id, r]));
  app.roles.set(gid, map);
  return map;
};

let memberChain = Promise.resolve();
app.getMembers = (gid, ids, job) => {
  const run = async () => {
    const out = new Map();
    const ttl = (Number(S.memberCacheHours) || 24) * 3600 * 1000;
    for (const id of ids) {
      const k = `${gid}:${id}`;
      if (app.members.has(k)) { out.set(id, app.members.get(k)); continue; }
      const cached = app.ws ? await app.ws.getUser('m:' + k) : null;
      if (cached && Date.now() - cached.at < ttl) { app.members.set(k, cached.value); out.set(id, cached.value); continue; }
      if (!S.lookupMembers) continue;
      if (job) await job.gate();
      let mem = null;
      try {
        const m = await app.api.guildMember(gid, id);
        mem = m ? { nick: m.nick || null, roles: m.roles || [], avatar: m.avatar || null } : null;
      } catch (e) {
        if (e.name === 'CancelledError' || e.name === 'AuthError') throw e;
        mem = null;
      }
      app.members.set(k, mem);
      if (app.ws) await app.ws.putUser('m:' + k, mem);
      out.set(id, mem);
      await sleep(120);
    }
    return out;
  };
  const p = memberChain.then(run, run);
  memberChain = p.catch(() => {});
  return p;
};

app.channelName = (id) => {
  const c = app.channels.get(id);
  return c ? c.name || dmName(c, app.me && app.me.id) : (app.conv && app.conv.threads || []).find((t) => t.id === id)?.name || id;
};
app.channelNames = () => {
  const m = new Map();
  for (const [id, c] of app.channels) m.set(id, c.name || dmName(c, app.me && app.me.id));
  for (const t of (app.conv && app.conv.threads) || []) if (!m.has(t.id)) m.set(t.id, t.name);
  return m;
};

app.fetchChannel = async (id) => {
  if (app.channels.has(id)) return app.channels.get(id);
  const c = await app.api.channel(id);
  if (c.type === CHANNEL.DM || c.type === CHANNEL.GROUP_DM) c.name = dmName(c, app.me && app.me.id);
  app.channels.set(c.id, c);
  return c;
};

app.guildName = (gid) => (app.guilds.find((g) => g.id === gid) || {}).name || 'Server';

// ---------------- conversations ----------------
function sortAsc(list) { return list.sort((a, b) => cmpId(a.id, b.id)); }

app.mergeMessages = (list, { replace = false } = {}) => {
  if (!list || !list.length) return;
  const byId = new Map(app.messages.map((m) => [m.id, m]));
  for (const m of list) {
    const prev = byId.get(m.id);
    byId.set(m.id, prev && !replace ? { ...prev, ...m } : m);
  }
  app.messages = sortAsc([...byId.values()]);
};

let convSeq = 0;
let loadingOlder = null; // key of the conversation whose older messages are being fetched
// Resolves false when another conversation was opened while this one's messages were being read.
app.setConversation = async (conv, { page = -1 } = {}) => {
  const seq = ++convSeq;
  const messages = conv ? await app.ws.getMessages(conv.key) : [];
  if (seq !== convSeq) return false;
  app.conv = conv;
  app.messages = messages;
  app.selected.clear();
  app.page = page;
  feed.resetFilters(false);
  feed.refresh();
  feed.setBusy(!!conv && loadingOlder === conv.key);
  sidebar.highlight();
  return true;
};

function convTitleFor(ch) {
  if (ch.type === CHANNEL.DM || ch.type === CHANNEL.GROUP_DM) return ch.name || dmName(ch, app.me && app.me.id);
  return `#${ch.name}`;
}

app.openChannel = async (chOrId, { jumpTo } = {}) => {
  let ch = chOrId;
  try {
    if (typeof ch === 'string') ch = await app.fetchChannel(ch);
  } catch (e) {
    toast(`Can't open that channel: ${e.message}`, 'error');
    return;
  }
  if (ch.type === CHANNEL.FORUM || ch.type === CHANNEL.MEDIA || ch.type === CHANNEL.CATEGORY) {
    sidebar.expandThreads(ch);
    return;
  }
  const key = `ch:${ch.id}`;
  let conv = await app.ws.getConv(key);
  const subtitle = ch.guild_id ? app.guildName(ch.guild_id) : (ch.type === CHANNEL.GROUP_DM ? 'Group DM' : 'Direct message');
  conv = { key, kind: 'channel', count: 0, ...(conv || {}), title: convTitleFor(ch), subtitle, guildId: ch.guild_id || null, channelId: ch.id, channelType: ch.type };
  await app.ws.putConv(conv);
  if (!(await app.setConversation(conv))) return; // the user opened something else meanwhile
  if (ch.guild_id) app.getRoles(ch.guild_id).then(() => feed.render()).catch(() => {});
  if (!app.messages.length) await app.loadOlder();
  else app.loadNewer(true).catch(() => {});
  if (jumpTo && app.conv && app.conv.key === key) feed.jumpTo(jumpTo);
};

app.openSavedConversation = async (key) => {
  const conv = await app.ws.getConv(key);
  if (!conv) return toast('That conversation is no longer saved', 'error');
  await app.setConversation(conv);
};

// The user can switch conversations while a page is in flight: only touch app.messages / app.conv while
// `conv` is still the open one, and don't let one conversation's request block loading another.
app.loadOlder = async () => {
  const conv = app.conv;
  if (!conv || loadingOlder === conv.key) return;
  loadingOlder = conv.key;
  feed.setBusy(true);
  const isCurrent = () => app.conv && app.conv.key === conv.key;
  const onPage = (list) => { if (isCurrent()) app.mergeMessages(list); };
  try {
    if (conv.kind === 'channel') {
      await loadHistory({ api: app.api, ws: app.ws, job: null, convKey: conv.key, channelId: conv.channelId, maxPages: 1, onPage });
    } else if (conv.kind === 'search') {
      await loadSearch({ api: app.api, ws: app.ws, job: null, convKey: conv.key, maxPages: 1, onPage });
    }
    if (isCurrent()) {
      const fresh = await app.ws.getConv(conv.key);
      if (fresh && isCurrent()) {
        app.conv = fresh;
        feed.refresh({ keepPage: true, anchorOldest: true });
      }
    }
  } catch (e) {
    if (isCurrent()) handleError(e);
  } finally {
    if (loadingOlder === conv.key) {
      loadingOlder = null;
      feed.setBusy(false);
    }
  }
};

app.loadNewer = async (quiet = false) => {
  const conv = app.conv;
  if (!conv || conv.kind !== 'channel' || !conv.newestId) return;
  const isCurrent = () => app.conv && app.conv.key === conv.key;
  try {
    const before = app.messages.length;
    await loadNewer({ api: app.api, ws: app.ws, job: null, convKey: conv.key, channelId: conv.channelId });
    if (!isCurrent()) return;
    const [fresh, messages] = await Promise.all([app.ws.getConv(conv.key), app.ws.getMessages(conv.key)]);
    if (!fresh || !isCurrent()) return; // switched conversations while reading
    app.conv = fresh;
    app.messages = messages;
    if (app.messages.length !== before) feed.refresh({ keepPage: true });
    else if (!quiet) toast('Already up to date');
  } catch (e) {
    if (!quiet) handleError(e);
  }
};

app.loadAll = () => {
  const conv = app.conv;
  if (!conv) return;
  const job = new Job({ type: 'loadAll', title: `Load all: ${conv.title}`, params: { convKey: conv.key }, resumable: true, ws: app.ws });
  return app.jobs.start(job).catch(handleError);
};

app.runSearch = async ({ criteria, scope, channelIds, label }) => {
  const key = 'search:' + uid();
  const conv = {
    key, kind: 'search', title: `Search: ${describeCriteria(criteria)}`, subtitle: label,
    scope, criteria, channelIds: channelIds || null, guildId: scope.guildId || null,
    channelId: scope.channelId || (channelIds && channelIds.length === 1 ? channelIds[0] : null),
    count: 0, cursor: null, complete: false, total: null,
  };
  await app.ws.putConv(conv);
  if (await app.setConversation(conv)) await app.loadOlder();
};

app.removeConversation = async (key) => {
  await app.ws.deleteConv(key);
  if (app.conv && app.conv.key === key) await app.setConversation(null);
  sidebar.render();
};

// Called by jobs when Discord confirms a change.
let refreshTimer = null;
const scheduleRefresh = () => {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => feed.refresh({ keepPage: true }), 400);
};
function onDeleted(m) {
  const i = app.messages.findIndex((x) => x.id === m.id);
  if (i >= 0) { app.messages.splice(i, 1); scheduleRefresh(); }
  app.selected.delete(m.id);
  const keys = new Set([`ch:${m.channel_id}`, `pkg:${m.channel_id}`]);
  if (app.conv) keys.add(app.conv.key);
  for (const k of keys) app.ws.deleteMessages(k, [m.id]).catch(() => {});
}
function onUpdated(m) {
  const i = app.messages.findIndex((x) => x.id === m.id);
  // Capture now: by the time the writes below run, app.messages / app.conv may have changed.
  const merged = i >= 0 ? { ...app.messages[i], ...m } : m;
  const curKey = i >= 0 && app.conv ? app.conv.key : null;
  if (i >= 0) { app.messages[i] = merged; scheduleRefresh(); }
  const keys = new Set([`ch:${m.channel_id}`]);
  if (curKey) keys.add(curKey);
  for (const k of keys) {
    app.ws.getConv(k).then((c) => { if (c) return app.ws.putMessages(k, [k === curKey ? merged : m]); }).catch(() => {});
  }
}
async function onReactionsChanged(m) {
  if (!app.messages.some((x) => x.id === m.id)) return; // not on screen; skip the extra request
  try {
    const fresh = await app.api.fetchMessage(m.channel_id, m.id);
    // Discord leaves `reactions` out once none are left; without this the merge in onUpdated keeps the old ones.
    if (fresh) onUpdated({ ...fresh, reactions: fresh.reactions || [] });
  } catch { /* ignore */ }
}

function handleError(e) {
  if (!e || e.name === 'CancelledError') return;
  if (e.name === 'AuthError') { status.renderAccount(); toast('Not connected to Discord. Open discord.com in this browser, or set a token.', 'error'); return; }
  const msg = e instanceof ApiError && e.status === 403 ? `No access: ${e.message}` : e.message;
  app.log('error', msg);
  toast(msg, 'error');
}
app.handleError = handleError;

// ---------------- jobs ----------------
let cssCache = null;
const deps = {
  get api() { return app.api; },
  get ws() { return app.ws; },
  log: (l, m) => app.log(l, m),
  meId: () => app.me && app.me.id,
  channel: (id) => app.channels.get(id),
  channelName: (id) => app.channelName(id),
  channelNames: () => app.channelNames(),
  onDeleted, onUpdated, onReactionsChanged,
  getRoles: (gid) => app.getRoles(gid),
  getMembers: (gid, ids, job) => app.getMembers(gid, ids, job),
  settings: () => S,
  cssText: async () => (cssCache ??= await (await fetch(chrome.runtime.getURL('src/message.css'))).text()),
};

function registerHandlers() {
  const jm = app.jobs;
  jm.register('purge', createPurgeHandler(deps));
  jm.register('bulk', createBulkHandler(deps));
  jm.register('export', createExportHandler(deps));
  jm.register('loadAll', async (job) => {
    const conv = await app.ws.getConv(job.params.convKey);
    if (!conv) throw new Error('Conversation was removed');
    const isCurrent = () => app.conv && app.conv.key === conv.key;
    const onPage = (list, c) => {
      job.setProgress(c.count || 0, c.total || 0, `${c.count || 0} messages loaded`);
      if (isCurrent()) { app.mergeMessages(list); app.conv = c; scheduleRefresh(); }
    };
    if (conv.kind === 'channel') {
      await loadHistory({ api: app.api, ws: app.ws, job, convKey: conv.key, channelId: conv.channelId, onPage });
    } else if (conv.kind === 'search') {
      await loadSearch({ api: app.api, ws: app.ws, job, convKey: conv.key, maxPages: Infinity, onPage });
    }
    const done = await app.ws.getConv(conv.key);
    done.complete = true;
    await app.ws.putConv(done);
    if (isCurrent()) { app.conv = done; scheduleRefresh(); }
  });
  jm.register('pkgFetch', runPackageFetch);
}

// Fill in reactions, edits and replies for data-package messages by asking Discord (cached).
async function runPackageFetch(job) {
  const { convKey } = job.params;
  const S2 = job.state;
  S2.done ??= [];
  const msgs = (await app.ws.getMessages(convKey)).filter((m) => m._package && !m._fetched && !m._deleted && !m._noAccess);
  const doneSet = new Set(S2.done);
  const todo = msgs.filter((m) => !doneSet.has(m.id));
  const byId = new Map(todo.map((m) => [m.id, m]));
  let processed = 0;
  const total = todo.length;
  const save = async (list) => {
    await app.ws.putMessages(convKey, list);
    if (app.conv && app.conv.key === convKey) { app.mergeMessages(list, { replace: true }); scheduleRefresh(); }
  };
  for (const m of todo) {
    if (!byId.has(m.id)) continue;
    await job.gate();
    const cached = await app.ws.getPkgCache(m.id);
    if (cached) {
      byId.delete(m.id);
      processed++;
      await save([cached.value ? { ...cached.value, _package: true, _fetched: true } : { ...m, _deleted: true }]);
      continue;
    }
    let window;
    try {
      window = await app.api.messages(m.channel_id, { around: m.id, limit: 100 }, job);
    } catch (e) {
      if (e.name === 'CancelledError' || e.name === 'AuthError') throw e;
      if (e instanceof ApiError && (e.status === 403 || e.status === 404)) {
        const rest = [...byId.values()].filter((x) => x.channel_id === m.channel_id).map((x) => ({ ...x, _noAccess: true }));
        for (const x of rest) byId.delete(x.id);
        await save(rest);
        app.log('warn', 'No access to this channel any more; marked its messages as unreachable.');
        processed += rest.length;
        continue;
      }
      throw e;
    }
    const got = new Map((window || []).map((x) => [x.id, x]));
    const ids = (window || []).map((x) => x.id);
    const lo = ids.length ? minOfIds(ids) : m.id;
    const hi = ids.length ? maxOfIds(ids) : m.id;
    const updates = [];
    for (const x of [...byId.values()]) {
      if (x.channel_id !== m.channel_id) continue;
      if (cmpId(x.id, lo) < 0 || cmpId(x.id, hi) > 0) continue;
      const real = got.get(x.id);
      updates.push(real ? { ...real, _package: true, _fetched: true } : { ...x, _deleted: true });
      await app.ws.putPkgCache(x.id, real || null);
      byId.delete(x.id);
      S2.done.push(x.id);
    }
    if (!updates.find((u) => u.id === m.id)) { updates.push({ ...m, _deleted: true }); byId.delete(m.id); }
    await save(updates);
    processed += updates.length;
    job.setProgress(processed, total, `${processed}/${total} checked`);
    await job.save();
    await pausableSleep(jitterMs(Math.max(0.3, S.searchDelay / 2), S.delaySpread), job);
  }
  app.log('ok', 'Finished fetching details from Discord.');
}

app.startJob = (job) => app.jobs.start(job).catch(handleError);

app.resumeJob = async (saved) => {
  const jm = app.jobs;
  if ((jm.current && jm.current.id === saved.id) || jm.queue.some((q) => q.job.id === saved.id)) return; // already resumed
  const job = new Job({ ...saved, resumable: true, ws: app.ws });
  if (saved.type === 'export') {
    const dir = saved.params.dirHandle;
    if (!dir || typeof dir.requestPermission !== 'function') {
      // ZIP exports have no folder; tasks imported from another browser lost theirs.
      toast('This export can’t be resumed (ZIP exports and exports from another browser); start the export again.', 'error');
      return;
    }
    if ((await dir.requestPermission({ mode: 'readwrite' })) !== 'granted') return toast('Folder permission was not granted', 'error');
    job.runtime = { sink: new FolderSink(dir) };
  }
  // Keep the saved checkpoint: if this waits in the queue and Cleancord is closed, the task must still be resumable.
  // The job overwrites it (same id) when it runs, and deletes it when it finishes or is stopped.
  app.startJob(job);
  sidebar.render();
};

// ---------------- workspaces ----------------
app.switchWorkspace = async (name) => {
  if (app.jobs && (app.jobs.current || app.jobs.queue.length)) return toast('Wait for running tasks to finish first', 'error');
  if (app.ws) app.ws.close();
  app.ws = await Workspace.open(name);
  const { workspaces } = await listWorkspaces();
  if (!workspaces.includes(name)) workspaces.push(name);
  await saveWorkspaceList(workspaces, name);
  registerHandlers();
  app.members.clear();
  await app.setConversation(null);
  // Remove leftovers of exports that were interrupted.
  const jobs = await app.ws.listJobs();
  const live = new Set(jobs.map((j) => j.id));
  for (const c of await app.ws.listConvs()) {
    if (c.key.startsWith('exp:') && !live.has(c.key.split(':')[1])) await app.ws.deleteConv(c.key);
  }
  status.renderWorkspace();
  sidebar.render();
  if (jobs.length) toast(`${jobs.length} unfinished task(s) can be resumed from the Tasks tab.`, 'info', 6000);
};

// ---------------- routing ----------------
async function handleHash() {
  const m = /#open=([^/]+)\/(\d*)(?:\/(\d+))?/.exec(location.hash);
  if (!m || !app.me) return;
  // Don't switch conversations under an open dialog (e.g. Export reads the open conversation).
  if (document.querySelector('.modal-overlay')) {
    if (!handleHash.waiting) {
      handleHash.waiting = true;
      toast('Close this dialog to open the conversation from Discord.');
      const timer = setInterval(() => {
        if (document.querySelector('.modal-overlay')) return;
        clearInterval(timer);
        handleHash.waiting = false;
        handleHash().catch(handleError);
      }, 400);
    }
    return;
  }
  history.replaceState(null, '', location.pathname);
  const [, guild, channel, message] = m;
  if (guild !== '@me') {
    app.sidebar.guildId = guild;
    app.sidebar.tab = 'chats';
    await sidebar.selectGuild(guild);
  } else {
    app.sidebar.guildId = '@me';
    sidebar.render();
  }
  if (channel) await app.openChannel(channel, { jumpTo: message || null });
}
app.openLink = async (link) => {
  const p = parseDiscordLink(link);
  if (!p) return toast('That is not a Discord message link or ID', 'error');
  if (p.channelId) {
    if (p.guildId) await sidebar.selectGuild(p.guildId);
    await app.openChannel(p.channelId, { jumpTo: p.messageId });
  } else if (p.id) {
    feed.jumpTo(p.id);
  }
};

// ---------------- boot ----------------
async function boot() {
  await loadSettings();
  status.applyTheme();
  onSettings(() => { status.applyTheme(); feed.render(); });
  app.api = createApi({
    getAuth,
    getSettings: () => S,
    log: (l, m) => app.log(l, m),
    onAuthInvalid: () => { status.renderAccount(true); },
  });
  app.jobs = new JobManager({ log: (l, m) => app.log(l, m) });
  status.mount();
  sidebar.mount();
  feed.mount();
  dialogs.mount();
  app.jobs.on(() => { status.renderJob(); sidebar.renderJobsIfVisible(); });
  const { current } = await listWorkspaces();
  await app.switchWorkspace(current);
  status.updateStorage();
  setInterval(status.updateStorage, 30_000);
  const ok = await connect();
  window.addEventListener('hashchange', () => handleHash().catch(handleError));
  window.addEventListener('beforeunload', (e) => {
    if (app.jobs.current) { e.preventDefault(); e.returnValue = ''; }
  });
  if (!ok && !(await getAuth())) dialogs.showConnectHelp();
}

boot().catch((e) => {
  console.error(e);
  document.body.append(Object.assign(document.createElement('pre'), { className: 'fatal', textContent: `Cleancord failed to start:\n${e.stack || e}` }));
});
