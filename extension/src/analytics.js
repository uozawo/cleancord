// Mention analytics ("tags") and simple activity stats over loaded messages.

import { csvCell, userTag } from './util.js';

export function computeAnalytics(messages, ctx, { includeReplies = true } = {}) {
  const users = new Map();
  const roles = new Map();
  const channels = new Map();
  const authors = new Map();
  const months = new Map();
  let everyone = 0, here = 0;
  const bump = (map, id, extra) => {
    const e = map.get(id) || { id, count: 0, ...extra };
    e.count++;
    map.set(id, e);
  };
  for (const m of messages) {
    // Mentions inside code are plain text in Discord (no ping), so they don't count.
    const content = (m.content || '').replace(/(`+)[\s\S]*?[^`]\1(?!`)/g, ' ');
    const explicit = new Set();
    for (const x of content.matchAll(/<@!?(\d+)>/g)) { bump(users, x[1]); explicit.add(x[1]); }
    for (const x of content.matchAll(/<@&(\d+)>/g)) bump(roles, x[1]);
    for (const x of content.matchAll(/<#(\d+)>/g)) bump(channels, x[1]);
    everyone += (content.match(/@everyone\b/g) || []).length;
    here += (content.match(/@here\b/g) || []).length;
    if (includeReplies && m.type === 19 && m.referenced_message && m.referenced_message.author) {
      const rid = m.referenced_message.author.id;
      if (!explicit.has(rid) && (m.mentions || []).some((u) => u.id === rid)) bump(users, rid, { viaReply: true });
    }
    if (m.author) bump(authors, m.author.id, { user: m.author });
    if (m.timestamp) bump(months, m.timestamp.slice(0, 7));
  }
  const sorted = (map) => [...map.values()].sort((a, b) => b.count - a.count);
  return {
    total: messages.length,
    users: sorted(users).map((e) => ({ ...e, name: ctx.userName(e.id), tag: userTag(ctx.users.get(e.id)) })),
    roles: sorted(roles).map((e) => ({ ...e, name: (ctx.role(e.id) || {}).name || 'unknown-role' })),
    channels: sorted(channels).map((e) => ({ ...e, name: ctx.channelName(e.id) })),
    authors: sorted(authors).map((e) => ({ ...e, name: ctx.userName(e.id), tag: userTag(e.user) })),
    months: [...months.values()].sort((a, b) => a.id.localeCompare(b.id)),
    everyone,
    here,
  };
}

export function analyticsCsv(a) {
  const lines = [['kind', 'id', 'name', 'count'].join(',')];
  for (const e of a.users) lines.push(['user_mention', e.id, e.tag ? `${e.name} (${e.tag})` : e.name, e.count].map(csvCell).join(','));
  for (const e of a.roles) lines.push(['role_mention', e.id, e.name, e.count].map(csvCell).join(','));
  for (const e of a.channels) lines.push(['channel_mention', e.id, e.name, e.count].map(csvCell).join(','));
  if (a.everyone) lines.push(['everyone', '', '@everyone', a.everyone].map(csvCell).join(','));
  if (a.here) lines.push(['here', '', '@here', a.here].map(csvCell).join(','));
  for (const e of a.authors) lines.push(['messages_by_author', e.id, e.name, e.count].map(csvCell).join(','));
  for (const e of a.months) lines.push(['messages_by_month', '', e.id, e.count].map(csvCell).join(','));
  return '﻿' + lines.join('\r\n') + '\r\n';
}
