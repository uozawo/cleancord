// Purge: delete messages, strip attachments, or remove reactions across DMs, channels, threads and whole servers.
// Search-based by default (fast), with an optional full-history scan, a final pass over the newest messages
// (Discord's search index lags), and automatic unarchive / re-archive of archived threads.

import { ApiError, AuthError, ERR, extractSearchHits, burstCount, meBurst } from './api.js';
import { buildSearchQuery, matchesCriteria } from './criteria.js';
import { listThreads, listGuildActiveThreads, isMessageable, canHaveThreads } from './discord.js';
import { cmpId, minOfIds, decId, dateToSnowflake, NON_DELETABLE_TYPES, isSystem, isThread, messageBody } from './util.js';

export const SYSTEM_GROUPS = {
  pins: [6],
  threads: [18],
  joins: [7],
  boosts: [8, 9, 10, 11],
  other: [12, 14, 15, 16, 17, 22, 24, 25, 27, 28, 29, 31, 36, 37, 38, 39, 44, 46],
};

/*
 job.params = {
   targets: [{ type: 'dm'|'channel'|'guild', id, guildId, name }],
   mode: 'delete' | 'attachments' | 'reactions',
   authorMode: 'me' | 'ids' | 'anyone', authorIds: [],
   criteria: { content, mentions, has, after, before, pinned, authorType },
   systemGroups: ['pins', ...], keepAttachments, includeThreads, scan: 'search'|'history',
   finalPass: 100, finalPassScope: 'touched'|'all', emptyPolicy: 'skip'|'delete',
   reactionUsers: ['@me' | '*' | id...], reactionEmoji: '' (optional name filter)
 }
*/
export function createPurgeHandler(deps) {
  const { api, log } = deps;

  return async function runPurge(job) {
    const P = job.params;
    const S = job.state;
    S.ti ??= 0;
    S.rearchive ??= [];
    S.touched ??= [];
    const stats = job.stats;
    for (const k of ['deleted', 'edited', 'reactions', 'skipped', 'failed', 'scanned']) stats[k] ??= 0;

    const meId = deps.meId();
    // Without our own id an "only mine" purge would silently match nothing (and the task would be consumed).
    if (!meId && P.authorMode === 'me' && P.mode !== 'reactions') throw new AuthError({ message: 'Not connected to Discord yet; connect, then resume this task' });
    const authorIds = P.authorMode === 'me' ? [meId] : P.authorMode === 'ids' ? P.authorIds || [] : [];
    const criteria = { ...(P.criteria || {}), authorIds: P.mode === 'reactions' ? [] : authorIds };
    if (P.mode === 'attachments') criteria.has = [...new Set([...(criteria.has || []), 'file'])];
    if (criteria.after) criteria.after = new Date(criteria.after);
    if (criteria.before) criteria.before = new Date(criteria.before);
    const allowedSystem = new Set((P.systemGroups || []).flatMap((g) => SYSTEM_GROUPS[g] || []));
    const deniedChannels = new Set(); // can't act on anything there (no access)
    const deniedOthers = new Set();   // can't act on other people's messages there; our own still can be deleted / edited
    const permFailures = new Map();
    // Errors that mean "this channel's history can't be read" (no access, gone, or a forum/media channel).
    const unreadable = (e) => e instanceof ApiError && (e.status === 403 || e.status === 404 || e.code === ERR.INVALID_CHANNEL_TYPE);
    const hasNoMessages = (c) => !!c && (c.type === 15 || c.type === 16); // forum / media channels: only their posts (threads) do

    const eligible = (m) => {
      if (P.mode === 'reactions') return !!(m.reactions && m.reactions.length);
      if (isSystem(m)) {
        if (P.mode !== 'delete' || NON_DELETABLE_TYPES.has(m.type) || !allowedSystem.has(m.type)) return false;
      }
      if (P.authorMode === 'me' && (!m.author || m.author.id !== meId)) return false;
      if (P.authorMode === 'ids' && (!m.author || !authorIds.includes(m.author.id))) return false;
      if (P.keepAttachments && P.mode === 'delete' && messageBody(m).attachments.length) return false;
      if (P.mode === 'attachments' && !(m.attachments && m.attachments.length)) return false;
      return true;
    };

    const withThreadRetry = async (channelId, fn) => {
      try {
        return await fn();
      } catch (e) {
        if (!(e instanceof ApiError) || e.code !== ERR.ARCHIVED_THREAD) throw e;
        log('info', `Thread ${channelId} is archived, unarchiving it temporarily`);
        await api.patchChannel(channelId, { archived: false }, job);
        if (!S.rearchive.includes(channelId)) S.rearchive.push(channelId);
        await job.save();
        return fn();
      }
    };

    const onError = (e, m) => {
      if (e.name === 'CancelledError' || e.name === 'AuthError') throw e;
      if (e instanceof ApiError) {
        if (e.status === 404 || e.code === ERR.UNKNOWN_MESSAGE) { stats.skipped++; return; }
        if (e.code === ERR.SYSTEM_MESSAGE) { stats.skipped++; return; }
        if (e.code === ERR.MISSING_PERMISSIONS || e.code === ERR.MISSING_ACCESS || e.status === 403) {
          stats.failed++;
          const n = (permFailures.get(m.channel_id) || 0) + 1;
          permFailures.set(m.channel_id, n);
          if (n === 1) log('warn', `Missing permissions in channel ${deps.channelName(m.channel_id)}; you may not be allowed to change these messages.`);
          if (n >= 5) (e.code === ERR.MISSING_ACCESS || P.mode === 'reactions' ? deniedChannels : deniedOthers).add(m.channel_id);
          return;
        }
      }
      stats.failed++;
      log('error', `Message ${m.id}: ${e.message}`);
    };

    const removeReactions = async (m) => {
      const targets = P.reactionUsers && P.reactionUsers.length ? P.reactionUsers : ['@me'];
      const others = targets.filter((x) => x !== '@me' && x !== '*');
      const before = stats.reactions;
      for (const r of m.reactions || []) {
        if (P.reactionEmoji && r.emoji.name !== P.reactionEmoji && r.emoji.id !== P.reactionEmoji) continue;
        try {
          if (targets.includes('*')) {
            await withThreadRetry(m.channel_id, () => api.deleteEmojiReactions(m.channel_id, m.id, r.emoji, job));
            stats.reactions += r.count || 1;
            continue;
          }
          if (targets.includes('@me')) {
            if (r.me) {
              await withThreadRetry(m.channel_id, () => api.deleteReaction(m.channel_id, m.id, r.emoji, '@me', job));
              stats.reactions++;
            }
            if (meBurst(r)) {
              await withThreadRetry(m.channel_id, () => api.deleteReaction(m.channel_id, m.id, r.emoji, '@me', job, 1));
              stats.reactions++;
            }
          }
          if (others.length) {
            const types = [0];
            if (burstCount(r)) types.push(1);
            for (const type of types) {
              const users = await api.allReactionUsers(m.channel_id, m.id, r.emoji, type, job);
              for (const u of users) {
                if (!others.includes(u.id)) continue;
                await withThreadRetry(m.channel_id, () => api.deleteReaction(m.channel_id, m.id, r.emoji, u.id, job, type));
                stats.reactions++;
              }
            }
          }
        } catch (e) { onError(e, m); }
      }
      if (stats.reactions > before && deps.onReactionsChanged) deps.onReactionsChanged(m); // refresh the copy on screen
      job.emit();
    };

    const act = async (m) => {
      stats.scanned++;
      const own = m.author && m.author.id === meId;
      if (deniedChannels.has(m.channel_id) || (deniedOthers.has(m.channel_id) && !own)) { stats.skipped++; return; }
      if (!eligible(m)) { stats.skipped++; return; }
      if (!S.touched.includes(m.channel_id)) S.touched.push(m.channel_id);
      try {
        if (P.mode === 'delete') {
          await withThreadRetry(m.channel_id, () => api.deleteMessage(m.channel_id, m.id, job));
          stats.deleted++;
          deps.onDeleted(m);
        } else if (P.mode === 'attachments') {
          const b = messageBody(m);
          const hasOther = (m.content && m.content.trim()) || (m.embeds && m.embeds.length) || (m.sticker_items && m.sticker_items.length) || m.poll;
          if (!hasOther && b.attachments.length) {
            if (P.emptyPolicy === 'delete') {
              await withThreadRetry(m.channel_id, () => api.deleteMessage(m.channel_id, m.id, job));
              stats.deleted++;
              deps.onDeleted(m);
            } else {
              stats.skipped++;
            }
          } else {
            const updated = await withThreadRetry(m.channel_id, () => api.editMessage(m.channel_id, m.id, { attachments: [] }, job));
            stats.edited++;
            if (updated) deps.onUpdated(updated);
          }
        } else if (P.mode === 'reactions') {
          await removeReactions(m);
        }
      } catch (e) {
        onError(e, m);
      }
      job.emit();
    };

    const progress = (label) => {
      const t = P.targets[S.ti];
      job.setProgress(stats.scanned, S.total || 0, `${t ? t.name : ''}${label ? ' · ' + label : ''}`);
    };

    // ---- search based ----
    const searchScope = (t) => (t.type === 'dm' || !t.guildId ? { channelId: t.id } : { guildId: t.guildId });

    const purgeSearch = async (t, channelIds) => {
      const q = buildSearchQuery(criteria, { channelIds });
      // A server-wide search also returns thread messages; honour "Include threads" being off.
      const skipThreads = t.type === 'guild' && P.includeThreads === false;
      let cursor = S.cursor || null;
      let stuck = 0;
      const seen = new Set();
      for (;;) {
        const qq = { ...q, sort_by: 'timestamp', sort_order: 'desc' };
        if (cursor) qq.max_id = q.max_id && cmpId(q.max_id, cursor) < 0 ? q.max_id : cursor;
        const res = await api.search(searchScope(t), qq, job);
        if (!cursor || S.total == null) S.total = (stats.scanned || 0) + ((res && res.total_results) || 0);
        const hits = extractSearchHits(res);
        if (!hits.length) break;
        const threadIds = new Set(((res && res.threads) || []).map((x) => x.id));
        let fresh = 0;
        for (const m of hits) {
          if (seen.has(m.id)) continue;
          seen.add(m.id);
          fresh++;
          if (skipThreads && (threadIds.has(m.channel_id) || isThread(deps.channel(m.channel_id)))) { stats.scanned++; stats.skipped++; continue; }
          if (!matchesCriteria(m, { ...criteria, content: null, has: null })) { stats.scanned++; stats.skipped++; continue; }
          await act(m);
          progress('searching');
        }
        const lo = minOfIds(hits.map((m) => m.id));
        if (!fresh) { if (++stuck > 2) break; cursor = decId(lo); } else { stuck = 0; cursor = lo; }
        S.cursor = cursor;
        await job.save();
      }
      S.cursor = null;
    };

    // ---- history based ----
    const channelsFor = async (t) => {
      if (S.channelList && S.channelListFor === S.ti) return S.channelList;
      let list = [];
      if (t.type === 'dm') list = [{ id: t.id, name: t.name }];
      else if (t.type === 'channel') {
        list = [{ id: t.id, name: t.name }];
        // After a restart the channel may not be loaded yet; the target remembers its type.
        const parent = deps.channel(t.id) || { id: t.id, type: t.channelType ?? 0 };
        if (P.includeThreads && canHaveThreads(parent)) {
          const threads = await listThreads(api, parent, job, log);
          list.push(...threads.map((c) => ({ id: c.id, name: c.name, thread: true })));
        }
        if (hasNoMessages(parent)) list.shift(); // forums have no messages of their own
      } else if (t.type === 'guild') {
        const chans = await api.guildChannels(t.guildId);
        for (const c of chans) if (isMessageable(c)) list.push({ id: c.id, name: c.name });
        if (P.includeThreads !== false) {
          const active = await listGuildActiveThreads(api, t.guildId);
          for (const c of active) list.push({ id: c.id, name: c.name, thread: true });
          for (const c of chans.filter(canHaveThreads)) {
            const threads = await listThreads(api, c, job, log);
            for (const th of threads) if (!list.some((x) => x.id === th.id)) list.push({ id: th.id, name: th.name, thread: true });
          }
        }
      }
      S.channelList = list;
      S.channelListFor = S.ti;
      S.ci = 0;
      await job.save();
      return list;
    };

    const purgeHistory = async (t, limitPerChannel = Infinity) => {
      const list = await channelsFor(t);
      const minId = criteria.after ? dateToSnowflake(criteria.after) : null;
      for (S.ci ??= 0; S.ci < list.length; S.ci++) {
        const c = list[S.ci];
        let before = S.before || (criteria.before ? dateToSnowflake(criteria.before) : undefined);
        let seenInChannel = 0;
        for (;;) {
          let page;
          try {
            page = await api.messages(c.id, { before, limit: 100 }, job);
          } catch (e) {
            if (unreadable(e)) { log('warn', `Skipping #${c.name}: no access`); break; }
            throw e;
          }
          if (!page || !page.length) break;
          let stop = false;
          for (const m of page) {
            if (minId && cmpId(m.id, minId) <= 0) { stop = true; continue; }
            if (!matchesCriteria(m, P.mode === 'reactions' ? { ...criteria, authorIds: [] } : criteria)) { stats.scanned++; continue; }
            await act(m);
          }
          seenInChannel += page.length;
          before = minOfIds(page.map((m) => m.id));
          S.before = before;
          progress(`#${c.name}`);
          await job.save();
          if (stop || page.length < 100 || seenInChannel >= limitPerChannel) break;
        }
        S.before = null;
      }
      S.ci = 0;
      S.channelList = null;
    };

    const finalPass = async (t) => {
      const n = Math.max(0, Math.min(Number(P.finalPass) || 0, 1000));
      if (!n) return;
      let ids = new Set(S.touched);
      if (t.type !== 'guild') ids.add(t.id);
      if (t.type === 'guild' && P.finalPassScope === 'all') {
        try { for (const c of await api.guildChannels(t.guildId)) if (isMessageable(c)) ids.add(c.id); } catch (e) { if (e.name === 'CancelledError') throw e; }
      }
      ids = [...ids];
      for (let i = 0; i < ids.length; i++) {
        const cid = ids[i];
        if (hasNoMessages(deps.channel(cid) || (cid === t.id ? { type: t.channelType } : null))) continue;
        let before;
        let seen = 0;
        while (seen < n) {
          let page;
          try { page = await api.messages(cid, { before, limit: Math.min(100, n - seen) }, job); } catch (e) {
            if (unreadable(e)) break;
            throw e;
          }
          if (!page || !page.length) break;
          for (const m of page) if (matchesCriteria(m, criteria)) await act(m);
          seen += page.length;
          before = minOfIds(page.map((m) => m.id));
          if (page.length < 100) break;
        }
        progress(`final pass ${i + 1}/${ids.length}`);
      }
    };

    // useJob=false is for the cleanup in `finally`: a cancelled job would refuse every request, leaving threads unarchived.
    const rearchive = async (useJob = true) => {
      while (S.rearchive.length) {
        const id = S.rearchive[0];
        try { await api.patchChannel(id, { archived: true }, useJob ? job : undefined); log('info', `Re-archived thread ${id}`); } catch (e) {
          // Keep it in the (saved) list when a later resume could still do it.
          if (e.name === 'CancelledError' || e.name === 'AuthError') throw e;
          log('warn', `Could not re-archive thread ${id}: ${e.message}`);
        }
        S.rearchive.shift();
        await job.save();
      }
    };

    try {
      while (S.ti < P.targets.length) {
        const t = P.targets[S.ti];
        log('info', `Purging ${t.name}…`);
        progress('starting');
        const useHistory = P.mode === 'reactions' || P.scan === 'history';
        if (useHistory) {
          await purgeHistory(t);
        } else {
          if (S.phase !== 'final') {
            if (t.type === 'channel') {
              const ids = [t.id];
              if (P.includeThreads) {
                const parent = deps.channel(t.id) || { id: t.id, type: t.channelType ?? 0 };
                if (canHaveThreads(parent)) ids.push(...(await listThreads(api, parent, job, log)).map((x) => x.id));
              }
              // Discord limits how many channel ids one search may include.
              S.chunk ??= 0;
              for (; S.chunk * 10 < ids.length; S.chunk++) await purgeSearch(t, ids.slice(S.chunk * 10, S.chunk * 10 + 10));
              S.chunk = 0;
            } else {
              await purgeSearch(t);
            }
            S.phase = 'final';
            await job.save();
          }
          await finalPass(t);
        }
        await rearchive();
        S.phase = null;
        S.touched = [];
        S.cursor = null;
        S.total = null;
        // Move on before saving, so a resume never redoes a finished target (a full-history scan can take hours).
        S.ti++;
        await job.save();
      }
    } finally {
      if (S.rearchive.length) await rearchive(false).catch(() => {});
    }
    const msg = [`${stats.deleted} deleted`, stats.edited ? `${stats.edited} edited` : '', stats.reactions ? `${stats.reactions} reactions removed` : '', `${stats.skipped} skipped`, stats.failed ? `${stats.failed} failed` : ''].filter(Boolean).join(', ');
    log('ok', `Purge done: ${msg}`);
    return stats;
  };
}
