// Search criteria: turning them into Discord search queries, and checking messages locally
// (used for full-history scans and to double-check search results before acting on them).

import { dateToSnowflake, cmpId, attachmentKind, messageBody } from './util.js';

export const HAS_TYPES = [
  ['link', 'Link'], ['embed', 'Embed'], ['file', 'File'], ['image', 'Image'], ['video', 'Video'],
  ['sound', 'Sound'], ['sticker', 'Sticker'], ['poll', 'Poll'],
];

// c = { content, authorIds[], mentions[], has[], after(Date), before(Date), pinned: any|only|exclude, authorType: ''|user|bot|webhook }
export function buildSearchQuery(c = {}, { channelIds } = {}) {
  const q = {};
  if (c.content) q.content = c.content;
  if (c.authorIds && c.authorIds.length) q.author_id = c.authorIds;
  if (c.mentions && c.mentions.length) q.mentions = c.mentions;
  if (c.has && c.has.length) q.has = c.has;
  if (c.after) q.min_id = dateToSnowflake(c.after);
  if (c.before) q.max_id = dateToSnowflake(c.before);
  if (c.pinned === 'only') q.pinned = true;
  if (c.pinned === 'exclude') q.pinned = false;
  if (c.authorType) q.author_type = c.authorType;
  if (channelIds && channelIds.length) q.channel_id = channelIds;
  q.include_nsfw = true;
  return q;
}

function hasType(m, t) {
  const b = messageBody(m);
  switch (t) {
    case 'link': return /https?:\/\/\S/.test(b.content);
    case 'embed': return b.embeds.length > 0;
    case 'file': return b.attachments.length > 0;
    case 'image': return b.attachments.some((a) => attachmentKind(a) === 'image') || b.embeds.some((e) => e.type === 'image' || e.type === 'gifv' || e.image);
    case 'video': return b.attachments.some((a) => attachmentKind(a) === 'video') || b.embeds.some((e) => e.type === 'video' || e.video);
    case 'sound': return b.attachments.some((a) => attachmentKind(a) === 'audio');
    case 'sticker': return b.stickers.length > 0;
    case 'poll': return !!m.poll;
    case 'snapshot': return !!(m.message_snapshots && m.message_snapshots.length);
    default: return true;
  }
}

export function matchesCriteria(m, c = {}) {
  if (!m) return false;
  if (c.authorIds && c.authorIds.length && !(m.author && c.authorIds.includes(m.author.id))) return false;
  if (c.after) {
    const min = dateToSnowflake(c.after);
    if (min && cmpId(m.id, min) <= 0) return false;
  }
  if (c.before) {
    const max = dateToSnowflake(c.before);
    if (max && cmpId(m.id, max) >= 0) return false;
  }
  if (c.content) {
    const hay = messageBody(m).content.toLowerCase();
    if (!hay.includes(String(c.content).toLowerCase())) return false;
  }
  if (c.mentions && c.mentions.length) {
    const ids = new Set((m.mentions || []).map((u) => u.id));
    if (!c.mentions.some((id) => ids.has(id))) return false;
  }
  if (c.has && c.has.length && !c.has.every((t) => hasType(m, t))) return false;
  if (c.pinned === 'only' && !m.pinned) return false;
  if (c.pinned === 'exclude' && m.pinned) return false;
  if (c.authorType === 'bot' && !(m.author && m.author.bot)) return false;
  if (c.authorType === 'webhook' && !m.webhook_id) return false;
  if (c.authorType === 'user' && ((m.author && m.author.bot) || m.webhook_id)) return false;
  return true;
}

export function parseIdList(s) {
  return String(s || '').split(/[\s,;]+/).map((x) => x.trim()).filter((x) => /^\d{15,22}$/.test(x));
}

export function describeCriteria(c = {}) {
  const bits = [];
  if (c.content) bits.push(`contains “${c.content}”`);
  if (c.authorIds && c.authorIds.length) bits.push(`from ${c.authorIds.length} user(s)`);
  if (c.mentions && c.mentions.length) bits.push(`mentions ${c.mentions.length} user(s)`);
  if (c.has && c.has.length) bits.push(`has ${c.has.join(', ')}`);
  if (c.after) bits.push(`after ${new Date(c.after).toLocaleDateString()}`);
  if (c.before) bits.push(`before ${new Date(c.before).toLocaleDateString()}`);
  if (c.pinned === 'only') bits.push('pinned only');
  if (c.pinned === 'exclude') bits.push('not pinned');
  if (c.authorType) bits.push(`${c.authorType} authors`);
  return bits.join(' · ') || 'everything';
}
