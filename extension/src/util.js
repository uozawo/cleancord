// Small shared helpers. No network access here.

export const API_BASE = 'https://discord.com/api/v9';
export const DISCORD_EPOCH = 1420070400000n;
export const CDN = 'https://cdn.discordapp.com';
export const MEDIA = 'https://media.discordapp.net';

// ---------- snowflakes ----------
export function snowflakeToMs(id) {
  try { return Number((BigInt(id) >> 22n) + DISCORD_EPOCH); } catch { return 0; }
}
export const snowflakeToDate = (id) => new Date(snowflakeToMs(id));
export function msToSnowflake(ms) {
  const v = BigInt(Math.max(0, Math.floor(ms))) - DISCORD_EPOCH;
  return v <= 0n ? '0' : (v << 22n).toString();
}
export function dateToSnowflake(d) {
  const ms = d instanceof Date ? d.getTime() : new Date(d).getTime();
  return Number.isFinite(ms) ? msToSnowflake(ms) : null;
}
export const padId = (id) => String(id).padStart(20, '0');
export function cmpId(a, b) {
  a = String(a); b = String(b);
  return a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);
}
export const minOfIds = (ids) => ids.reduce((m, x) => (m === null || cmpId(x, m) < 0 ? x : m), null);
export const maxOfIds = (ids) => ids.reduce((m, x) => (m === null || cmpId(x, m) > 0 ? x : m), null);
export const decId = (id) => (BigInt(id) - 1n).toString();
export const isSnowflake = (s) => /^\d{15,22}$/.test(String(s || '').trim());

// ---------- strings ----------
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

// Cut index that doesn't split a surrogate pair.
const safeCut = (s, n) => (n > 0 && n < s.length && /[\uD800-\uDBFF]/.test(s[n - 1]) ? n - 1 : n);

export function truncate(s, n) {
  s = String(s ?? '');
  return s.length > n ? s.slice(0, safeCut(s, n - 1)) + '…' : s;
}

export function sanitizeFilename(name, max = 80) {
  let s = String(name ?? '').normalize('NFC')
    .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[. ]+|[. ]+$/g, '');
  if (!s) s = 'untitled';
  if (/^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$)(\..*)?$/i.test(s)) s = '_' + s;
  if (s.length > max) {
    const dot = s.lastIndexOf('.');
    let ext = dot > 0 && s.length - dot <= 10 ? s.slice(dot) : '';
    // Keep a trailing " (id)" so long names of different conversations never collide.
    const id = / \(\d{1,22}\)$/.exec(s.slice(0, s.length - ext.length));
    if (id) ext = id[0] + ext;
    if (ext.length >= max) ext = '';
    s = (s.slice(0, safeCut(s, max - ext.length)).replace(/[. ]+$/, '') || '_') + ext;
  }
  // File systems allow 255 bytes per name; leave room for suffixes like "_2".
  while (utf8Len(s) > 240 && max > 8) s = sanitizeFilename(s, max = Math.floor(max * 0.9));
  return s;
}
const utf8Len = (s) => new TextEncoder().encode(s).length;

// Only http(s) and relative URLs are allowed in href/src attributes (blocks javascript:, data:, etc.).
export function safeUrl(u) {
  const s = String(u ?? '');
  const probe = s.replace(/[\t\n\r]/g, '').replace(/^[\u0000-\u0020]+/, '');
  if (/^[a-z][a-z0-9+.-]*:/i.test(probe) && !/^https?:/i.test(probe)) return '';
  if (/^[\\/]{2}/.test(probe)) return 'https://' + probe.replace(/^[\\/]+/, '');
  return s;
}

export function csvCell(v) {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // stop spreadsheet formula injection
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function humanBytes(n) {
  if (!Number.isFinite(n)) return '?';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n >= 10 || i === 0 ? 0 : 1)} ${u[i]}`;
}

export const fmtNum = (n) => Number(n || 0).toLocaleString();

// ---------- timing ----------
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export function jitterMs(baseSec, spreadSec) {
  const base = Math.max(0, Number(baseSec) || 0);
  const spread = Math.max(0, Number(spreadSec) || 0);
  const min = Math.max(0, base - spread);
  const max = base + spread;
  return (min + Math.random() * (max - min)) * 1000;
}
export function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

// ---------- dates ----------
const p2 = (n) => String(n).padStart(2, '0');
export function fmtDate(input, s = {}, { date = true, time = true, seconds = false } = {}) {
  const d = input instanceof Date ? input : new Date(input);
  if (!Number.isFinite(d.getTime())) return '';
  const utc = s.timezone === 'utc';
  const Y = utc ? d.getUTCFullYear() : d.getFullYear();
  const M = (utc ? d.getUTCMonth() : d.getMonth()) + 1;
  const D = utc ? d.getUTCDate() : d.getDate();
  const h = utc ? d.getUTCHours() : d.getHours();
  const m = utc ? d.getUTCMinutes() : d.getMinutes();
  const sec = utc ? d.getUTCSeconds() : d.getSeconds();
  let ds = '';
  switch (s.dateFormat) {
    case 'iso': ds = `${Y}-${p2(M)}-${p2(D)}`; break;
    case 'mdy': ds = `${p2(M)}/${p2(D)}/${Y}`; break;
    case 'dmy': ds = `${p2(D)}/${p2(M)}/${Y}`; break;
    case 'ymd': ds = `${Y}/${p2(M)}/${p2(D)}`; break;
    default: ds = d.toLocaleDateString(undefined, utc ? { timeZone: 'UTC' } : undefined);
  }
  let ts;
  if (s.timeFormat === '12h') {
    ts = `${h % 12 || 12}:${p2(m)}${seconds ? ':' + p2(sec) : ''} ${h < 12 ? 'AM' : 'PM'}`;
  } else {
    ts = `${p2(h)}:${p2(m)}${seconds ? ':' + p2(sec) : ''}`;
  }
  if (utc && time) ts += ' UTC';
  return [date ? ds : '', time ? ts : ''].filter(Boolean).join(' ');
}

export function discordTimestamp(unix, style, utc = false) {
  const d = new Date(Number(unix) * 1000);
  if (!Number.isFinite(d.getTime())) return String(unix);
  const o = {
    t: { timeStyle: 'short' }, T: { timeStyle: 'medium' }, d: { dateStyle: 'short' }, D: { dateStyle: 'long' },
    f: { dateStyle: 'long', timeStyle: 'short' }, F: { dateStyle: 'full', timeStyle: 'short' },
  }[style || 'f'];
  if (style === 'R') {
    const diff = (d.getTime() - Date.now()) / 1000;
    const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
    const steps = [[60, 'second'], [3600, 'minute'], [86400, 'hour'], [2592000, 'day'], [31536000, 'month'], [Infinity, 'year']];
    let prev = 1;
    for (const [lim, unit] of steps) {
      if (Math.abs(diff) < lim) return rtf.format(Math.round(diff / prev), unit);
      prev = lim;
    }
  }
  const text = new Intl.DateTimeFormat(undefined, utc ? { ...(o || {}), timeZone: 'UTC' } : o || {}).format(d);
  return utc && (!o || o.timeStyle) ? `${text} UTC` : text;
}

export function parseDateInput(v, endOfDay = false) {
  if (!v) return null;
  const d = new Date(v.length <= 10 ? `${v}T${endOfDay ? '23:59:59.999' : '00:00:00'}` : v);
  return Number.isFinite(d.getTime()) ? d : null;
}

// ---------- Discord objects ----------
export const userName = (u) => (u ? u.global_name || u.username || 'Unknown' : 'Unknown');
export const userTag = (u) => (!u ? '' : u.discriminator && u.discriminator !== '0' ? `${u.username}#${u.discriminator}` : u.username);

export function defaultAvatarIndex(u) {
  try {
    if (u.discriminator && u.discriminator !== '0') return Number(u.discriminator) % 5;
    return Number((BigInt(u.id) >> 22n) % 6n);
  } catch { return 0; }
}
export function avatarUrl(u, size = 64) {
  if (!u) return `${CDN}/embed/avatars/0.png`;
  if (u.avatar) return `${CDN}/avatars/${u.id}/${u.avatar}.${u.avatar.startsWith('a_') ? 'gif' : 'png'}?size=${size}`;
  return `${CDN}/embed/avatars/${defaultAvatarIndex(u)}.png`;
}
export const emojiUrl = (id, animated, size = 48) => `${CDN}/emojis/${id}.${animated ? 'gif' : 'png'}?size=${size}`;
export function stickerUrl(st) {
  if (!st || st.format_type === 3) return null; // Lottie stickers can't be shown as an image
  return `${MEDIA}/stickers/${st.id}.${st.format_type === 4 ? 'gif' : 'png'}?size=160`;
}
export const guildIconUrl = (g, size = 64) => (g && g.icon ? `${CDN}/icons/${g.id}/${g.icon}.${g.icon.startsWith('a_') ? 'gif' : 'png'}?size=${size}` : null);
export const roleIconUrl = (r) => (r && r.icon ? `${CDN}/role-icons/${r.id}/${r.icon}.png?size=32` : null);

export function guildInitials(name) {
  return String(name || '?').split(/\s+/).map((w) => w[0]).join('').slice(0, 4);
}

export function encodeEmoji(e) {
  return encodeURIComponent(e.id ? `${e.name}:${e.id}` : e.name);
}

export function parseDiscordLink(str) {
  const s = String(str || '').trim();
  // .../channels/<guild|@me>/<channel>[/threads/<thread>][/<message>]
  const m = /channels\/(@me|\d+)\/(\d+)(?:\/threads\/(\d+))?(?:\/(\d+))?/.exec(s);
  if (m) return { guildId: m[1] === '@me' ? null : m[1], channelId: m[3] || m[2], messageId: m[4] || null };
  if (isSnowflake(s)) return { id: s };
  return null;
}

export const CHANNEL = {
  TEXT: 0, DM: 1, VOICE: 2, GROUP_DM: 3, CATEGORY: 4, ANNOUNCEMENT: 5,
  ANNOUNCEMENT_THREAD: 10, PUBLIC_THREAD: 11, PRIVATE_THREAD: 12, STAGE: 13, DIRECTORY: 14, FORUM: 15, MEDIA: 16,
};
export const MESSAGEABLE = new Set([0, 1, 2, 3, 5, 10, 11, 12, 13]);
export const THREAD_PARENTS = new Set([0, 5, 15, 16]);
export const isThread = (c) => c && (c.type === 10 || c.type === 11 || c.type === 12);

export function channelIcon(c) {
  switch (c?.type) {
    case 2: return '🔊';
    case 13: return '🎙';
    case 5: return '📢';
    case 15: return '💬';
    case 16: return '🖼';
    case 10: case 11: case 12: return '🧵';
    case 1: return '@';
    case 3: return '👥';
    default: return '#';
  }
}

export function dmName(c, meId) {
  if (!c) return 'Unknown';
  if (c.name) return c.name;
  const r = (c.recipients || []).filter((u) => u.id !== meId);
  return r.length ? r.map(userName).join(', ') : 'Unknown user';
}

// Message types (https://discord.com/developers/docs/resources/message#message-object-message-types)
export const MT = {
  DEFAULT: 0, RECIPIENT_ADD: 1, RECIPIENT_REMOVE: 2, CALL: 3, CHANNEL_NAME_CHANGE: 4, CHANNEL_ICON_CHANGE: 5,
  PIN: 6, USER_JOIN: 7, BOOST: 8, BOOST_T1: 9, BOOST_T2: 10, BOOST_T3: 11, FOLLOW_ADD: 12,
  THREAD_CREATED: 18, REPLY: 19, SLASH: 20, THREAD_STARTER: 21, INVITE_REMINDER: 22, CONTEXT_MENU: 23,
  AUTOMOD: 24, STAGE_START: 27, STAGE_END: 28, STAGE_SPEAKER: 29, STAGE_TOPIC: 31, POLL_RESULT: 46,
};
export const NORMAL_TYPES = new Set([0, 19, 20, 23]);
export const NON_DELETABLE_TYPES = new Set([1, 2, 3, 4, 5, 21]);
export const isSystem = (m) => !NORMAL_TYPES.has(m.type);

export function attachmentKind(a) {
  const ct = (a.content_type || '').toLowerCase();
  const name = (a.filename || '').toLowerCase();
  if (ct.startsWith('image/') || /\.(png|jpe?g|gif|webp|avif|bmp)$/.test(name)) return 'image';
  if (ct.startsWith('video/') || /\.(mp4|webm|mov|mkv|m4v)$/.test(name)) return 'video';
  if (ct.startsWith('audio/') || /\.(mp3|ogg|wav|flac|m4a|opus|aac)$/.test(name)) return 'audio';
  return 'file';
}

// The parts of a message that matter for content (forwarded messages keep theirs in a snapshot).
export function messageBody(m) {
  const snap = m.message_snapshots && m.message_snapshots[0] && m.message_snapshots[0].message;
  return {
    content: m.content || (snap ? snap.content || '' : ''),
    attachments: [...(m.attachments || []), ...(snap ? snap.attachments || [] : [])],
    embeds: [...(m.embeds || []), ...(snap ? snap.embeds || [] : [])],
    stickers: [...(m.sticker_items || []), ...(snap ? snap.sticker_items || [] : [])],
  };
}

export function messageLink(m, guildId) {
  return `https://discord.com/channels/${guildId || m.guild_id || '@me'}/${m.channel_id}/${m.id}`;
}

// ---------- DOM ----------
const PROPS = new Set(['checked', 'selected', 'disabled', 'value', 'indeterminate', 'multiple', 'readOnly']);
export function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'html') el.innerHTML = v; // only ever used with strings built by our escaping renderer
      else if (PROPS.has(k)) el[k] = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid instanceof Node ? kid : String(kid));
  }
  return el;
}
// Like el.replaceChildren(), but skips null/false (replaceChildren would print them as text).
export function fill(el, ...kids) {
  el.replaceChildren(...kids.flat(Infinity).filter((k) => k != null && k !== false).map((k) => (k instanceof Node ? k : String(k))));
  return el;
}
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: name, style: { display: 'none' } });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
}

export function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
