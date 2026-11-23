// Higher-level Discord helpers: thread discovery and loading history / search pages into the workspace.

import { extractSearchHits } from './api.js';
import { cmpId, minOfIds, maxOfIds, decId, MESSAGEABLE, THREAD_PARENTS } from './util.js';
import { buildSearchQuery } from './criteria.js';

// All threads (active + archived, public + private where allowed) under a parent channel.
export async function listThreads(api, parent, job, log = () => {}) {
  const out = new Map();
  for (const kind of ['public', 'private']) {
    let before;
    for (let i = 0; i < 100; i++) {
      let res;
      try { res = await api.archivedThreads(parent.id, kind, before, job); } catch (e) { if (e.name === 'CancelledError') throw e; break; }
      const threads = (res && res.threads) || [];
      for (const t of threads) out.set(t.id, t);
      if (!res || !res.has_more || !threads.length) break;
      const last = threads[threads.length - 1];
      before = last.thread_metadata && last.thread_metadata.archive_timestamp;
      if (!before) break;
    }
  }
  // Private archived threads you're in: the list above needs Manage Threads, this one doesn't.
  {
    let before;
    for (let i = 0; i < 100; i++) {
      let res;
      try { res = await api.joinedArchivedThreads(parent.id, before, job); } catch (e) { if (e.name === 'CancelledError') throw e; break; }
      const threads = (res && res.threads) || [];
      for (const t of threads) out.set(t.id, t);
      if (!res || !res.has_more || !threads.length) break;
      before = minOfIds(threads.map((t) => t.id));
    }
  }
  // The search endpoint the Discord client uses also lists active threads / forum posts.
  for (const archived of [false, true]) {
    let offset = 0;
    for (let i = 0; i < 80; i++) {
      let res;
      try { res = await api.threadSearch(parent.id, { archived, offset }, job); } catch (e) { if (e.name === 'CancelledError') throw e; break; }
      const threads = (res && res.threads) || [];
      for (const t of threads) out.set(t.id, t);
      if (!res || !res.has_more || !threads.length) break;
      offset += threads.length;
    }
  }
  return [...out.values()].sort((a, b) => cmpId(b.id, a.id));
}

export async function listGuildActiveThreads(api, guildId) {
  try {
    const r = await api.guildActiveThreads(guildId);
    return (r && r.threads) || [];
  } catch { return []; }
}

export const isMessageable = (c) => MESSAGEABLE.has(c.type);
export const canHaveThreads = (c) => THREAD_PARENTS.has(c.type);

// Page backwards through a channel's history into a workspace conversation.
// Resumable: the cursor lives in conv.cursors[channelId].
export async function loadHistory({ api, ws, job, convKey, channelId, minId = null, maxId = null, filter = null, maxPages = Infinity, onPage = null }) {
  let conv = await ws.getConv(convKey);
  if (!conv) throw new Error('Conversation missing');
  conv.cursors ||= {};
  conv.doneChannels ||= {};
  if (conv.doneChannels[channelId]) return 0;
  let before = conv.cursors[channelId] || maxId || undefined;
  let added = 0;
  for (let p = 0; p < maxPages; p++) {
    const page = await api.messages(channelId, { before, limit: 100 }, job);
    // It may have been removed from the Saved tab while we waited; don't bring it back.
    const cur = await ws.getConv(convKey);
    if (!cur) throw new Error('Conversation was removed');
    if (!page || !page.length) {
      // Save it, or an empty channel (or one with an exact multiple of 100 messages) never counts as fully loaded.
      cur.doneChannels = { ...(cur.doneChannels || {}), [channelId]: true };
      await ws.putConv(cur);
      break;
    }
    let reachedMin = false;
    const keep = [];
    for (const m of page) {
      if (minId && cmpId(m.id, minId) <= 0) { reachedMin = true; continue; }
      if (!filter || filter(m)) keep.push(m);
    }
    await ws.putMessages(convKey, keep);
    added += keep.length;
    before = minOfIds(page.map((m) => m.id));
    conv = (await ws.getConv(convKey)) || conv;
    conv.cursors ||= {};
    conv.doneChannels ||= {};
    conv.cursors[channelId] = before;
    conv.count = await ws.countMessages(convKey);
    if (keep.length) {
      const lo = minOfIds(keep.map((m) => m.id));
      const hi = maxOfIds(keep.map((m) => m.id));
      if (!conv.oldestId || cmpId(lo, conv.oldestId) < 0) conv.oldestId = lo;
      if (!conv.newestId || cmpId(hi, conv.newestId) > 0) conv.newestId = hi;
    }
    if (page.length < 100 || reachedMin) conv.doneChannels[channelId] = true;
    await ws.putConv(conv);
    if (onPage) await onPage(keep, conv);
    if (conv.doneChannels[channelId]) break;
  }
  return added;
}

// Fetch messages newer than the newest one we have.
export async function loadNewer({ api, ws, job, convKey, channelId }) {
  let conv = await ws.getConv(convKey);
  if (!conv) return 0;
  let after = conv.newestId;
  let added = 0;
  if (!after) return 0;
  for (let i = 0; i < 1000; i++) {
    const page = await api.messages(channelId, { after, limit: 100 }, job);
    if (!page || !page.length) break;
    await ws.putMessages(convKey, page);
    added += page.length;
    after = maxOfIds(page.map((m) => m.id));
    conv = await ws.getConv(convKey);
    if (!conv) throw new Error('Conversation was removed');
    conv.newestId = after;
    conv.count = await ws.countMessages(convKey);
    await ws.putConv(conv);
    if (page.length < 100) break;
  }
  return added;
}

// Load search result pages (newest first) using a max_id cursor so Discord's offset cap never applies.
export async function loadSearch({ api, ws, job, convKey, maxPages = 1, onPage = null }) {
  let conv = await ws.getConv(convKey);
  if (!conv) throw new Error('Conversation was removed');
  const base = buildSearchQuery(conv.criteria, { channelIds: conv.channelIds });
  let added = 0;
  let stuck = 0;
  for (let p = 0; p < maxPages && !conv.complete; p++) {
    const q = { ...base, sort_by: 'timestamp', sort_order: 'desc' };
    if (conv.cursor) q.max_id = base.max_id && cmpId(base.max_id, conv.cursor) < 0 ? base.max_id : conv.cursor;
    const res = await api.search(conv.scope, q, job);
    const hits = extractSearchHits(res);
    conv = await ws.getConv(convKey);
    if (!conv) throw new Error('Conversation was removed');
    if (conv.total == null || conv.total < (res.total_results || 0)) conv.total = res.total_results || 0;
    if (res.threads) conv.threads = [...(conv.threads || []), ...res.threads].slice(-500);
    if (!hits.length) { conv.complete = true; await ws.putConv(conv); break; }
    const existing = new Set(conv.seenTail || []);
    const fresh = hits.filter((m) => !existing.has(m.id));
    await ws.putMessages(convKey, fresh);
    added += fresh.length;
    conv.count = await ws.countMessages(convKey);
    const lo = minOfIds(hits.map((m) => m.id));
    if (!fresh.length) {
      if (++stuck > 2) conv.complete = true;
      conv.cursor = decId(lo);
    } else {
      stuck = 0;
      conv.cursor = lo;
    }
    conv.seenTail = hits.map((m) => m.id);
    // Everything Discord reported is loaded: no need to show "Load more results".
    if (conv.total != null && conv.count >= conv.total) conv.complete = true;
    await ws.putConv(conv);
    if (onPage) await onPage(fresh, conv);
  }
  return added;
}
