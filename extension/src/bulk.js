// Bulk actions on selected messages: delete, edit text, remove attachments, remove reactions.

import { ApiError, ERR, burstCount, meBurst } from './api.js';
import { NON_DELETABLE_TYPES } from './util.js';

export function computeEdit(content, e) {
  content = content || '';
  switch (e.mode) {
    case 'replace': return e.text || '';
    case 'append': return content + (e.text || '');
    case 'prepend': return (e.text || '') + content;
    case 'find': {
      if (!e.find) return content;
      if (e.regex) {
        let flags = e.ignoreCase ? 'gi' : 'g';
        return content.replace(new RegExp(e.find, flags), e.replace || '');
      }
      if (e.ignoreCase) {
        const re = new RegExp(e.find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
        return content.replace(re, () => e.replace || '');
      }
      return content.split(e.find).join(e.replace || '');
    }
    default: return content;
  }
}

// Compact copy of what a bulk action needs from each message (kept in the job so it can resume).
export function slimForBulk(m) {
  return {
    id: m.id, channel_id: m.channel_id, type: m.type, author: m.author ? { id: m.author.id } : null,
    content: m.content || '', attachments: (m.attachments || []).map((a) => ({ id: a.id, filename: a.filename })),
    embeds: (m.embeds || []).length, stickers: (m.sticker_items || []).length, poll: !!m.poll,
    reactions: (m.reactions || []).map((r) => ({ emoji: r.emoji, count: r.count, me: r.me, me_burst: meBurst(r), burst_count: burstCount(r) })),
  };
}

/*
 job.params = { action: 'delete'|'edit'|'attachments'|'reactions', items: [slim], edit: {...},
                attachments: { filter: '', emptyPolicy: 'skip'|'delete' }, reactions: { users: ['@me'|'*'|id], emoji: '' } }
*/
export function createBulkHandler(deps) {
  const { api, log } = deps;
  return async function runBulk(job) {
    const P = job.params;
    const S = job.state;
    S.i ??= 0;
    // Threads we unarchived; kept in the saved state so they still get re-archived if Cleancord closes mid-task.
    S.rearchive ??= [];
    const stats = job.stats;
    for (const k of ['done', 'skipped', 'failed']) stats[k] ??= 0;
    // Channels we can't reach (left the server, channel deleted): skip the rest of their messages without a request each.
    const unreachable = new Map(); // channelId -> 'gone' | 'denied'

    const retryArchived = async (cid, fn) => {
      try { return await fn(); } catch (e) {
        if (!(e instanceof ApiError) || e.code !== ERR.ARCHIVED_THREAD) throw e;
        await api.patchChannel(cid, { archived: false }, job);
        if (!S.rearchive.includes(cid)) { S.rearchive.push(cid); await job.save(); }
        return fn();
      }
    };

    try {
      for (; S.i < P.items.length; S.i++) {
        const m = P.items[S.i];
        job.setProgress(S.i, P.items.length, `${P.action} ${S.i + 1}/${P.items.length}`);
        const gone = unreachable.get(m.channel_id);
        if (gone) {
          stats.skipped++;
          if (gone === 'gone' && P.action === 'delete') deps.onDeleted(m);
          continue;
        }
        try {
          if (P.action === 'delete') {
            if (NON_DELETABLE_TYPES.has(m.type)) { stats.skipped++; continue; }
            await retryArchived(m.channel_id, () => api.deleteMessage(m.channel_id, m.id, job));
            stats.done++;
            deps.onDeleted(m);
          } else if (P.action === 'edit') {
            const next = computeEdit(m.content, P.edit);
            if (next === m.content) { stats.skipped++; continue; }
            if (!next.trim() && !m.attachments.length && !m.embeds && !m.stickers) { stats.skipped++; log('warn', `Skipped ${m.id}: the edit would leave it empty`); continue; }
            const updated = await retryArchived(m.channel_id, () => api.editMessage(m.channel_id, m.id, { content: next }, job));
            stats.done++;
            if (updated) deps.onUpdated(updated);
          } else if (P.action === 'attachments') {
            const f = (P.attachments && P.attachments.filter || '').toLowerCase();
            const keep = f ? m.attachments.filter((a) => !a.filename.toLowerCase().includes(f)) : [];
            if (keep.length === m.attachments.length) { stats.skipped++; continue; }
            const empty = !m.content.trim() && !m.embeds && !m.stickers && !m.poll && !keep.length;
            if (empty) {
              if (P.attachments && P.attachments.emptyPolicy === 'delete') {
                await retryArchived(m.channel_id, () => api.deleteMessage(m.channel_id, m.id, job));
                stats.done++;
                deps.onDeleted(m);
              } else { stats.skipped++; }
              continue;
            }
            const updated = await retryArchived(m.channel_id, () => api.editMessage(m.channel_id, m.id, { attachments: keep.map((a) => ({ id: a.id })) }, job));
            stats.done++;
            if (updated) deps.onUpdated(updated);
          } else if (P.action === 'reactions') {
            const users = (P.reactions && P.reactions.users) || ['@me'];
            const emojiFilter = P.reactions && P.reactions.emoji;
            let removed = 0;
            for (const r of m.reactions) {
              if (emojiFilter && r.emoji.name !== emojiFilter && r.emoji.id !== emojiFilter) continue;
              if (users.includes('*')) {
                await retryArchived(m.channel_id, () => api.deleteEmojiReactions(m.channel_id, m.id, r.emoji, job));
                removed++;
                continue;
              }
              if (users.includes('@me')) {
                if (r.me) {
                  await retryArchived(m.channel_id, () => api.deleteReaction(m.channel_id, m.id, r.emoji, '@me', job));
                  removed++;
                }
                if (meBurst(r)) {
                  await retryArchived(m.channel_id, () => api.deleteReaction(m.channel_id, m.id, r.emoji, '@me', job, 1));
                  removed++;
                }
              }
              const others = users.filter((u) => u !== '@me' && u !== '*');
              if (others.length) {
                for (const type of burstCount(r) ? [0, 1] : [0]) {
                  const list = await api.allReactionUsers(m.channel_id, m.id, r.emoji, type, job);
                  for (const u of list) {
                    if (!others.includes(u.id)) continue;
                    await retryArchived(m.channel_id, () => api.deleteReaction(m.channel_id, m.id, r.emoji, u.id, job, type));
                    removed++;
                  }
                }
              }
            }
            if (removed) { stats.done++; deps.onReactionsChanged(m); } else stats.skipped++;
          }
        } catch (e) {
          if (e.name === 'CancelledError' || e.name === 'AuthError') throw e;
          if (e instanceof ApiError && (e.status === 404 || e.code === ERR.UNKNOWN_MESSAGE)) {
            stats.skipped++;
            if (P.action === 'delete') deps.onDeleted(m);
            if (e.code === ERR.UNKNOWN_CHANNEL) unreachable.set(m.channel_id, 'gone');
          } else if (e instanceof ApiError && e.code === ERR.MISSING_ACCESS) {
            stats.skipped++;
            unreachable.set(m.channel_id, 'denied');
            log('warn', `No access to channel ${m.channel_id} any more (left the server?); skipping its messages`);
          } else if (e instanceof ApiError && e.code === ERR.SYSTEM_MESSAGE) {
            stats.skipped++;
          } else {
            stats.failed++;
            log('error', `Message ${m.id}: ${e.message}`);
          }
        }
        job.emit();
        if (S.i % 5 === 0) await job.save();
      }
      job.setProgress(P.items.length, P.items.length, 'done');
    } finally {
      // No job here on purpose: a cancelled job would refuse the request.
      while (S.rearchive.length) {
        const cid = S.rearchive[0];
        try { await api.patchChannel(cid, { archived: true }); } catch (e) {
          if (e.name === 'AuthError') break; // keep it in the saved state for a resume after reconnecting
          log('warn', `Could not re-archive thread ${cid}`);
        }
        S.rearchive.shift();
      }
      await job.save().catch(() => {});
    }
    log('ok', `${P.action}: ${stats.done} done, ${stats.skipped} skipped${stats.failed ? `, ${stats.failed} failed` : ''}`);
    return stats;
  };
}
