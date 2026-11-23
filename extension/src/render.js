// Renders Discord messages to HTML strings. Shared by the in-app feed and the HTML export.
// Everything that comes from Discord is escaped with esc() or goes through renderMarkdown().

import {
  esc, fmtDate, truncate, humanBytes, snowflakeToDate, userName, avatarUrl, emojiUrl, stickerUrl, roleIconUrl,
  attachmentKind, isSystem, messageBody, safeUrl, MT,
} from './util.js';
import { renderMarkdown, plainText } from './markdown.js';

const GROUP_WINDOW = 7 * 60 * 1000;
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
// URL for an href/src attribute: http(s) or relative only, HTML-escaped.
const url = (u) => esc(safeUrl(u));

export function colorHex(n) {
  n = Number(n);
  return n > 0 && n <= 0xffffff ? '#' + n.toString(16).padStart(6, '0') : '';
}

// Builds the lookup helpers both the app and the exporter pass to renderMessage().
export function makeContext(base) {
  const ctx = {
    mode: 'app',
    settings: {},
    meId: null,
    guildId: null,
    roles: new Map(),      // roleId -> role
    members: new Map(),    // userId -> member (nick, roles)
    users: new Map(),      // userId -> user
    channels: new Map(),   // channelId -> name
    media: (kind, url) => url,
    preview: { images: true, videos: true, audio: true, embedImages: true, embedVideos: true },
    imageMode: 'safe',
    selected: null,
    showChannel: false,
    includeReactions: true,
    linkFor: (id) => null,
    ...base,
  };
  ctx.userName = (id) => {
    const m = ctx.members.get(id);
    const u = ctx.users.get(id);
    return (m && m.nick) || (u ? userName(u) : 'unknown-user');
  };
  ctx.role = (id) => ctx.roles.get(id) || null;
  ctx.channelName = (id) => ctx.channels.get(id) || 'unknown-channel';
  ctx.emojiSrc = (id, animated) => ctx.media('emoji', emojiUrl(id, animated), { id, animated });
  return ctx;
}

export function rememberUsers(m, ctx) {
  if (m.author) ctx.users.set(m.author.id, m.author);
  for (const u of m.mentions || []) if (!ctx.users.has(u.id)) ctx.users.set(u.id, u);
  if (m.referenced_message && m.referenced_message.author) {
    const a = m.referenced_message.author;
    if (!ctx.users.has(a.id)) ctx.users.set(a.id, a);
  }
}

export function memberStyle(userId, ctx) {
  const member = ctx.members.get(userId);
  if (!member || !member.roles || !ctx.roles.size) return { color: '', icon: null, roleName: '' };
  const roles = member.roles.map((r) => ctx.roles.get(r)).filter(Boolean).sort((a, b) => b.position - a.position);
  const colored = roles.find((r) => (r.colors && r.colors.primary_color) || r.color);
  const iconRole = roles.find((r) => r.icon || r.unicode_emoji);
  return {
    color: colored ? colorHex((colored.colors && colored.colors.primary_color) || colored.color) : '',
    icon: iconRole,
    roleName: colored ? colored.name : '',
  };
}

function displayName(user, ctx) {
  if (!user) return 'Unknown';
  const member = ctx.members.get(user.id);
  return (member && member.nick) || userName(user);
}

function nameHtml(user, ctx) {
  const st = memberStyle(user.id, ctx);
  let icon = '';
  if (st.icon) {
    if (st.icon.icon) {
      const src = ctx.media('roleicon', roleIconUrl(st.icon), { role: st.icon });
      if (src) icon = `<img class="role-icon" src="${esc(src)}" alt="" title="${esc(st.icon.name)}">`;
    } else if (st.icon.unicode_emoji) {
      icon = `<span class="role-icon" title="${esc(st.icon.name)}">${esc(st.icon.unicode_emoji)}</span>`;
    }
  }
  const bot = user.bot ? `<span class="bot-tag">${user.system ? 'SYSTEM' : 'APP'}</span>` : '';
  return `<span class="msg-author"${st.color ? ` style="color:${st.color}"` : ''} title="${esc(user.username)}${st.roleName ? ' · ' + esc(st.roleName) : ''}">${esc(displayName(user, ctx))}</span>${icon}${bot}`;
}

function callDuration(m) {
  if (!m.call || !m.call.ended_timestamp) return '';
  const secs = Math.max(0, (new Date(m.call.ended_timestamp) - new Date(m.timestamp)) / 1000);
  if (secs < 60) return `${Math.round(secs)} seconds`;
  if (secs < 3600) return `${Math.round(secs / 60)} minutes`;
  return `${(secs / 3600).toFixed(1)} hours`;
}

export function systemText(m, ctx) {
  const name = `<strong>${esc(displayName(m.author, ctx))}</strong>`;
  const target = m.mentions && m.mentions[0] ? `<strong>${esc(displayName(m.mentions[0], ctx))}</strong>` : 'someone';
  const c = esc(m.content || '');
  switch (m.type) {
    case MT.RECIPIENT_ADD: return `${name} added ${target} to the ${ctx.guildId ? 'thread' : 'group'}.`;
    case MT.RECIPIENT_REMOVE:
      return m.mentions && m.mentions[0] && m.author && m.mentions[0].id === m.author.id
        ? `${name} left the ${ctx.guildId ? 'thread' : 'group'}.` : `${name} removed ${target} from the ${ctx.guildId ? 'thread' : 'group'}.`;
    case MT.CALL: {
      const dur = callDuration(m);
      const missed = m.call && ctx.meId && !(m.call.participants || []).includes(ctx.meId);
      return `${name} started a call${dur ? ` that lasted ${dur}` : m.call && !m.call.ended_timestamp ? '' : ''}.${missed ? ' <span class="muted">(missed)</span>' : ''}`;
    }
    case MT.CHANNEL_NAME_CHANGE: return `${name} changed the channel name: <strong>${c}</strong>`;
    case MT.CHANNEL_ICON_CHANGE: return `${name} changed the channel icon.`;
    case MT.PIN: {
      const ref = m.message_reference && m.message_reference.message_id;
      return `${name} pinned ${ref ? jumpLink(ref, 'a message', ctx) : 'a message'} to this channel.`;
    }
    case MT.USER_JOIN: return `${name} joined the server.`;
    case MT.BOOST: case MT.BOOST_T1: case MT.BOOST_T2: case MT.BOOST_T3: {
      const times = num(m.content) > 1 ? ` <strong>${num(m.content)}</strong> times` : '';
      return `${name} just boosted the server${times}!${m.type > MT.BOOST ? ` It has reached <strong>Level ${m.type - 8}</strong>!` : ''}`;
    }
    case MT.FOLLOW_ADD: return `${name} added <strong>${c}</strong> to this channel.`;
    case MT.THREAD_CREATED: return `${name} started a thread: <strong>${c}</strong>`;
    case MT.THREAD_STARTER: {
      const ref = m.referenced_message;
      if (!ref) return 'Thread starter message (the original message was deleted)';
      const text = plainText(messageBody(ref).content, ctx) || (messageBody(ref).attachments.length ? '📎 Attachment' : '');
      return `Thread started from ${jumpLink(ref.id, 'a message', ctx)} by <strong>${esc(displayName(ref.author, ctx))}</strong>${text ? `: <em>${esc(truncate(text, 200))}</em>` : ''}`;
    }
    case MT.INVITE_REMINDER: return 'Invite reminder';
    case MT.AUTOMOD: return `AutoMod acted on a message from ${name}.`;
    case MT.STAGE_START: return `${name} started the stage <strong>${c}</strong>.`;
    case MT.STAGE_END: return `${name} ended the stage <strong>${c}</strong>.`;
    case MT.STAGE_SPEAKER: return `${name} is now a speaker.`;
    case MT.STAGE_TOPIC: return `${name} changed the stage topic: <strong>${c}</strong>`;
    case MT.POLL_RESULT: {
      const f = new Map(((m.embeds && m.embeds[0] && m.embeds[0].fields) || []).map((x) => [x.name, x.value]));
      const q = f.get('poll_question_text');
      const win = f.get('victor_answer_text');
      return `${name}'s poll${q ? ` <strong>${esc(q)}</strong>` : ''} has closed.${win ? ` Winner: <strong>${esc(win)}</strong> (${num(f.get('victor_answer_votes'))} of ${num(f.get('total_votes'))} votes)` : ''}`;
    }
    case 25: return `${name} joined a role subscription.`;
    case 36: case 37: case 38: case 39: return 'Server safety alert';
    case 44: return `${name} made a purchase.`;
    default: return `${name}: system message (type ${num(m.type)})${c ? `: ${c}` : ''}`;
  }
}

function jumpLink(id, label, ctx) {
  if (ctx.mode === 'app') return `<a class="jump" href="#" data-jump="${esc(id)}">${label}</a>`;
  const href = ctx.linkFor(id);
  return href ? `<a class="jump" href="${esc(href)}">${label}</a>` : label;
}

function thumbUrl(a, w, h) {
  const base = a.proxy_url || a.url;
  if (!a.width || !a.height || !base) return base;
  const scale = Math.min(1, w / a.width, h / a.height);
  try {
    const u = new URL(base);
    u.searchParams.set('width', Math.max(1, Math.round(a.width * scale)));
    u.searchParams.set('height', Math.max(1, Math.round(a.height * scale)));
    return u.toString();
  } catch { return base; }
}

const PREVIEW_KEY = { image: 'images', video: 'videos', audio: 'audio' };

function renderAttachment(a, m, ctx) {
  const kind = attachmentKind(a);
  const spoiler = (a.filename || '').startsWith('SPOILER_') || (a.flags & 8);
  const href = safeUrl(ctx.media('attachment', a.url, { m, a, kind }));
  const preview = ctx.mode === 'app' || (PREVIEW_KEY[kind] && ctx.preview[PREVIEW_KEY[kind]]);
  const sp = spoiler ? ' att-spoiler' : '';
  if (preview && href) {
    if (kind === 'image') {
      const src = ctx.mode === 'app' ? thumbUrl(a, 400, 300) : href;
      const ratio = num(a.width) && num(a.height) ? ` style="aspect-ratio:${num(a.width)}/${num(a.height)}"` : '';
      const attrs = ctx.mode === 'app' ? ` data-lightbox="${url(a.url)}"` : '';
      return `<a class="att att-img${sp}" href="${esc(href)}" target="_blank" rel="noopener noreferrer"${attrs} tabindex="0"><img src="${url(src)}" alt="${esc(a.description || a.filename)}" loading="lazy"${ratio}></a>`;
    }
    if (kind === 'video') return `<div class="att att-video${sp}"><video controls preload="none" src="${esc(href)}"></video><div class="att-cap">${esc(a.filename)}</div></div>`;
    if (kind === 'audio') return `<div class="att att-audio${sp}"><div class="att-cap">${esc(a.filename)} · ${humanBytes(a.size)}</div><audio controls preload="none" src="${esc(href)}"></audio></div>`;
  }
  return `<div class="att att-file"><span class="att-icon">📄</span><div><a href="${esc(href || safeUrl(a.url))}" target="_blank" rel="noopener noreferrer">${esc(a.filename)}</a><div class="muted">${humanBytes(a.size)}${a.content_type ? ' · ' + esc(a.content_type) : ''}</div></div></div>`;
}

function renderEmbed(e, m, ctx, i) {
  const pv = ctx.preview;
  const img = (src, kind, cls) => {
    if (!src) return '';
    const u = safeUrl(ctx.media('embed', src, { m, i, kind }));
    if (!u) return '';
    if (ctx.mode !== 'app' && !(kind === 'image' ? pv.embedImages : pv.embedVideos)) {
      return `<a href="${esc(u)}" target="_blank" rel="noopener noreferrer">${esc(truncate(src, 60))}</a>`;
    }
    return `<img class="${cls}" src="${esc(u)}" alt="" loading="lazy">`;
  };
  const mdCtx = ctx;
  if ((e.type === 'image' || e.type === 'gifv') && !e.title && !e.description) {
    if (e.type === 'gifv' && e.video) {
      const u = safeUrl(ctx.media('embed', e.video.proxy_url || e.video.url, { m, i, kind: 'video' }));
      if (u && (ctx.mode === 'app' || pv.embedVideos)) return `<div class="embed-media"><video src="${esc(u)}" autoplay loop muted playsinline></video></div>`;
    }
    const t = e.thumbnail || e.image;
    return t ? `<div class="embed-media">${img(t.proxy_url || t.url, 'image', 'embed-img')}</div>` : '';
  }
  if (e.type === 'video' && e.video && !e.provider && !e.title) {
    const u = safeUrl(ctx.media('embed', e.video.proxy_url || e.video.url, { m, i, kind: 'video' }));
    if (u && (ctx.mode === 'app' || pv.embedVideos)) return `<div class="embed-media"><video controls preload="none" src="${esc(u)}"></video></div>`;
  }
  const color = e.color ? colorHex(e.color) : '';
  const parts = [];
  if (e.provider && e.provider.name) parts.push(`<div class="embed-provider">${esc(e.provider.name)}</div>`);
  if (e.author && e.author.name) {
    const ic = e.author.proxy_icon_url || e.author.icon_url;
    const name = safeUrl(e.author.url) ? `<a href="${url(e.author.url)}" target="_blank" rel="noopener noreferrer">${esc(e.author.name)}</a>` : esc(e.author.name);
    parts.push(`<div class="embed-author">${ic ? img(ic, 'image', 'embed-author-icon') : ''}${name}</div>`);
  }
  if (e.title) {
    const t = renderMarkdown(e.title, mdCtx, { inlineOnly: true });
    parts.push(`<div class="embed-title">${safeUrl(e.url) ? `<a href="${url(e.url)}" target="_blank" rel="noopener noreferrer">${t}</a>` : t}</div>`);
  }
  if (e.description) parts.push(`<div class="embed-desc">${renderMarkdown(e.description, mdCtx)}</div>`);
  if (e.fields && e.fields.length) {
    parts.push(`<div class="embed-fields">${e.fields.map((f) =>
      `<div class="embed-field${f.inline ? ' inline' : ''}"><div class="embed-field-name">${renderMarkdown(f.name, mdCtx, { inlineOnly: true })}</div><div class="embed-field-value">${renderMarkdown(f.value, mdCtx)}</div></div>`).join('')}</div>`);
  }
  if (e.video && e.thumbnail) {
    parts.push(`<div class="embed-image"><a href="${url(e.url || e.video.url)}" target="_blank" rel="noopener noreferrer">${img(e.thumbnail.proxy_url || e.thumbnail.url, 'image', 'embed-img')}<span class="play">▶</span></a></div>`);
  } else if (e.image) {
    parts.push(`<div class="embed-image">${img(e.image.proxy_url || e.image.url, 'image', 'embed-img')}</div>`);
  }
  const thumb = !e.video && e.thumbnail ? img(e.thumbnail.proxy_url || e.thumbnail.url, 'image', 'embed-thumb') : '';
  if ((e.footer && e.footer.text) || e.timestamp) {
    const ic = e.footer && (e.footer.proxy_icon_url || e.footer.icon_url);
    const bits = [e.footer && e.footer.text ? esc(e.footer.text) : '', e.timestamp ? esc(fmtDate(e.timestamp, ctx.settings)) : ''].filter(Boolean);
    parts.push(`<div class="embed-footer">${ic ? img(ic, 'image', 'embed-footer-icon') : ''}${bits.join(' • ')}</div>`);
  }
  if (!parts.length && !thumb) return '';
  return `<div class="embed"${color ? ` style="border-left-color:${color}"` : ''}><div class="embed-grid"><div class="embed-main">${parts.join('')}</div>${thumb ? `<div class="embed-thumb-wrap">${thumb}</div>` : ''}</div></div>`;
}

function renderPoll(p, ctx) {
  const counts = new Map(((p.results && p.results.answer_counts) || []).map((c) => [c.id, c]));
  const total = [...counts.values()].reduce((s, c) => s + num(c.count), 0);
  const answers = (p.answers || []).map((a) => {
    const c = counts.get(a.answer_id);
    const n = c ? num(c.count) : 0;
    const pct = total ? Math.round((n / total) * 100) : 0;
    const em = a.poll_media && a.poll_media.emoji ? emojiHtml(a.poll_media.emoji, ctx) + ' ' : '';
    return `<div class="poll-answer${c && c.me_voted ? ' me' : ''}"><div class="poll-bar" style="width:${pct}%"></div><span>${em}${esc((a.poll_media && a.poll_media.text) || '')}</span><span class="poll-count">${n} · ${pct}%</span></div>`;
  }).join('');
  return `<div class="poll"><div class="poll-q">📊 ${esc((p.question && p.question.text) || 'Poll')}</div>${answers}<div class="muted">${total} votes${p.results && p.results.is_finalized ? ' · Final results' : ''}</div></div>`;
}

export function emojiHtml(e, ctx) {
  if (e.id) {
    const src = ctx.media('emoji', emojiUrl(e.id, e.animated), { id: e.id, animated: e.animated });
    return src ? `<img class="react-emoji" src="${esc(src)}" alt=":${esc(e.name || '')}:" title=":${esc(e.name || '')}:">` : `:${esc(e.name || '?')}:`;
  }
  return `<span class="react-uni">${esc(e.name || '')}</span>`;
}

function renderReactions(m, ctx) {
  if (!ctx.includeReactions || !m.reactions || !m.reactions.length) return '';
  const chips = m.reactions.map((r) => {
    const me = r.me || r.me_burst;
    const burst = r.burst_count ? ' burst' : '';
    const inner = `${emojiHtml(r.emoji || {}, ctx)}<span>${num(r.count)}</span>`;
    return ctx.mode === 'app'
      ? `<button class="reaction${me ? ' me' : ''}${burst}" data-reactions="${esc(m.id)}" title="See who reacted">${inner}</button>`
      : `<span class="reaction${me ? ' me' : ''}${burst}">${inner}</span>`;
  }).join('');
  return `<div class="reactions">${chips}</div>`;
}

function renderReply(m, ctx) {
  if (m.type !== MT.REPLY) return '';
  const ref = m.referenced_message;
  if (!ref) {
    // null = the original was deleted; missing = Discord didn't include it (e.g. search results).
    const refId = m.message_reference && m.message_reference.message_id;
    if (ref === undefined && refId) {
      const label = ctx.mode === 'app' || ctx.linkFor(refId) ? jumpLink(refId, 'Click to see the original message', ctx) : 'Original message not included';
      return `<div class="reply"><span class="reply-spine"></span><span class="muted"><em>${label}</em></span></div>`;
    }
    return `<div class="reply"><span class="reply-spine"></span><span class="muted"><em>Original message was deleted</em></span></div>`;
  }
  const a = ref.author || {};
  const av = ctx.media('avatar', avatarUrl(a, 32), { user: a });
  const body = messageBody(ref);
  let text = plainText(body.content, ctx);
  if (!text && body.attachments.length) text = '📎 Attachment';
  if (!text && body.stickers.length) text = 'Sticker';
  if (!text && body.embeds.length) text = 'Embed';
  const st = memberStyle(a.id, ctx);
  const inner = `<span class="reply-spine"></span>${av ? `<img class="reply-av" src="${esc(av)}" alt="">` : ''}<span class="reply-name"${st.color ? ` style="color:${st.color}"` : ''}>@${esc(displayName(a, ctx))}</span><span class="reply-text">${esc(truncate(text, 140))}</span>`;
  if (ctx.mode === 'app') return `<div class="reply" data-jump="${esc(ref.id)}" title="Jump to message">${inner}</div>`;
  const href = ctx.linkFor(ref.id);
  return href ? `<a class="reply" href="${esc(href)}">${inner}</a>` : `<div class="reply">${inner}</div>`;
}

function renderForward(m, ctx) {
  if (!m.message_snapshots || !m.message_snapshots.length) return '';
  const s = m.message_snapshots[0].message || {};
  const body = [
    s.content ? `<div class="msg-content">${renderMarkdown(s.content, ctx)}</div>` : '',
    (s.attachments || []).map((a) => renderAttachment(a, m, ctx)).join(''),
    (s.embeds || []).map((e, i) => renderEmbed(e, m, ctx, 100 + i)).join(''),
    renderStickers(s.sticker_items, ctx),
  ].join('');
  const when = s.timestamp ? `<span class="muted"> · ${esc(fmtDate(s.timestamp, ctx.settings))}</span>` : '';
  return `<div class="forward"><div class="fw-label">↪ <em>Forwarded</em>${when}</div>${body}</div>`;
}

function renderStickers(items, ctx) {
  if (!items || !items.length) return '';
  return `<div class="stickers">${items.map((st) => {
    const src = stickerUrl(st);
    const url = src ? ctx.media('sticker', src, { sticker: st }) : null;
    return url ? `<img class="sticker" src="${esc(url)}" alt="${esc(st.name)}" title="${esc(st.name)}" loading="lazy">` : `<div class="sticker-name">[Sticker: ${esc(st.name)}]</div>`;
  }).join('')}</div>`;
}

export function shouldGroup(prev, m) {
  if (!prev || !prev.author || !m.author) return false;
  if (prev.author.id !== m.author.id) return false;
  if (isSystem(prev) || isSystem(m) || m.type === MT.REPLY) return false;
  // Slash-command / app responses always get their own header; webhook "personas" share one author id.
  if (m.interaction_metadata || m.interaction || m.type === MT.SLASH || m.type === MT.CONTEXT_MENU) return false;
  if ((m.webhook_id || prev.webhook_id) && (prev.author.username !== m.author.username || prev.author.avatar !== m.author.avatar)) return false;
  if (prev.channel_id !== m.channel_id) return false;
  return Math.abs(new Date(m.timestamp) - new Date(prev.timestamp)) < GROUP_WINDOW;
}

export function renderMessage(m, ctx, { grouped = false } = {}) {
  rememberUsers(m, ctx);
  const app = ctx.mode === 'app';
  const sys = isSystem(m);
  const ts = m.timestamp ? new Date(m.timestamp) : snowflakeToDate(m.id);
  const full = fmtDate(ts, ctx.settings);
  const selected = app && ctx.selected && ctx.selected.has(m.id);
  const author = m.author || { id: '0', username: 'Unknown' };
  const check = app ? `<label class="msg-check" title="Select"><input type="checkbox" data-select="${esc(m.id)}"${selected ? ' checked' : ''}></label>` : '';
  const chan = ctx.showChannel && m.channel_id ? `<span class="msg-chan">#${esc(ctx.channelName(m.channel_id))}</span>` : '';
  const pinned = m.pinned ? '<span class="pin" title="Pinned">📌</span>' : '';

  if (sys) {
    return `<div class="msg system${selected ? ' selected' : ''}" id="m-${esc(m.id)}" data-id="${esc(m.id)}">${check}<div class="msg-gutter"><span class="sys-icon">${sysIcon(m.type)}</span></div><div class="msg-body"><div class="sys-text">${systemText(m, ctx)} <span class="msg-time" title="${esc(full)}">${esc(full)}</span>${chan}</div>${renderReactions(m, ctx)}</div>${app ? actionBar(m, ctx) : ''}</div>`;
  }

  const content = m.content ? renderMarkdown(m.content, ctx) : '';
  const edited = m.edited_timestamp ? ` <span class="edited" title="Edited ${esc(fmtDate(m.edited_timestamp, ctx.settings))}">(edited)</span>` : '';
  const av = ctx.media('avatar', avatarUrl(author, 80), { user: author });
  const gutter = grouped
    ? `<span class="msg-hovertime" title="${esc(full)}">${esc(fmtDate(ts, ctx.settings, { date: false }))}</span>`
    : (av ? `<img class="avatar" src="${esc(av)}" alt="" loading="lazy">` : '<div class="avatar"></div>');
  const badges = app ? `${m._deleted ? '<span class="tag danger">deleted on Discord</span>' : ''}${m._noAccess ? '<span class="tag">no access</span>' : ''}` : '';
  const header = grouped && !badges ? '' : `<div class="msg-header">${grouped ? '' : nameHtml(author, ctx)}<span class="msg-time" title="${esc(full)}">${grouped ? '' : esc(full)}</span>${pinned}${chan}${badges}</div>`;
  // interaction_metadata often has no command name; the older "interaction" object does.
  const interaction = [m.interaction_metadata, m.interaction].find((x) => x && x.name) || null;
  const slash = interaction && interaction.name
    ? `<div class="reply slash"><span class="reply-spine"></span><span class="reply-name">${esc(userName(interaction.user))}</span><span class="reply-text">used /${esc(interaction.name)}</span></div>` : '';
  const thread = m.thread
    ? `<div class="thread-chip"${app ? ` data-thread="${esc(m.thread.id)}"` : ''}>🧵 <strong>${esc(m.thread.name)}</strong> <span class="muted">${m.thread.message_count != null ? `${num(m.thread.message_count)} messages` : 'thread'}</span></div>` : '';

  return `<div class="msg${grouped ? ' grouped' : ''}${selected ? ' selected' : ''}" id="m-${esc(m.id)}" data-id="${esc(m.id)}">${check}<div class="msg-gutter">${gutter}</div><div class="msg-body">${renderReply(m, ctx)}${slash}${header}${content || edited ? `<div class="msg-content">${content}${edited}</div>` : ''}${renderForward(m, ctx)}${(m.attachments || []).map((a) => renderAttachment(a, m, ctx)).join('')}${(m.embeds || []).map((e, i) => renderEmbed(e, m, ctx, i)).join('')}${renderStickers(m.sticker_items, ctx)}${m.poll ? renderPoll(m.poll, ctx) : ''}${renderReactions(m, ctx)}${thread}${grouped && pinned ? pinned : ''}</div>${app ? actionBar(m, ctx) : ''}</div>`;
}

function sysIcon(t) {
  return ({ 1: '➕', 2: '➖', 3: '📞', 4: '✏️', 5: '🖼', 6: '📌', 7: '👋', 8: '🚀', 9: '🚀', 10: '🚀', 11: '🚀', 12: '📣', 18: '🧵', 24: '🛡', 46: '📊' })[t] || 'ℹ️';
}

function actionBar(m, ctx) {
  const mine = m.author && m.author.id === ctx.meId;
  const b = (act, label, icon, danger) => `<button class="act${danger ? ' danger' : ''}" data-act="${act}" data-id="${esc(m.id)}" title="${label}">${icon}</button>`;
  return `<div class="msg-actions">${[
    m.reactions && m.reactions.length ? b('reactions', 'Reactions', '☺') : '',
    b('copylink', 'Copy message link', '🔗'),
    b('copyid', 'Copy message ID', '#'),
    b('open', 'Open in Discord', '↗'),
    mine && !isSystem(m) && !m._package ? b('edit', 'Edit', '✎') : '',
    mine && m.attachments && m.attachments.length ? b('rmatt', 'Remove attachments', '📎') : '',
    b('delete', 'Delete', '🗑', true),
  ].join('')}</div>`;
}

export function renderMessages(list, ctx) {
  let prev = null;
  let out = '';
  for (const m of list) {
    out += renderMessage(m, ctx, { grouped: shouldGroup(prev, m) });
    prev = m;
  }
  return out;
}
