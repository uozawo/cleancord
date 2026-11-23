// Discord-flavoured markdown -> safe HTML. All user text is HTML-escaped before any tags are added.

import { esc, discordTimestamp } from './util.js';

const EMOJI_ONLY = /^(?:\s|<a?:\w{1,64}:\d+>|\p{Extended_Pictographic}|\p{Emoji_Modifier}|\p{Regional_Indicator}|‍|️|⃣|[#*0-9](?=️?⃣))+$/u;
const MAX_JUMBO = 30; // Discord only enlarges messages with up to 30 emoji

function countEmoji(text) {
  const custom = (text.match(/<a?:\w+:\d+>/g) || []).length;
  const rest = text.replace(/<a?:\w+:\d+>|\s/g, '');
  if (!rest) return custom;
  if (typeof Intl !== 'undefined' && Intl.Segmenter) return custom + [...new Intl.Segmenter().segment(rest)].length;
  return custom + (rest.match(/\p{Extended_Pictographic}|\p{Regional_Indicator}{2}/gu) || []).length;
}

export function isJumbo(text) {
  if (!text || text.length > 400 || !EMOJI_ONLY.test(text)) return false;
  return /<a?:\w+:\d+>|\p{Extended_Pictographic}|\p{Regional_Indicator}|⃣/u.test(text) && countEmoji(text) <= MAX_JUMBO;
}

function roleColor(r) {
  const c = Number((r && r.colors && r.colors.primary_color) || (r && r.color) || 0);
  return c > 0 && c <= 0xffffff ? '#' + c.toString(16).padStart(6, '0') : '';
}

const count = (s, ch) => s.split(ch).length - 1;

// Trailing punctuation / formatting markers after a bare URL aren't part of it (unless a ")" closes a "(").
function splitUrlTail(url) {
  let tail = '';
  for (;;) {
    const m = /(?:[.,!?;:'\]]|&#39;|\*+|_+|~~|\|\|)$/.exec(url);
    if (m) { tail = m[0] + tail; url = url.slice(0, m.index); continue; }
    if (url.endsWith(')') && count(url, '(') < count(url, ')')) { tail = ')' + tail; url = url.slice(0, -1); continue; }
    return [url, tail];
  }
}

export function renderMarkdown(text, ctx = {}, { inlineOnly = false } = {}) {
  if (!text) return '';
  const slots = [];
  const slot = (html) => `\u0000${slots.push(html) - 1}\u0000`;
  let s = String(text).replace(/\u0000/g, '');
  const utc = !!(ctx.settings && ctx.settings.timezone === 'utc');

  // 1. code blocks, inline code, backslash escapes (kept literal)
  s = s.replace(/```(?:([\w+#.-]{1,24})\n)?([\s\S]*?)```/g, (_, lang, code) =>
    slot(`<pre class="md-pre"><code${lang ? ` data-lang="${esc(lang)}"` : ''}>${esc(code.replace(/^\n+|\n+$/g, ''))}</code></pre>`));
  // Escapes and inline code in one left-to-right pass: "\`x\`" is not code, and "`a\_b`" keeps its backslash.
  s = s.replace(/\\([^0-9A-Za-z\s])|(`+)([\s\S]*?[^`])\2(?!`)/gu, (_, c, ticks, code) => (c
    ? slot(esc(c))
    : slot(`<code class="md-code">${esc(code.replace(/^ (?= *`)|(` *) $/g, '$1'))}</code>`)));

  // 2. escape everything else
  s = esc(s);

  // Slot markers (\u0000N\u0000) are never allowed inside URLs, so a slot is never nested in another slot.
  const inline = (t) => {
    // masked links [text](url) and <url>
    t = t.replace(/\[([^\]\n]{1,256})\]\((?:&lt;)?(https?:\/\/(?:\([^\s()\u0000]*\)|(?!&gt;|&lt;|&quot;)[^\s()\u0000])+)(?:&gt;)?\)/g,
      (_, label, url) => slot(`<a class="md-link" href="${url}" title="${url}" target="_blank" rel="noopener noreferrer">`)
        + label.replace(/:\/\//g, () => slot('://')) + slot('</a>'));
    t = t.replace(/&lt;(https?:\/\/[^\s\u0000]+?)&gt;|(https?:\/\/(?:(?!&lt;|&gt;|&quot;)[^\s\u0000])+)/g, (_, a, b) => {
      const [url, tail] = b ? splitUrlTail(b) : [a, ''];
      return slot(`<a class="md-link" href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`) + tail;
    });
    // mentions, emoji, timestamps, slash commands
    t = t.replace(/&lt;@!?(\d+)&gt;/g, (_, id) => slot(`<span class="md-mention">@${esc(ctx.userName ? ctx.userName(id) : id)}</span>`));
    t = t.replace(/&lt;@&amp;(\d+)&gt;/g, (_, id) => {
      const r = ctx.role ? ctx.role(id) : null;
      const col = roleColor(r);
      return slot(`<span class="md-mention"${col ? ` style="color:${col};background:${col}22"` : ''}>@${esc(r ? r.name : 'unknown-role')}</span>`);
    });
    t = t.replace(/&lt;#(\d+)&gt;/g, (_, id) => slot(`<span class="md-mention">#${esc(ctx.channelName ? ctx.channelName(id) : id)}</span>`));
    t = t.replace(/&lt;(a?):(\w{1,64}):(\d+)&gt;/g, (_, a, name, id) => {
      const src = ctx.emojiSrc ? ctx.emojiSrc(id, !!a) : null;
      return slot(src ? `<img class="md-emoji" src="${esc(src)}" alt=":${esc(name)}:" title=":${esc(name)}:" loading="lazy">` : `:${esc(name)}:`);
    });
    t = t.replace(/&lt;t:(-?\d{1,13})(?::([tTdDfFR]))?&gt;/g, (_, ts, st) =>
      slot(`<span class="md-time" title="${esc(discordTimestamp(ts, 'F', utc))}">${esc(discordTimestamp(ts, st, utc))}</span>`));
    t = t.replace(/&lt;\/([\w -]{1,64}):(\d+)&gt;/g, (_, name) => slot(`<span class="md-mention">/${esc(name)}</span>`));
    t = t.replace(/@(everyone|here)\b/g, (_, w) => slot(`<span class="md-mention">@${w}</span>`));
    // formatting (may span lines inside one paragraph or quote)
    t = t.replace(/\*\*\*([\s\S]+?)\*\*\*/g, '<strong><em>$1</em></strong>');
    t = t.replace(/\*\*([\s\S]+?)\*\*/g, '<strong>$1</strong>');
    t = t.replace(/__([\s\S]+?)__/g, '<u>$1</u>');
    t = t.replace(/(^|[^\w*])\*(?!\s)([\s\S]+?)(?<!\s)\*(?![\w*])/g, '$1<em>$2</em>');
    t = t.replace(/(^|[^\w])_([\s\S]+?)_(?!\w)/g, '$1<em>$2</em>');
    t = t.replace(/~~([\s\S]+?)~~/g, '<s>$1</s>');
    t = t.replace(/\|\|([\s\S]+?)\|\|/g, '<span class="md-spoiler" tabindex="0">$1</span>');
    return t;
  };
  // Inline formatting over several lines joined by \n; the newlines become <br>.
  const inlineLines = (lines) => inline(lines.join('\n')).replace(/\n/g, '<br>');

  const blocks = (lines, inQuote) => {
    let out = '';
    let prevBlock = true;
    const push = (part, block) => {
      if (!block && !prevBlock) out += '<br>';
      out += part;
      prevBlock = block;
    };
    let para = null;
    let quote = null;
    const flushPara = () => {
      if (para) push(inlineLines(para), false);
      para = null;
    };
    const flushQuote = () => {
      if (quote) push(`<blockquote class="md-quote">${blocks(quote, true)}</blockquote>`, true);
      quote = null;
    };
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!inQuote) {
        if (/^&gt;&gt;&gt;(\s|$)/.test(line)) {
          flushPara();
          flushQuote();
          push(`<blockquote class="md-quote">${blocks([line.replace(/^&gt;&gt;&gt;\s?/, ''), ...lines.slice(i + 1)], true)}</blockquote>`, true);
          return out;
        }
        const q = /^&gt; (.*)$/.exec(line);
        if (q) { flushPara(); (quote ||= []).push(q[1]); continue; }
        flushQuote();
      }
      let m;
      if ((m = /^(#{1,3}) (.+)$/.exec(line))) { flushPara(); push(`<div class="md-h${m[1].length}">${inline(m[2])}</div>`, true); }
      else if ((m = /^-# (.+)$/.exec(line))) { flushPara(); push(`<div class="md-sub">${inline(m[1])}</div>`, true); }
      else if ((m = /^(\s*)[-*] (.+)$/.exec(line))) { flushPara(); push(`<div class="md-li" style="margin-left:${Math.min(m[1].length, 8) * 8 + 4}px">•&nbsp;${inline(m[2])}</div>`, true); }
      else if ((m = /^(\s*)(\d{1,3})\. (.+)$/.exec(line))) { flushPara(); push(`<div class="md-li" style="margin-left:${Math.min(m[1].length, 8) * 8 + 4}px">${m[2]}.&nbsp;${inline(m[3])}</div>`, true); }
      else if (/^\u0000\d+\u0000$/.test(line) && slots[Number(line.slice(1, -1))].startsWith('<pre')) { flushPara(); push(line, true); }
      else (para ||= []).push(line);
    }
    flushPara();
    flushQuote();
    return out;
  };

  let html = inlineOnly ? inline(s.replace(/\n/g, ' ')) : blocks(s.split('\n'), false);
  html = html.replace(/\u0000(\d+)\u0000/g, (_, i) => slots[Number(i)]);
  return isJumbo(text) ? `<span class="md-jumbo">${html}</span>` : html;
}

// Plain text preview (for reply bars and txt): strips the markdown syntax, hides spoilers.
export function plainText(text, ctx = {}) {
  const slots = [];
  const slot = (s) => `\u0000${slots.push(s) - 1}\u0000`;
  return String(text || '').replace(/\u0000/g, '')
    .replace(/```(?:[\w+#.-]{1,24}\n)?([\s\S]*?)```/g, (_, c) => slot(c))
    .replace(/(`+)([\s\S]*?[^`])\1(?!`)/g, (_, t, c) => slot(c))
    .replace(/\|\|[\s\S]+?\|\|/g, () => slot('▒▒▒▒'))
    .replace(/<@!?(\d+)>/g, (_, id) => slot('@' + (ctx.userName ? ctx.userName(id) : id)))
    .replace(/<@&(\d+)>/g, (_, id) => slot('@' + ((ctx.role && ctx.role(id)) ? ctx.role(id).name : 'role')))
    .replace(/<#(\d+)>/g, (_, id) => slot('#' + (ctx.channelName ? ctx.channelName(id) : id)))
    .replace(/<a?:(\w+):\d+>/g, (_, n) => slot(`:${n}:`))
    .replace(/<t:(-?\d{1,13})(?::([tTdDfFR]))?>/g, (_, t, st) => slot(discordTimestamp(t, st, !!(ctx.settings && ctx.settings.timezone === 'utc'))))
    .replace(/<\/([\w -]{1,64}):\d+>/g, (_, n) => slot('/' + n))
    .replace(/\[([^\]\n]{1,256})\]\(<?https?:\/\/[^\s)>]+>?\)/g, '$1')
    .replace(/<?(https?:\/\/[^\s<>]+)>?/g, (_, u) => slot(u))
    .replace(/\\([^0-9A-Za-z\s])/gu, (_, c) => slot(c))
    .replace(/^(?:#{1,3}|-#|>>>|>) /gm, '')
    .replace(/\*\*|__|~~|(?<![\w*])\*(?=\S)|(?<=\S)\*(?![\w*])|(?<!\w)_(?=\S)|(?<=\S)_(?!\w)/g, '')
    .replace(/\u0000(\d+)\u0000/g, (_, i) => slots[Number(i)])
    .replace(/\s+/g, ' ')
    .trim();
}
