// Discord REST client. Every request goes to https://discord.com/api only.
// Media downloads (fetchMedia) go to Discord's CDN and never carry your token.

import { API_BASE, jitterMs, sleep, encodeEmoji } from './util.js';

export class ApiError extends Error {
  constructor(status, body, method, path) {
    const msg = body && body.message ? body.message : `HTTP ${status}`;
    super(`${msg}${body && body.code ? ` (code ${body.code})` : ''}`);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
    this.code = (body && body.code) || 0;
    this.method = method;
    this.path = path;
  }
}
export class AuthError extends ApiError {
  constructor(body, method, path) { super(401, body || { message: 'Not connected to Discord' }, method, path); this.name = 'AuthError'; }
}
export class CancelledError extends Error {
  constructor() { super('Cancelled'); this.name = 'CancelledError'; }
}

// Discord JSON error codes we treat specially.
export const ERR = {
  UNKNOWN_CHANNEL: 10003,
  UNKNOWN_MESSAGE: 10008,
  MISSING_ACCESS: 50001,
  CANNOT_DM: 50007,
  MISSING_PERMISSIONS: 50013,
  SYSTEM_MESSAGE: 50021,
  EMPTY_MESSAGE: 50006,
  ARCHIVED_THREAD: 50083,
  INVALID_CHANNEL_TYPE: 50024,
  THREAD_LOCKED: 160005,
};

// Burst (super) reactions: Discord sends count_details.burst; older payloads also have burst_count / burst_me.
export const burstCount = (r) => (r && (r.burst_count || (r.count_details && r.count_details.burst))) || 0;
export const meBurst = (r) => !!(r && (r.me_burst || r.burst_me));

function toQuery(q) {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(q || {})) {
    if (v == null || v === '') continue;
    if (Array.isArray(v)) v.forEach((x) => x != null && x !== '' && u.append(k, String(x)));
    else u.append(k, String(v));
  }
  return u.toString();
}

async function safeJson(res) {
  try { return await res.json(); } catch { return null; }
}

export async function pausableSleep(ms, job) {
  if (!job) return sleep(ms);
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (job.cancelled) throw new CancelledError();
    await sleep(Math.min(250, end - Date.now()));
  }
}

export function extractSearchHits(res) {
  const out = [];
  for (const group of (res && res.messages) || []) {
    if (!Array.isArray(group)) { if (group) out.push(group); continue; }
    const hit = group.find((m) => m && m.hit) || group[0];
    if (hit) out.push(hit);
  }
  return out;
}

export function createApi({ getAuth, getSettings, log = () => {}, onAuthInvalid = () => {} }) {
  const lastAt = { search: 0, modify: 0 };
  let blockedUntil = 0;

  async function applyDelay(kind, job) {
    const s = getSettings();
    const base = kind === 'search' ? s.searchDelay : kind === 'modify' ? s.modifyDelay : 0;
    if (!base) return;
    const target = jitterMs(base, s.delaySpread);
    const elapsed = Date.now() - lastAt[kind];
    if (elapsed < target) await pausableSleep(target - elapsed, job);
  }

  async function request(method, path, { query, body, job, kind = 'read' } = {}) {
    let url = API_BASE + path;
    const qs = toQuery(query);
    if (qs) url += '?' + qs;
    let attempts = 0;
    let indexWaits = 0;
    for (;;) {
      if (job) await job.gate();
      if (kind !== 'read') await applyDelay(kind, job);
      const wait = blockedUntil - Date.now();
      if (wait > 0) await pausableSleep(wait, job);
      if (job) await job.gate(); // paused during the waits above: don't send one more request

      const auth = await getAuth();
      if (!auth || !auth.token) throw new AuthError(null, method, path);
      const headers = { Authorization: auth.token };
      for (const [k, v] of Object.entries(auth.headers || {})) headers[k] = v;
      if (body !== undefined) headers['Content-Type'] = 'application/json';

      let res;
      try {
        res = await fetch(url, {
          method,
          headers,
          body: body !== undefined ? JSON.stringify(body) : undefined,
          credentials: 'omit',
          cache: 'no-store',
          referrerPolicy: 'no-referrer',
        });
      } catch (e) {
        if (++attempts > 5) throw e;
        log('warn', `Network error (${e.message}); retrying ${attempts}/5`);
        await pausableSleep(1000 * 2 ** attempts, job);
        continue;
      } finally {
        if (kind !== 'read') lastAt[kind] = Date.now();
      }

      const remaining = res.headers.get('x-ratelimit-remaining');
      const resetAfter = parseFloat(res.headers.get('x-ratelimit-reset-after'));
      if (remaining === '0' && resetAfter > 0) blockedUntil = Math.max(blockedUntil, Date.now() + resetAfter * 1000);

      if (res.status === 429) {
        const data = await safeJson(res);
        const ra = Number((data && data.retry_after) ?? res.headers.get('retry-after') ?? 5) || 5;
        log('warn', `Rate limited by Discord, waiting ${ra.toFixed(1)}s`);
        blockedUntil = Math.max(blockedUntil, Date.now() + ra * 1000 + 250);
        continue;
      }
      if (res.status === 202) {
        // Search index is being built for this channel/server.
        const data = await safeJson(res);
        const ra = Math.max(Number(data && data.retry_after) || 2, 1);
        if (++indexWaits > 40) throw new ApiError(202, { message: 'Discord search index is not ready, try again later' }, method, path);
        log('info', `Discord is indexing messages for search, retrying in ${ra}s`);
        await pausableSleep(ra * 1000, job);
        continue;
      }
      if (res.status >= 500) {
        if (++attempts > 5) throw new ApiError(res.status, await safeJson(res), method, path);
        log('warn', `Discord returned ${res.status}; retrying ${attempts}/5`);
        await pausableSleep(1500 * 2 ** attempts, job);
        continue;
      }
      if (res.status === 204) return null;
      const data = await safeJson(res);
      if (res.ok) return data;
      if (res.status === 401) { onAuthInvalid(); throw new AuthError(data, method, path); }
      throw new ApiError(res.status, data, method, path);
    }
  }

  const api = {
    request,
    me: () => request('GET', '/users/@me'),
    guilds: () => request('GET', '/users/@me/guilds', { query: { with_counts: true } }),
    dms: () => request('GET', '/users/@me/channels'),
    relationships: () => request('GET', '/users/@me/relationships'),
    openDm: (userId) => request('POST', '/users/@me/channels', { body: { recipients: [userId] } }),
    guild: (id) => request('GET', `/guilds/${id}`),
    guildChannels: (id) => request('GET', `/guilds/${id}/channels`),
    guildRoles: (id) => request('GET', `/guilds/${id}/roles`),
    guildMember: (gid, uid) => request('GET', `/guilds/${gid}/members/${uid}`),
    guildActiveThreads: (gid) => request('GET', `/guilds/${gid}/threads/active`),
    channel: (id) => request('GET', `/channels/${id}`),
    patchChannel: (id, body, job) => request('PATCH', `/channels/${id}`, { body, job, kind: 'modify' }),
    archivedThreads: (cid, kind, before, job) =>
      request('GET', `/channels/${cid}/threads/archived/${kind}`, { query: { limit: 100, before }, job }),
    // Private archived threads you're a member of (the plain private list needs Manage Threads). `before` is a thread id.
    joinedArchivedThreads: (cid, before, job) =>
      request('GET', `/channels/${cid}/users/@me/threads/archived/private`, { query: { limit: 100, before }, job }),
    threadSearch: (cid, { archived, offset = 0 }, job) =>
      request('GET', `/channels/${cid}/threads/search`, {
        query: { archived, sort_by: 'last_message_time', sort_order: 'desc', limit: 25, offset },
        job,
      }),
    messages: (cid, { before, after, around, limit = 100 } = {}, job) =>
      request('GET', `/channels/${cid}/messages`, { query: { before, after, around, limit }, job }),
    search: (scope, query, job) =>
      request('GET', scope.guildId ? `/guilds/${scope.guildId}/messages/search` : `/channels/${scope.channelId}/messages/search`, {
        query, job, kind: 'search',
      }),
    deleteMessage: (cid, mid, job) => request('DELETE', `/channels/${cid}/messages/${mid}`, { job, kind: 'modify' }),
    editMessage: (cid, mid, body, job) => request('PATCH', `/channels/${cid}/messages/${mid}`, { body, job, kind: 'modify' }),
    reactionUsers: (cid, mid, emoji, { after, type = 0 } = {}, job) =>
      request('GET', `/channels/${cid}/messages/${mid}/reactions/${encodeEmoji(emoji)}`, { query: { limit: 100, after, type }, job }),
    // type 1 = burst (super) reaction; those can only be removed with the reaction type in the path.
    deleteReaction: (cid, mid, emoji, userId = '@me', job, type = 0) =>
      request('DELETE', `/channels/${cid}/messages/${mid}/reactions/${encodeEmoji(emoji)}/${type ? `${type}/` : ''}${userId}`, { job, kind: 'modify' }),
    deleteEmojiReactions: (cid, mid, emoji, job) =>
      request('DELETE', `/channels/${cid}/messages/${mid}/reactions/${encodeEmoji(emoji)}`, { job, kind: 'modify' }),
    deleteAllReactions: (cid, mid, job) => request('DELETE', `/channels/${cid}/messages/${mid}/reactions`, { job, kind: 'modify' }),
    refreshAttachmentUrls: (urls, job) => request('POST', '/attachments/refresh-urls', { body: { attachment_urls: urls }, job }),
  };

  // Fetch one message by id (users can't call GET /channels/:id/messages/:id, so use ?around).
  api.fetchMessage = async (cid, mid, job) => {
    const list = await api.messages(cid, { around: mid, limit: 5 }, job);
    return (list || []).find((m) => m.id === mid) || null;
  };

  // List every user who reacted with an emoji (both normal and super reactions).
  api.allReactionUsers = async (cid, mid, emoji, type = 0, job) => {
    const out = [];
    let after;
    for (;;) {
      const page = await api.reactionUsers(cid, mid, emoji, { after, type }, job);
      if (!page || !page.length) break;
      out.push(...page);
      if (page.length < 100) break;
      after = page[page.length - 1].id;
    }
    return out;
  };

  return api;
}

// Download from Discord's CDN. No Authorization header, no cookies.
export async function fetchMedia(url, { signal } = {}) {
  const res = await fetch(url, { credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store', signal });
  return res;
}
