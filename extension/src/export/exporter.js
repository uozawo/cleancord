// Export conversations to HTML / JSON / CSV / TXT and download media for offline viewing.
// Messages are streamed from the workspace page by page, so memory use stays flat.

import {
  esc, fmtDate, sanitizeFilename, csvCell, avatarUrl, emojiUrl, stickerUrl, roleIconUrl, userName, userTag, attachmentKind,
  messageLink, messageBody, isSystem, fmtNum, snowflakeToDate, dateToSnowflake,
} from '../util.js';
import { makeContext, renderMessage, shouldGroup, systemText, memberStyle, rememberUsers } from '../render.js';
import { plainText } from '../markdown.js';
import { fetchMedia } from '../api.js';
import { loadHistory, listThreads, canHaveThreads } from '../discord.js';
import { matchesCriteria } from '../criteria.js';

const all = (v) => ({ images: v, videos: v, audio: v, files: v, embedImages: v, embedVideos: v, avatars: v, emojis: v, stickers: v });
const mediaOnly = { ...all(false), images: true, videos: true, audio: true, files: true, embedImages: true, embedVideos: true };

export const DEFAULT_EXPORT_OPTIONS = {
  formats: { html: true, json: false, csv: false, txt: false },
  messagesPerPage: 1000,
  theme: 'dark',
  imageMode: 'hover-safe',
  preview: { images: true, videos: true, audio: true, embedImages: true, embedVideos: true },
  download: { ...all(true), embedVideos: false },
  maxFileMB: 0,
  includeThreads: true,
  separateThreads: true,
  artistMode: false,
  includeReactions: true,
  lookupMembers: true,
};

export const BUILTIN_PRESETS = [
  { name: 'Full archive: HTML + all media', options: { formats: { html: true }, download: all(true) } },
  { name: 'HTML with images (skip videos and files)', options: { formats: { html: true }, download: { ...all(false), images: true, embedImages: true, avatars: true, emojis: true, stickers: true } } },
  { name: 'HTML, media stays online', options: { formats: { html: true }, download: all(false) } },
  { name: 'HTML, text only', options: { formats: { html: true }, download: all(false), preview: { images: false, videos: false, audio: false, embedImages: false, embedVideos: false } } },
  { name: 'JSON (raw Discord data)', options: { formats: { json: true }, download: all(false) } },
  { name: 'CSV spreadsheet', options: { formats: { csv: true }, download: all(false) } },
  { name: 'Plain text', options: { formats: { txt: true }, download: all(false) } },
  { name: 'Media only', options: { formats: {}, download: mediaOnly, artistMode: false } },
  { name: 'Media grouped by author (artist mode)', options: { formats: {}, download: mediaOnly, artistMode: true } },
  { name: 'Everything: HTML + JSON + CSV + TXT + media', options: { formats: { html: true, json: true, csv: true, txt: true }, download: all(true) } },
];

export function applyPreset(base, preset) {
  const o = structuredClone(base);
  const p = preset.options || preset;
  if (p.formats) o.formats = { html: false, json: false, csv: false, txt: false, ...p.formats };
  if (p.download) o.download = { ...all(false), ...p.download };
  if (p.preview) o.preview = { ...o.preview, ...p.preview };
  for (const k of Object.keys(p)) if (!['formats', 'download', 'preview'].includes(k)) o[k] = p[k];
  return o;
}

function urlExt(url, fallback = '') {
  try {
    const m = /\.([a-z0-9]{2,5})$/i.exec(new URL(url).pathname);
    return m ? '.' + m[1].toLowerCase() : fallback;
  } catch { return fallback; }
}
function urlBase(url) {
  try { return decodeURIComponent(new URL(url).pathname.split('/').pop() || 'file'); } catch { return 'file'; }
}
function isDiscordMedia(url) {
  try { return /(^|\.)discordapp\.(com|net)$/.test(new URL(url).hostname); } catch { return false; }
}
// Relative link to a file in the export (each path segment URL-encoded, so "#", "%" or "?" in names work).
const encodePath = (p) => String(p).split('/').map(encodeURIComponent).join('/');
// Text of an HTML snippet built by systemText().
const htmlToText = (s) => s.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
// Folder of a source inside the export (never empty, so no file lands at "/name").
const folderOf = (src) => (src.folder && src.folder.length ? src.folder : [src.title || 'export']);
const rethrowCancel = (e) => { if (e && (e.name === 'CancelledError' || e.name === 'AuthError')) throw e; };

function attachmentExpired(url) {
  try {
    const ex = new URL(url).searchParams.get('ex');
    if (!ex) return /cdn\.discordapp\.com\/attachments\//.test(url);
    return parseInt(ex, 16) * 1000 < Date.now() + 5 * 60 * 1000;
  } catch { return false; }
}

class MediaSaver {
  constructor({ sink, base, opts, api, job, log, roleIconFor = null }) {
    Object.assign(this, { sink, base, opts, api, job, log, roleIconFor });
    this.map = new Map();
    this.failed = new Set();
    this.usedPaths = new Set();
    this.byUrl = new Map();
    this.count = 0;
  }
  key(kind, url, info = {}) {
    switch (kind) {
      case 'avatar': return `avatar:${info.user && info.user.id}:${(info.user && info.user.avatar) || 'd'}`;
      case 'emoji': return `emoji:${info.id}`;
      case 'sticker': return `sticker:${info.sticker && info.sticker.id}`;
      case 'attachment': return `att:${info.m ? info.m.id : ''}:${info.a ? info.a.id || info.a.url : url}`;
      case 'roleicon': return `role:${info.role && info.role.id}`;
      default: return `${kind}:${url}`;
    }
  }
  wants(kind, info = {}) {
    const d = this.opts.download || {};
    switch (kind) {
      case 'attachment': {
        const max = (Number(this.opts.maxFileMB) || 0) * 1024 * 1024;
        if (max && info.a && info.a.size > max) return false;
        return !!({ image: d.images, video: d.videos, audio: d.audio, file: d.files })[info.kind];
      }
      case 'embed': return info.kind === 'video' ? !!d.embedVideos : !!d.embedImages;
      case 'avatar': case 'roleicon': return !!d.avatars;
      case 'emoji': return !!d.emojis;
      case 'sticker': return !!d.stickers;
      default: return false;
    }
  }
  resolve(kind, url, info) {
    const k = this.key(kind, url, info);
    return this.map.has(k) ? encodePath(this.map.get(k)) : url;
  }
  localPath(url) {
    return this.byUrl.get(url) || null;
  }
  pathFor(kind, url, info) {
    const f = (v) => sanitizeFilename(String(v ?? ''), 100); // ids/hashes from stored data never become path segments
    let p;
    switch (kind) {
      case 'avatar': p = `media/avatars/${f(`${info.user.id}_${info.user.avatar || 'default'}`)}${String(info.user.avatar || '').startsWith('a_') ? '.gif' : '.png'}`; break;
      case 'emoji': p = `media/emojis/${f(info.id)}${info.animated ? '.gif' : '.png'}`; break;
      case 'sticker': p = `media/stickers/${f(info.sticker.id)}${urlExt(url, '.png')}`; break;
      case 'roleicon': p = `media/roles/${f(info.role.id)}.png`; break;
      case 'attachment': {
        const name = sanitizeFilename(`${info.m.id}_${(info.a && info.a.filename) || urlBase(url)}`, 120);
        const a = info.m.author;
        p = this.opts.artistMode && a
          ? `media/by-author/${sanitizeFilename(`${userName(a)} (${a.id})`)}/${name}`
          : `media/attachments/${name}`;
        break;
      }
      default: {
        let b = sanitizeFilename(urlBase(url), 80);
        if (!/\.[a-z0-9]{2,5}$/i.test(b)) b += info.kind === 'video' ? '.mp4' : '.jpg';
        p = `media/embeds/${f(`${info.m ? info.m.id : 'x'}_${Number(info.i) || 0}`)}_${b}`;
      }
    }
    if (this.usedPaths.has(p)) {
      // Two different files with the same name: never write (or link) one over the other.
      const slash = p.lastIndexOf('/');
      const dot = p.lastIndexOf('.');
      const stem = dot > slash ? p.slice(0, dot) : p;
      const ext = dot > slash ? p.slice(dot) : '';
      const tag = kind === 'attachment' && info.a && info.a.id ? `_${sanitizeFilename(String(info.a.id), 30)}` : '';
      let q = `${stem}${tag}${ext}`;
      for (let n = 2; this.usedPaths.has(q); n++) q = `${stem}${tag}_${n}${ext}`;
      p = q;
    }
    this.usedPaths.add(p);
    return p;
  }

  collect(messages) {
    const want = new Map();
    const add = (kind, url, info) => {
      if (!url || !isDiscordMedia(url)) return;
      const k = this.key(kind, url, info);
      if (this.map.has(k) || this.failed.has(k) || want.has(k) || !this.wants(kind, info)) return;
      want.set(k, { k, kind, url, info });
    };
    const addEmojis = (text) => {
      for (const m of String(text || '').matchAll(/<(a?):\w+:(\d+)>/g)) add('emoji', emojiUrl(m[2], !!m[1], 96), { id: m[2], animated: !!m[1] });
    };
    const addEmbeds = (m, embeds, offset = 0) => {
      (embeds || []).forEach((e, j) => {
        const i = offset + j;
        for (const t of [e.thumbnail, e.image]) if (t) add('embed', t.proxy_url || t.url, { m, i, kind: 'image' });
        if (e.author && (e.author.proxy_icon_url || e.author.icon_url)) add('embed', e.author.proxy_icon_url || e.author.icon_url, { m, i, kind: 'image' });
        if (e.footer && (e.footer.proxy_icon_url || e.footer.icon_url)) add('embed', e.footer.proxy_icon_url || e.footer.icon_url, { m, i, kind: 'image' });
        if (e.video && (e.type === 'gifv' || e.type === 'video')) add('embed', e.video.proxy_url || e.video.url, { m, i, kind: 'video' });
        addEmojis(e.title);
        addEmojis(e.description);
        for (const f of e.fields || []) { addEmojis(f.name); addEmojis(f.value); }
      });
    };
    for (const m of messages) {
      if (m.author) add('avatar', avatarUrl(m.author, 128), { user: m.author });
      const role = m.author && this.roleIconFor ? this.roleIconFor(m.author.id) : null;
      if (role) add('roleicon', roleIconUrl(role), { role });
      const ra = m.referenced_message && m.referenced_message.author;
      if (ra) add('avatar', avatarUrl(ra, 128), { user: ra });
      for (const a of m.attachments || []) add('attachment', a.url, { m, a, kind: attachmentKind(a) });
      addEmbeds(m, m.embeds);
      addEmojis(m.content);
      const snap = m.message_snapshots && m.message_snapshots[0] && m.message_snapshots[0].message;
      if (snap) {
        for (const a of snap.attachments || []) add('attachment', a.url, { m, a, kind: attachmentKind(a) });
        addEmbeds(m, snap.embeds, 100);
        addEmojis(snap.content);
        for (const st of snap.sticker_items || []) add('sticker', stickerUrl(st), { sticker: st });
      }
      for (const r of m.reactions || []) if (r.emoji && r.emoji.id) add('emoji', emojiUrl(r.emoji.id, r.emoji.animated, 96), { id: r.emoji.id, animated: r.emoji.animated });
      for (const st of m.sticker_items || []) add('sticker', stickerUrl(st), { sticker: st });
      for (const ans of (m.poll && m.poll.answers) || []) {
        const e = ans.poll_media && ans.poll_media.emoji;
        if (e && e.id) add('emoji', emojiUrl(e.id, e.animated, 96), { id: e.id, animated: e.animated });
      }
    }
    return [...want.values()];
  }

  async prepare(messages) {
    const items = this.collect(messages);
    if (!items.length) return;
    const todo = [];
    for (const w of items) {
      w.path = this.pathFor(w.kind, w.url, w.info);
      // Already saved by an earlier run of a resumed export.
      if (await this.sink.exists(`${this.base}/${w.path}`)) this.saved(w);
      else todo.push(w);
    }
    // Refresh expired attachment links in one request per 50.
    const expired = todo.filter((w) => w.kind === 'attachment' && attachmentExpired(w.url));
    for (let i = 0; i < expired.length; i += 50) {
      const chunk = expired.slice(i, i + 50);
      try {
        const r = await this.api.refreshAttachmentUrls(chunk.map((w) => w.url), this.job);
        const map = new Map(((r && r.refreshed_urls) || []).map((x) => [x.original, x.refreshed]));
        for (const w of chunk) if (map.get(w.url)) w.fetchUrl = map.get(w.url);
      } catch (e) {
        if (e.name === 'CancelledError') throw e;
        this.log('warn', `Could not refresh attachment links: ${e.message}`);
      }
    }
    for (const w of todo) {
      await this.job.gate();
      const ok = await this.download(w.fetchUrl || w.url, w.path, w.kind === 'attachment');
      if (ok) this.saved(w); else this.failed.add(w.k);
    }
  }

  saved(w) {
    this.map.set(w.k, w.path);
    this.byUrl.set(w.url, w.path);
    this.count++;
  }

  async download(url, rel, refreshable) {
    const full = `${this.base}/${rel}`;
    let res = null;
    try { res = await fetchMedia(url); } catch { res = null; }
    if ((!res || !res.ok) && refreshable) {
      try {
        const r = await this.api.refreshAttachmentUrls([url], this.job);
        const fresh = r && r.refreshed_urls && r.refreshed_urls[0] && r.refreshed_urls[0].refreshed;
        if (fresh && fresh !== url) res = await fetchMedia(fresh);
      } catch (e) { if (e.name === 'CancelledError') throw e; }
    }
    if (!res || !res.ok) {
      this.log('warn', `Could not download ${urlBase(url)} (${res ? res.status : 'network error'})`);
      return false;
    }
    // The size limit also covers files whose size isn't known up front (data package attachments).
    const max = (Number(this.opts.maxFileMB) || 0) * 1024 * 1024;
    const len = Number(res.headers && res.headers.get ? res.headers.get('content-length') : 0);
    if (max && len > max) {
      try { await res.body.cancel(); } catch { /* ignore */ }
      this.log('info', `Skipped ${urlBase(url)}: larger than ${this.opts.maxFileMB} MB`);
      return false;
    }
    let w;
    try { w = await this.sink.file(full, { compress: false }); } catch (e) {
      if (e.name !== 'TypeError') throw e; // the file system refused the name: skip this file, keep exporting
      this.log('warn', `Could not save ${rel}: ${e.message}`);
      try { await res.body.cancel(); } catch { /* ignore */ }
      return false;
    }
    let ok = true;
    const read = async (fn) => {
      try { return await fn(); } catch (e) {
        ok = false;
        this.log('warn', `Download interrupted for ${urlBase(url)}: ${e.message}`);
        return null;
      }
    };
    try {
      if (!res.body) {
        const buf = await read(() => res.arrayBuffer());
        if (buf) await w.write(new Uint8Array(buf));
      } else {
        const reader = res.body.getReader();
        for (;;) {
          const r = await read(() => reader.read());
          if (!r || r.done) break;
          await w.write(r.value); // write errors (disk full, ...) stop the export
        }
      }
    } finally {
      // Don't leave a truncated file in a folder: a resumed export would take it as complete.
      if (!ok && w.abort) await w.abort(); else await w.close();
    }
    return ok;
  }
}

function htmlNav(pages, current, fileFor) {
  if (pages <= 1) return '';
  const links = [];
  const show = new Set([0, pages - 1, current - 1, current, current + 1, current - 2, current + 2]);
  let gap = false;
  for (let i = 0; i < pages; i++) {
    if (pages > 15 && !show.has(i)) { if (!gap) links.push('<span class="muted">…</span>'); gap = true; continue; }
    gap = false;
    links.push(i === current ? `<strong>${i + 1}</strong>` : `<a href="${esc(fileFor(i))}">${i + 1}</a>`);
  }
  return `<nav class="ex-nav">${current > 0 ? `<a href="${esc(fileFor(current - 1))}">‹ Prev</a>` : ''}${links.join(' ')}${current < pages - 1 ? `<a href="${esc(fileFor(current + 1))}">Next ›</a>` : ''}</nav>`;
}

export function htmlDocument({ title, heading, sub, nav = '', body, css, theme = 'dark', imageMode = 'hover-safe' }) {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="script-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'">
<meta name="referrer" content="no-referrer"><meta name="generator" content="Cleancord">
<title>${esc(title)}</title><style>${css}</style></head>
<body class="theme-${esc(theme)} export img-${esc(imageMode)}">
<header class="ex-head"><div><h1>${esc(heading)}</h1><div class="muted">${sub}</div></div>${nav}</header>
<main class="feed">${body}</main>
<footer class="ex-foot">${nav}<div class="muted">Exported with Cleancord on ${esc(new Date().toLocaleString())}</div></footer>
</body></html>`;
}

const stripInternal = (m) => {
  const o = { ...m };
  for (const k of Object.keys(o)) if (k.startsWith('_')) delete o[k];
  return o;
};

export function createExportHandler(deps) {
  const { api, ws, log } = deps;

  return async function runExport(job) {
    const sink = job.runtime && job.runtime.sink;
    if (!sink) throw new Error('No export destination. Start the export again.');
    try {
      return await run(job, sink);
    } catch (e) {
      // A .zip can't be resumed: discard it instead of leaving a broken file. (Storage-full errors are retried.)
      if (sink.kind !== 'folder' && e.name !== 'StorageFullError' && sink.abort) await sink.abort().catch(() => {});
      throw e;
    }
  };

  async function run(job, sink) {
    const P = job.params;
    const S = job.state;
    const opts = P.options;
    const css = await deps.cssText();
    const settings = deps.settings();
    S.si ??= 0;
    S.phase ??= 'load';
    S.index ??= [];

    // Expand channel sources with their threads once.
    if (!S.sources) {
      const out = [];
      for (const src of P.sources) {
        out.push(src);
        if (src.type !== 'channel' || !opts.includeThreads) continue;
        const ch = deps.channel(src.channelId) || { id: src.channelId, type: src.channelType ?? 0 };
        if (!canHaveThreads(ch)) continue;
        job.setProgress(0, 0, `Finding threads in #${src.title}`);
        let threads = [];
        try { threads = await listThreads(api, ch, job, log); } catch (e) { if (e.name === 'CancelledError') throw e; }
        if (opts.separateThreads) {
          for (const t of threads) {
            out.push({ type: 'channel', channelId: t.id, guildId: src.guildId, title: t.name, channelType: t.type, folder: [...folderOf(src), 'threads', `${t.name} (${t.id})`] });
          }
        } else {
          src.extraChannels = threads.map((t) => t.id);
          src.extraNames = Object.fromEntries(threads.map((t) => [t.id, t.name]));
        }
      }
      S.sources = out;
      await job.save();
    }

    // Phases per source: load (channels only) -> write -> cleanup. The source index only moves on
    // after cleanup, and is saved together with the phase, so a resumed export never redoes or skips one.
    while (S.si < S.sources.length) {
      const src = S.sources[S.si];
      let convKey = src.convKey;
      if (src.type === 'channel') {
        convKey = `exp:${job.id}:${src.channelId}`;
        if (S.phase === 'load') {
          if (!(await ws.getConv(convKey))) {
            await ws.putConv({ key: convKey, kind: 'channel', temp: true, title: src.title, guildId: src.guildId, channelId: src.channelId, count: 0 });
          }
          const c = P.criteria || {};
          const crit = { ...c, after: c.after ? new Date(c.after) : null, before: c.before ? new Date(c.before) : null };
          const minId = crit.after ? dateToSnowflake(crit.after) : null;
          const maxId = crit.before ? dateToSnowflake(crit.before) : null;
          const ch = deps.channel(src.channelId);
          const channels = [];
          if (!(ch && (ch.type === 15 || ch.type === 16)) && src.channelType !== 15 && src.channelType !== 16) channels.push(src.channelId);
          channels.push(...(src.extraChannels || []));
          for (const cid of channels) {
            try {
              await loadHistory({
                api, ws, job, convKey, channelId: cid, minId, maxId,
                filter: (m) => matchesCriteria(m, crit),
                onPage: async (_, conv) => job.setProgress(conv.count || 0, 0, `Fetching #${src.title}: ${fmtNum(conv.count)} messages`),
              });
            } catch (e) {
              if (e.name === 'CancelledError' || e.name === 'AuthError' || e.name === 'StorageFullError') throw e;
              log('warn', `Skipping #${src.title}: ${e.message}`);
            }
          }
          S.phase = 'write';
          await job.save();
        }
      }
      if (S.phase !== 'cleanup') {
        const written = await writeConversation(job, sink, src, convKey, opts, css, settings);
        S.index.push({ title: src.title, folder: folderOf(src), count: written.count, first: written.first });
        S.phase = 'cleanup';
        await job.save();
      }
      if (src.temp || src.type === 'channel') {
        if (!P.keepInWorkspace || src.temp) await ws.deleteConv(convKey);
        else {
          const conv = await ws.getConv(convKey);
          const newKey = `ch:${src.channelId}`;
          if (conv) {
            for await (const batch of ws.iterate(convKey)) await ws.putMessages(newKey, batch);
            const existing = await ws.getConv(newKey);
            const c = P.criteria || {};
            const filtered = Object.values(c).some((x) => (Array.isArray(x) ? x.length : !!x));
            const reachedStart = !filtered && conv.doneChannels && conv.doneChannels[src.channelId];
            const ids = [existing && existing.oldestId, existing && existing.newestId, conv.oldestId, conv.newestId].filter(Boolean);
            const base = existing || { key: newKey, kind: 'channel', title: src.guildId ? `#${src.title}` : src.title, guildId: src.guildId || null, channelId: src.channelId, channelType: src.channelType };
            await ws.putConv({
              ...base, temp: false,
              oldestId: ids.length ? ids.reduce((a, b) => (BigInt(a) < BigInt(b) ? a : b)) : base.oldestId,
              newestId: ids.length ? ids.reduce((a, b) => (BigInt(a) > BigInt(b) ? a : b)) : base.newestId,
              ...(reachedStart ? { complete: true, doneChannels: { ...(base.doneChannels || {}), [src.channelId]: true } } : {}),
              count: await ws.countMessages(newKey),
            });
          }
          await ws.deleteConv(convKey);
        }
      }
      S.phase = 'load';
      S.si++;
      await job.save();
    }

    if (opts.formats.html && S.index.length > 1) {
      const rows = S.index.map((e) => `<li><a href="${esc(e.first ? encodePath(e.folder.map((f) => sanitizeFilename(f)).join('/') + '/' + e.first) : '#')}">${esc(e.folder.join(' / '))}</a> <span class="muted">${fmtNum(e.count)} messages</span></li>`).join('');
      const w = await sink.file('index.html', { compress: true });
      await w.write(htmlDocument({ title: P.rootName || 'Export', heading: P.rootName || 'Export', sub: `${S.index.length} conversations`, body: `<ul class="ex-index">${rows}</ul>`, css, theme: opts.theme, imageMode: opts.imageMode }));
      await w.close();
    }
    const totalWritten = S.index.reduce((n, e) => n + (e.count || 0), 0);
    job.setProgress(1, 1, 'Finishing archive');
    await sink.finish();
    log('ok', `Export finished: ${fmtNum(totalWritten)} messages${sink.kind === 'folder' ? ' saved to the folder you chose' : ''}.`);
    return { count: totalWritten };
  }

  async function writeConversation(job, sink, src, convKey, opts, css, settings) {
    const total = await ws.countMessages(convKey);
    const base = folderOf(src).map((f) => sanitizeFilename(f)).join('/');
    const fileBase = sanitizeFilename(src.title || 'messages', 60);
    const perPage = Math.max(1, Number(opts.messagesPerPage) || 1000);
    const pages = Math.max(1, Math.ceil(total / perPage));
    const pageFile = (i) => `${fileBase}${pages > 1 ? `_page_${i + 1}` : ''}.html`;
    const roles = src.guildId ? await deps.getRoles(src.guildId).catch((e) => { rethrowCancel(e); return new Map(); }) : new Map();
    const pageOf = new Map();
    let currentPage = 0;
    const channels = new Map(deps.channelNames());
    for (const [id, name] of Object.entries(src.extraNames || {})) channels.set(id, name);
    if (src.channelId && src.title && !channels.has(src.channelId)) channels.set(src.channelId, src.title);
    const ctx = makeContext({
      mode: 'export', settings, meId: deps.meId(), guildId: src.guildId, roles, members: new Map(),
      channels, preview: opts.preview, includeReactions: opts.includeReactions,
      showChannel: !!src.showChannel || !!(src.extraChannels && src.extraChannels.length), imageMode: opts.imageMode,
      media: (k, u, i) => saver.resolve(k, u, i),
      linkFor: (id) => {
        if (!pageOf.has(id)) return null;
        const p = pageOf.get(id);
        return p === currentPage ? `#m-${id}` : `${encodePath(pageFile(p))}#m-${id}`;
      },
    });
    const roleIconFor = (uid) => {
      const st = memberStyle(uid, ctx);
      return st.icon && st.icon.icon ? st.icon : null;
    };
    const saver = new MediaSaver({ sink, base, opts, api, job, log, roleIconFor });
    const anyDownload = Object.values(opts.download || {}).some(Boolean);
    const firstLast = { first: null, last: null };
    const label = folderOf(src).join(' / ');
    // Server nicknames (and role colours/icons) for the authors of a batch, looked up once per author.
    const looked = new Set();
    const lookupMembers = async (list) => {
      if (!src.guildId || !opts.lookupMembers) return;
      const ids = [...new Set(list.map((m) => m.author && m.author.id).filter(Boolean))].filter((id) => !looked.has(id));
      if (!ids.length) return;
      for (const id of ids) looked.add(id);
      const mm = await deps.getMembers(src.guildId, ids, job).catch((e) => { rethrowCancel(e); return new Map(); });
      for (const [k, v] of mm) if (v) ctx.members.set(k, v);
    };
    // Per-message author name (webhook messages share one author id, so don't go through ctx.users).
    const nameOf = (u) => (u && u.id && ctx.members.get(u.id) && ctx.members.get(u.id).nick) || userName(u);
    const when = (m) => m.timestamp || snowflakeToDate(m.id);

    if (opts.formats.html || anyDownload) {
      let buf = [];
      let done = 0;
      const flush = async () => {
        await lookupMembers(buf);
        await saver.prepare(buf);
        if (opts.formats.html) {
          let prev = null;
          let body = '';
          for (const m of buf) { body += renderMessage(m, ctx, { grouped: shouldGroup(prev, m) }); prev = m; }
          if (!buf.length) body = '<div class="empty">No messages.</div>';
          const range = buf.length ? `${fmtDate(when(buf[0]), settings)} – ${fmtDate(when(buf[buf.length - 1]), settings)}` : '';
          const nav = htmlNav(pages, currentPage, (i) => encodePath(pageFile(i)));
          const w = await sink.file(`${base}/${pageFile(currentPage)}`, { compress: true });
          await w.write(htmlDocument({
            title: `${src.title} – page ${currentPage + 1}`, heading: label,
            sub: `${fmtNum(total)} messages${pages > 1 ? ` · page ${currentPage + 1} of ${pages}` : ''}${range ? ' · ' + esc(range) : ''}`,
            nav, body, css, theme: opts.theme, imageMode: opts.imageMode,
          }));
          await w.close();
        }
        done += buf.length;
        job.setProgress(done, total, `${label}: page ${currentPage + 1}/${pages}${saver.count ? ` · ${fmtNum(saver.count)} files` : ''}`);
        currentPage++;
        buf = [];
      };
      let idx = 0;
      for await (const batch of ws.iterate(convKey, 500)) {
        for (const m of batch) {
          pageOf.set(m.id, Math.floor(idx / perPage));
          idx++;
          buf.push(m);
          if (buf.length >= perPage) await flush();
        }
      }
      if (buf.length || (total === 0 && opts.formats.html)) await flush();
    }

    const local = (url) => saver.localPath(url) || url;
    const textCtx = { userName: ctx.userName, role: ctx.role, channelName: ctx.channelName };

    if (opts.formats.json) {
      const w = await sink.file(`${base}/${fileBase}.json`, { compress: true });
      await w.write(`{"exported_with":"Cleancord","exported_at":${JSON.stringify(new Date().toISOString())},"source":${JSON.stringify({ title: src.title, folder: src.folder, guild_id: src.guildId || null, channel_id: src.channelId || null })},"message_count":${total},"messages":[\n`);
      let first = true;
      for await (const batch of ws.iterate(convKey, 500)) {
        await w.write((first ? '' : ',\n') + batch.map((m) => JSON.stringify(stripInternal(m))).join(',\n'));
        first = false;
      }
      await w.write('\n]}\n');
      await w.close();
    }

    if (opts.formats.csv) {
      const w = await sink.file(`${base}/${fileBase}.csv`, { compress: true });
      const cols = ['message_id', 'timestamp', 'edited_timestamp', 'channel_id', 'channel', 'author_id', 'author_username', 'author_name', 'content', 'attachments', 'embeds', 'reactions', 'reply_to', 'type', 'pinned', 'thread', 'link'];
      await w.write('﻿' + cols.join(',') + '\r\n');
      for await (const batch of ws.iterate(convKey, 500)) {
        await lookupMembers(batch);
        let out = '';
        for (const m of batch) {
          rememberUsers(m, ctx);
          const a = m.author || {};
          const b = messageBody(m);
          const row = [
            m.id, fmtDate(when(m), settings, { seconds: true }), m.edited_timestamp ? fmtDate(m.edited_timestamp, settings, { seconds: true }) : '',
            m.channel_id, ctx.channelName(m.channel_id), a.id, userTag(a), nameOf(a),
            isSystem(m) ? htmlToText(systemText(m, ctx)) : b.content,
            b.attachments.map((x) => local(x.url)).join(' | '),
            b.embeds.map((e) => e.title || e.url || e.type).join(' | '),
            (m.reactions || []).map((r) => `${r.emoji && r.emoji.id ? ':' + r.emoji.name + ':' : (r.emoji && r.emoji.name) || '?'} ${r.count}`).join('; '),
            m.message_reference && m.message_reference.message_id ? m.message_reference.message_id : '',
            m.type, m.pinned ? 'yes' : '', m.thread ? m.thread.name : '', messageLink(m, src.guildId),
          ];
          out += row.map(csvCell).join(',') + '\r\n';
        }
        await w.write(out);
      }
      await w.close();
    }

    if (opts.formats.txt) {
      const w = await sink.file(`${base}/${fileBase}.txt`, { compress: true });
      await w.write(`${label}\n${fmtNum(total)} messages · exported ${new Date().toLocaleString()}\n${'='.repeat(60)}\n\n`);
      for await (const batch of ws.iterate(convKey, 500)) {
        await lookupMembers(batch);
        let out = '';
        for (const m of batch) {
          rememberUsers(m, ctx);
          const at = fmtDate(when(m), settings);
          const a = m.author || {};
          if (isSystem(m)) { out += `[${at}] * ${htmlToText(systemText(m, ctx))}\n`; continue; }
          if (m.referenced_message) out += `  ┌ reply to ${nameOf(m.referenced_message.author)}: ${plainText(m.referenced_message.content, textCtx).slice(0, 80)}\n`;
          out += `[${at}] ${nameOf(a)} (${userTag(a)}): ${m.content || ''}${m.edited_timestamp ? ' (edited)' : ''}\n`;
          const snap = m.message_snapshots && m.message_snapshots[0] && m.message_snapshots[0].message;
          if (snap && snap.content) out += `  ↪ forwarded: ${snap.content}\n`;
          for (const x of messageBody(m).attachments) out += `  📎 ${x.filename}: ${local(x.url)}\n`;
          for (const e of m.embeds || []) if (e.title || e.url) out += `  🔗 ${[e.title, e.url].filter(Boolean).join(' – ')}\n`;
          if (m.reactions && m.reactions.length) out += `  reactions: ${m.reactions.map((r) => `${r.emoji && r.emoji.id ? ':' + r.emoji.name + ':' : (r.emoji && r.emoji.name) || '?'} ${r.count}`).join('  ')}\n`;
        }
        await w.write(out);
      }
      await w.close();
    }

    if (!opts.formats.html && !opts.formats.json && !opts.formats.csv && !opts.formats.txt) {
      job.setProgress(total, total, `${label}: ${fmtNum(saver.count)} files`);
    }
    firstLast.first = opts.formats.html ? pageFile(0) : null;
    return { count: total, first: firstLast.first };
  }
}
