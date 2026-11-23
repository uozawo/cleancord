// Extra tests for rendering, markdown, export, ZIP and data package (reviewer: export/render area).
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import './mock-discord.js';

const SRC = new URL('../extension/src/', import.meta.url).href;
globalThis.chrome = { storage: { local: { get: async () => ({}), set: async () => {} }, session: { get: async () => ({}) } } };

const { createApi } = await import(SRC + 'api.js');
const { Workspace } = await import(SRC + 'db.js');
const { Job } = await import(SRC + 'jobs.js');
const { createExportHandler, DEFAULT_EXPORT_OPTIONS, BUILTIN_PRESETS, applyPreset } = await import(SRC + 'export/exporter.js');
const { ZipWriter } = await import(SRC + 'export/zip.js');
const { ZipReader } = await import(SRC + 'package/zipreader.js');
const { DataPackage } = await import(SRC + 'package/datapkg.js');
const { renderMarkdown, plainText, isJumbo } = await import(SRC + 'markdown.js');
const { makeContext, renderMessage, renderMessages, shouldGroup } = await import(SRC + 'render.js');
const { computeAnalytics, analyticsCsv } = await import(SRC + 'analytics.js');
const { sanitizeFilename, safeUrl, truncate, parseDiscordLink } = await import(SRC + 'util.js');

let passed = 0;
const test = async (name, fn) => {
  try { await fn(); passed++; console.log('  ✔', name); } catch (e) { console.log('  ✖', name); console.log(e); process.exitCode = 1; }
};
const settings = { modifyDelay: 0, searchDelay: 0, delaySpread: 0, dateFormat: 'iso', timeFormat: '24h', timezone: 'utc', lookupMembers: true, memberCacheHours: 24 };
function setup(opts = {}) {
  const mock = globalThis.createMockDiscord(opts);
  globalThis.fetch = mock.fetch;
  const api = createApi({ getAuth: async () => ({ token: 'test-token', headers: {} }), getSettings: () => settings, log: () => {} });
  return { mock, api };
}
let wsN = 0;
const openWs = () => Workspace.open('extra' + wsN++);
class MemSink {
  constructor() { this.kind = 'folder'; this.files = new Map(); this.finished = false; }
  async exists(p) { return this.files.has(p) && this.files.get(p).length > 0; }
  async file(path) {
    const chunks = [];
    return {
      write: async (c) => chunks.push(Buffer.from(c)),
      close: async () => { this.files.set(path, Buffer.concat(chunks)); },
      abort: async () => {},
    };
  }
  async finish() { this.finished = true; }
}
// Every tag in the output must be one we generate, with no event handlers / scripts / bad URLs.
function assertSafeHtml(html) {
  assert(!/<script|<iframe|<object|<embed|<svg|<math|<style|<link|<meta|<form|<base/i.test(html), 'dangerous tag: ' + html);
  for (const tag of html.match(/<[a-z][^>]*>/gi) || []) {
    const attrs = tag.replace(/"[^"]*"/g, '""');
    assert(!/\son[a-z]+\s*=/i.test(attrs), 'event handler attribute: ' + tag);
    assert(/^<[a-z][a-z0-9]*(\s+[a-z-]+(="")?)*\s*\/?>$/i.test(attrs), 'malformed tag: ' + tag);
  }
  for (const m of html.matchAll(/\s(href|src|data-lightbox)="([^"]*)"/g)) {
    const v = m[2].replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/[\t\n\r]/g, '').trim();
    assert(v === '' || v === '#' || /^https?:\/\//i.test(v) || /^#m-\d+$/.test(v) || !/^[a-z][a-z0-9+.-]*:/i.test(v), 'bad URL ' + v);
    assert(!v.includes('\u0000'), 'NUL in URL');
  }
  assert(!html.includes('\u0000'), 'slot marker leaked: ' + JSON.stringify(html));
  for (const m of html.matchAll(/\sstyle="([^"]*)"/g)) assert(/^[\w\s:;#%/.()-]*$/.test(m[1]) && !/url\(|expression/i.test(m[1]), 'bad style ' + m[1]);
}

console.log('markdown');
const ctx0 = makeContext({ users: new Map([['1', { id: '1', username: 'bob_the_builder', global_name: 'Bob_B' }]]), roles: new Map([['5', { id: '5', name: 'Mods', color: 0xff0000 }]]) });
await test('hostile message content never produces markup/handlers/scripts', () => {
  const vectors = [
    '<img src=x onerror=alert(1)>', '"><svg/onload=alert(1)>', "'><script>alert(1)</script>",
    '[x](javascript:alert(1))', '[x](https://a.com/"onmouseover="alert(1))', "[x](https://a.com/'onmouseover='alert(1))",
    '<https://a.com/"onmouseover=alert(1)//>', 'https://a.com/"><img src=x onerror=alert(1)>',
    '[a](https://a.com/`b`)', '[`x`](https://a.com/\\`)', '``` </code><script>x</script>```', '```"><img onerror=1>\n```',
    '<:x" onerror="alert(1):123>', '<t:1" onmouseover="x>', '</x" onmouseover="y:1>', '<@1"onx=1>', '||<b>||', '**<i>**',
    '[**x**](https://a.com)**', '\\<script>', '\u0000 0 \u0000', '\u00000\u0000', 'a\u00001\u0000b [x](https://y.com)',
    '[https://evil.com](https://good.com)', '> [x](https://a.com/"x)\n>>> <b>', '# <h1>\n-# <x>\n- <li>',
    '[x](https://a.com/(a"b))', 'https://a.com/(x)"<y>', '<a:a:1> <a:b" c:1>', '@everyone<script>',
  ];
  for (const v of vectors) {
    const html = renderMarkdown(v, ctx0);
    assertSafeHtml(html);
    assert(!/<(?!\/?(strong|em|u|s|span|a|code|pre|br|div|blockquote|img)\b)[a-z]/i.test(html), `unexpected tag for ${JSON.stringify(v)}: ${html}`);
  }
});
await test('masked link label that is a URL shows the real destination, no nested anchors', () => {
  const html = renderMarkdown('[https://evil.com](https://good.com)', ctx0);
  assert.equal((html.match(/<a /g) || []).length, 1);
  assert(html.includes('href="https://good.com"') && html.includes('title="https://good.com"'));
});
await test('multi-line bold / spoiler / quotes / headers in quotes', () => {
  assert(renderMarkdown('**a\nb**').startsWith('<strong>a<br>b</strong>'));
  assert(renderMarkdown('||secret\nline||').includes('<span class="md-spoiler" tabindex="0">secret<br>line</span>'));
  assert(renderMarkdown('> # Title\n> text').includes('<blockquote class="md-quote"><div class="md-h1">Title</div>text</blockquote>'));
  assert.equal(renderMarkdown('a\n\nb'), 'a<br><br>b');
});
await test('autolinks: balanced parens, trailing punctuation and wrapped by formatting', () => {
  assert(renderMarkdown('https://en.wikipedia.org/wiki/Foo_(bar)').includes('href="https://en.wikipedia.org/wiki/Foo_(bar)"'));
  assert(renderMarkdown('(see https://a.com/x).').includes('href="https://a.com/x"'));
  const sp = renderMarkdown('||https://a.com/x||');
  assert(sp.includes('md-spoiler') && sp.includes('href="https://a.com/x"'), sp);
  const b = renderMarkdown('**https://a.com/x**');
  assert(b.includes('<strong><a') && b.includes('href="https://a.com/x"'), b);
  assert(renderMarkdown('https://a.com/~x~').includes('href="https://a.com/~x~"'));
});
await test('inline code with double backticks, escapes of any punctuation', () => {
  assert(renderMarkdown('``a`b``').includes('<code class="md-code">a`b</code>'));
  assert.equal(renderMarkdown('1\\. not a list'), '1. not a list');
  assert.equal(renderMarkdown('\\> no quote'), '&gt; no quote');
});
await test('unknown user mention shows unknown-user; role colour is validated', () => {
  assert(renderMarkdown('<@999>', makeContext()).includes('@unknown-user'));
  const bad = makeContext({ roles: new Map([['5', { id: '5', name: 'x', color: 'red;background:url(//evil)' }]]) });
  assert(!renderMarkdown('<@&5>', bad).includes('style='));
});
await test('jumbo only up to 30 emoji', () => {
  assert(isJumbo('😀'.repeat(30)));
  assert(!isJumbo('😀'.repeat(31)));
  assert(isJumbo('👨‍👩‍👧‍👦 👍🏽'));
});
await test('plainText keeps names intact, hides spoilers', () => {
  const t = plainText('**hi** <@1> snake_case ||secret|| `co_de` _it_', ctx0);
  assert.equal(t, 'hi @Bob_B snake_case ▒▒▒▒ co_de it');
});

console.log('render');
await test('dangerous URLs from (imported) data are dropped from href/src', () => {
  const ctx = makeContext({ mode: 'export', settings, linkFor: () => null });
  const m = {
    id: '1', channel_id: '2', type: 0, timestamp: '2024-01-01T00:00:00Z', content: 'x', author: { id: '3', username: 'u' },
    attachments: [
      { id: '9', filename: 'a.png', content_type: 'image/png', url: 'java\nscript:alert(1)', width: '1" onerror="x', height: 2 },
      { id: '8', filename: 'b.bin', url: 'javascript:alert(2)', size: '<b>' },
    ],
    embeds: [{ type: 'rich', title: 't', url: 'javascript:alert(3)', author: { name: 'n', url: 'data:text/html,x' }, image: { url: 'javascript:x' }, color: 'red;x:y' }],
    reactions: [{ emoji: { name: '<b>' }, count: '<img src=x onerror=alert(1)>' }],
    poll: { question: { text: 'q' }, answers: [{ answer_id: 1, poll_media: { text: 'a' } }], results: { answer_counts: [{ id: 1, count: '"><img onerror=1>' }] } },
    thread: { id: '4', name: 'th', message_count: '<b>x</b>' },
  };
  const html = renderMessage(m, ctx);
  assertSafeHtml(html);
  assert(!/javascript|data:text/i.test(html.replace(/>[^<]*</g, '><')), html);
  assert(!html.includes('<b>x</b>') && !html.includes('<img src=x'));
});
await test('reply: deleted (null) vs not loaded (undefined) vs forwarded/sticker previews', () => {
  const ctx = makeContext({ settings });
  const base = { id: '10', channel_id: '2', type: 19, timestamp: '2024-01-01T00:00:00Z', content: 'r', author: { id: '3', username: 'u' }, message_reference: { message_id: '9' } };
  assert(renderMessage({ ...base, referenced_message: null }, ctx).includes('Original message was deleted'));
  const notLoaded = renderMessage({ ...base }, ctx);
  assert(notLoaded.includes('data-jump="9"') && !notLoaded.includes('deleted'));
  const st = renderMessage({ ...base, referenced_message: { id: '9', author: { id: '4', username: 'x' }, content: '', sticker_items: [{ id: '1', name: 's' }] } }, ctx);
  assert(st.includes('Sticker'));
  const fw = renderMessage({ ...base, referenced_message: { id: '9', author: { id: '4', username: 'x' }, content: '', message_snapshots: [{ message: { content: 'fwd text' } }] } }, ctx);
  assert(fw.includes('fwd text'));
});
await test('slash command name comes from interaction when interaction_metadata has none; UTC setting applies to <t:>', () => {
  const ctx = makeContext({ settings: { timezone: 'utc' } });
  const html = renderMessage({ id: '1', channel_id: '2', type: 20, timestamp: '2024-01-01T00:00:00Z', content: 'hi', author: { id: '3', username: 'bot', bot: true }, interaction_metadata: { id: '9', type: 2, user: { id: '4', username: 'me' } }, interaction: { id: '9', type: 2, name: 'ping', user: { id: '4', username: 'me' } } }, ctx);
  assert(html.includes('used /ping'));
  assert(renderMarkdown('<t:1700000000:t>', ctx).includes('UTC'));
});
await test('grouping: webhook personas and app responses get their own header', () => {
  const a = { id: '1', channel_id: '2', type: 0, timestamp: '2024-01-01T00:00:00Z', author: { id: 'w', username: 'A' }, webhook_id: 'w' };
  const b = { ...a, id: '2', author: { id: 'w', username: 'B' } };
  assert(!shouldGroup(a, b));
  assert(shouldGroup(a, { ...a, id: '3' }));
  assert(!shouldGroup(a, { ...a, id: '4', type: 20, interaction_metadata: { name: 'x' } }));
});
await test('system messages: boosts with count, poll results, thread starter', () => {
  const ctx = makeContext({ settings });
  const sys = (o) => renderMessage({ id: '1', channel_id: '2', timestamp: '2024-01-01T00:00:00Z', author: { id: '3', username: 'u' }, content: '', ...o }, ctx);
  assert(sys({ type: 8, content: '3' }).includes('<strong>3</strong> times'));
  assert(sys({ type: 9, content: '' }).includes('Level 1'));
  assert(sys({ type: 46, embeds: [{ type: 'poll_result', fields: [{ name: 'poll_question_text', value: 'Best?' }, { name: 'victor_answer_text', value: 'Apple' }, { name: 'victor_answer_votes', value: '2' }, { name: 'total_votes', value: '3' }] }] }).includes('Winner: <strong>Apple</strong>'));
  assert(sys({ type: 21, referenced_message: { id: '7', author: { id: '5', username: 'op' }, content: 'Original post' } }).includes('Original post'));
});

console.log('utilities');
await test('sanitizeFilename keeps " (id)" when truncating; no split surrogates; safeUrl', () => {
  const long = 'x'.repeat(200) + ' (123456789012345678)';
  const s = sanitizeFilename(long);
  assert(s.length <= 80 && s.endsWith(' (123456789012345678)'), s);
  assert.notEqual(sanitizeFilename('a'.repeat(100) + ' (1)'), sanitizeFilename('a'.repeat(100) + ' (2)'));
  const e = sanitizeFilename('😀'.repeat(50), 9);
  assert(!/[\uD800-\uDBFF]$/.test(e), 'lone surrogate');
  assert(!/[. ]$/.test(sanitizeFilename('ab.' + ' '.repeat(3) + 'c'.repeat(90), 4)));
  assert.equal(sanitizeFilename('..'), 'untitled');
  assert.equal(sanitizeFilename('../../etc/passwd'), '_.._etc_passwd');
  assert.equal(sanitizeFilename('COM1.txt'), '_COM1.txt');
  assert.equal(sanitizeFilename('conout$'), '_conout$');
  assert.deepEqual(parseDiscordLink('https://discord.com/channels/1/2/threads/3'), { guildId: '1', channelId: '3', messageId: null });
  assert.equal(safeUrl(' javascript:alert(1)'), '');
  assert.equal(safeUrl('java\tscript:x'), '');
  assert.equal(safeUrl('media/a b.png'), 'media/a b.png');
  assert.equal(safeUrl('\\\\evil\\share'), 'https://evil\\share');
  assert(!/[\uD800-\uDBFF]…$/.test(truncate('😀😀😀', 4)));
});
await test('analytics CSV: @everyone row is formula-safe; mentions in code are ignored', () => {
  const ctx = makeContext();
  const a = computeAnalytics([{ id: '1', content: '@everyone `<@5>` <@6>', author: { id: '1' } }], ctx);
  assert.equal(a.users.length, 1);
  assert(analyticsCsv(a).includes("'@everyone"));
});

console.log('zip');
const pyCheck = (buf, code) => {
  const dir = mkdtempSync(join(tmpdir(), 'zx'));
  const p = join(dir, 't.zip');
  writeFileSync(p, buf);
  try { return execFileSync('python3', ['-I', '-c', `import zipfile,sys\nz=zipfile.ZipFile(sys.argv[1])\n${code}`, p]).toString(); } finally { rmSync(dir, { recursive: true }); }
};
await test('ZIP with 70,000 entries uses ZIP64 end records (python zipfile + unzip + ZipReader)', async () => {
  const parts = [];
  const z = new ZipWriter(async (b) => { parts.push(Buffer.from(b)); });
  for (let i = 0; i < 70000; i++) await z.addFile(`f/${i}.txt`, String(i));
  await z.finish();
  const buf = Buffer.concat(parts);
  const out = pyCheck(buf, `assert z.testzip() is None\nprint(len(z.namelist()), z.read('f/69999.txt').decode())`);
  assert.equal(out.trim(), '70000 69999');
  const dir = mkdtempSync(join(tmpdir(), 'zu'));
  writeFileSync(join(dir, 't.zip'), buf);
  try { execFileSync('unzip', ['-tqq', join(dir, 't.zip')]); } finally { rmSync(dir, { recursive: true }); }
  const r = await ZipReader.open(new File([buf], 't.zip'));
  assert.equal(r.names().length, 70000);
  assert.equal(await r.text('f/12345.txt'), '12345');
});
await test('ZIP entry > 4 GB and offsets > 4 GB (ZIP64 extra + descriptor) [set BIGZIP=1]', async () => {
  if (!process.env.BIGZIP) { console.log('    (skipped)'); return; }
  const { openSync, writeSync, closeSync } = await import('node:fs');
  const dir = mkdtempSync(join(tmpdir(), 'zb'));
  const p = join(dir, 'big.zip');
  const fd = openSync(p, 'w');
  const z = new ZipWriter(async (b) => { writeSync(fd, b); });
  const chunk = new Uint8Array(64 * 1024 * 1024).fill(7);
  const w = await z.entry('big.bin');
  const total = 4 * 1024 * 1024 * 1024 + 5 * 1024 * 1024;
  for (let n = 0; n < total; n += chunk.length) await w.write(n + chunk.length <= total ? chunk : chunk.subarray(0, total - n));
  await w.close();
  await z.addFile('after.txt', 'hello after 4GB', { compress: true });
  await z.finish();
  closeSync(fd);
  try {
    const out = execFileSync('python3', ['-I', '-c', `import zipfile,sys\nz=zipfile.ZipFile(sys.argv[1])\ni=z.getinfo('big.bin')\nprint(i.file_size, z.read('after.txt').decode())\nh=z.open('big.bin')\nh.seek(${total - 3})\nprint(h.read(3))`, p]).toString();
    assert(out.includes(`${total} hello after 4GB`), out);
    execFileSync('unzip', ['-tqq', p]);
    // Node's openAsBlob() wraps sizes above 4 GB, so read the file through a minimal File-like object.
    const { statSync, readSync, openSync: op, closeSync: cl } = await import('node:fs');
    const rfd = op(p, 'r');
    const slice = (a, b) => ({
      arrayBuffer: async () => { const buf = Buffer.alloc(b - a); readSync(rfd, buf, 0, b - a, a); return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length); },
      stream: () => { let pos = a; return new ReadableStream({ pull(c) { if (pos >= b) return c.close(); const n = Math.min(1 << 20, b - pos); const buf = Buffer.alloc(n); readSync(rfd, buf, 0, n, pos); pos += n; c.enqueue(new Uint8Array(buf)); } }); },
    });
    const r = await ZipReader.open({ size: statSync(p).size, slice });
    assert.equal(r.get('big.bin').usize, total);
    assert.equal(await r.text('after.txt'), 'hello after 4GB');
    cl(rfd);
  } finally { rmSync(dir, { recursive: true }); }
});
await test('ZIP writer surfaces output errors instead of hanging', async () => {
  let n = 0;
  const z = new ZipWriter(async () => { if (++n > 3) throw new Error('disk full'); });
  const w = await z.entry('x.txt', { compress: true });
  const big = new Uint8Array(4 * 1024 * 1024).map(() => Math.random() * 256);
  const res = await Promise.race([
    (async () => { try { for (let i = 0; i < 20; i++) await w.write(big); await w.close(); return 'no error'; } catch (e) { return e.message; } })(),
    new Promise((r) => setTimeout(() => r('hang'), 5000)),
  ]);
  assert.equal(res, 'disk full');
});

console.log('data package');
await test('data package: numeric IDs in channel.json, string types, backslash paths, localized folders', async () => {
  const parts = [];
  const z = new ZipWriter(async (b) => { parts.push(Buffer.from(b)); });
  await z.addFile('Konto/user.json', '{"id": 100000000000000001, "username": "tester", "discriminator": 0}');
  await z.addFile('Nachrichten\\c1100000000000000099\\channel.json', '{"id": 1100000000000000099, "type": "GUILD_TEXT", "name": "allgemein", "guild": {"id": 1200000000000000077, "name": "Alter Server"}}');
  await z.addFile('Nachrichten\\c1100000000000000099\\messages.json', '[{"ID": 1234567890123456789, "Timestamp": "2023-05-01 12:00:00", "Contents": "say \\"ID\\": 5", "Attachments": ""}]');
  await z.addFile('Nachrichten/c1100000000000000098/channel.json', '{"id": "1100000000000000098", "type": "GROUP_DM", "recipients": [100000000000000001, 100000000000000002]}');
  await z.addFile('Nachrichten/c1100000000000000098/messages.json', '[]');
  await z.finish();
  const pkg = await DataPackage.open(new File([Buffer.concat(parts)], 'p.zip'));
  assert.equal(pkg.user.id, '100000000000000001');
  const c = pkg.channels.get('1100000000000000099');
  assert.equal(c.guildId, '1200000000000000077');
  assert.equal(c.kind, 'guild');
  const g = pkg.channels.get('1100000000000000098');
  assert.equal(g.kind, 'group');
  assert.deepEqual(g.recipients, ['100000000000000001', '100000000000000002']);
  const msgs = await pkg.messages('1100000000000000099');
  assert.equal(msgs[0].id, '1234567890123456789');
  assert.equal(msgs[0].content, 'say "ID": 5');
});

console.log('export');
function exportDeps(mock, api, ws, extra = {}) {
  return {
    api, ws, log: () => {}, meId: () => mock.ME.id, channel: (id) => mock.ch[id], channelNames: () => new Map(Object.values(mock.ch).map((c) => [c.id, c.name || 'dm'])),
    getRoles: async () => new Map([['600000000000000001', { id: '600000000000000001', name: 'Mods', color: 0xe91e63, position: 2, icon: 'abcd' }]]),
    getMembers: async (gid, ids) => new Map(ids.map((id) => [id, id === mock.OTHER.id ? { nick: 'Buddy', roles: ['600000000000000001'] } : null])),
    settings: () => settings, cssText: async () => '.x{}', ...extra,
  };
}
await test('CSV/TXT-only export has real author names and nicknames, decoded system text', async () => {
  const { mock, api } = setup();
  const ws = await openWs();
  const sink = new MemSink();
  const run = createExportHandler(exportDeps(mock, api, ws));
  const opts = applyPreset(DEFAULT_EXPORT_OPTIONS, { formats: { csv: true, txt: true }, download: {} });
  const job = new Job({ type: 'export', title: 'x', ws, params: { rootName: 'r', sources: [{ type: 'channel', channelId: mock.GENERAL.id, guildId: mock.GID, title: 'general', channelType: 0, folder: ['S', 'general (1)'] }], options: { ...opts, includeThreads: false }, criteria: null } });
  job.runtime = { sink };
  job.status = 'running';
  await run(job);
  const csv = sink.files.get('S/general (1)/general.csv').toString();
  assert(!csv.includes(',Unknown,'), 'author names resolved');
  assert(csv.includes('Buddy') && csv.includes('Test User'));
  const txt = sink.files.get('S/general (1)/general.txt').toString();
  assert(txt.includes('Buddy (friend)') && !txt.includes('Unknown ('));
});
await test('HTML export: CSP, encoded links for names with # and %, no collisions, role icons downloaded', async () => {
  const { mock, api } = setup();
  const ws = await openWs();
  const sink = new MemSink();
  const msgs = mock.msgs[mock.GENERAL.id].slice(0, 30).map((m) => JSON.parse(JSON.stringify(m)));
  msgs[1].embeds = [{ type: 'rich', title: 'two pics', thumbnail: { url: 'https://images-ext-1.discordapp.net/external/a/https/x.com/pic.png' }, image: { url: 'https://images-ext-2.discordapp.net/external/b/https/y.com/pic.png' } }];
  msgs[2].attachments = [{ id: '9001', filename: 'c#1 100%.png', size: 10, content_type: 'image/png', url: 'https://cdn.discordapp.com/attachments/1/2/c%231%20100%25.png?ex=7fffffff&is=0&hm=x' }];
  await ws.putConv({ key: 'k1', kind: 'channel', channelId: mock.GENERAL.id });
  await ws.putMessages('k1', msgs);
  const run = createExportHandler(exportDeps(mock, api, ws));
  const opts = { ...applyPreset(DEFAULT_EXPORT_OPTIONS, BUILTIN_PRESETS[0]), messagesPerPage: 10 };
  const job = new Job({ type: 'export', title: 'x', ws, params: { rootName: 'r', sources: [{ type: 'conv', convKey: 'k1', title: 'C# 100% talk', guildId: mock.GID, channelId: mock.GENERAL.id, folder: ['S#1', 'C# 100% talk (5)'] }, { type: 'conv', convKey: 'k1', title: 'two', guildId: mock.GID, channelId: mock.GENERAL.id, folder: ['S#1', 'two (6)'] }], options: opts } });
  job.runtime = { sink };
  job.status = 'running';
  await run(job);
  const names = [...sink.files.keys()];
  const p1 = sink.files.get('S#1/C# 100% talk (5)/C# 100% talk_page_1.html').toString();
  assert(p1.includes("Content-Security-Policy") && !/<script/i.test(p1));
  assert(p1.includes('href="C%23%20100%25%20talk_page_2.html"'), 'nav links are URL-encoded');
  assert(p1.includes('src="media/attachments/' + encodeURIComponent(msgs[2].id + '_c#1 100%.png') + '"'), 'media links encoded');
  const index = sink.files.get('index.html').toString();
  assert(index.includes('href="S%231/C%23%20100%25%20talk%20(5)/C%23%20100%25%20talk_page_1.html"'), index);
  const embeds = names.filter((n) => n.startsWith('S#1/C# 100% talk (5)/media/embeds/') && n.includes('pic'));
  assert.equal(embeds.length, 2, 'two different embed images with the same name are both kept: ' + embeds);
  assert(names.some((n) => n.includes('/media/roles/600000000000000001.png')), 'role icon downloaded');
  for (const n of names) if (n.endsWith('.html')) assertSafeHtml(sink.files.get(n).toString().replace(/<style>[\s\S]*?<\/style>/, '').replace(/<meta[^>]*>/g, ''));
});
await test('resumed export continues with the next source (no duplicate, no emptied pages)', async () => {
  const { mock, api } = setup();
  const ws = await openWs();
  const sink = new MemSink();
  await ws.putConv({ key: 'exp:tmp:sel', kind: 'channel', temp: true, channelId: mock.DM.id });
  await ws.putMessages('exp:tmp:sel', mock.msgs[mock.DM.id]);
  let fail = true;
  const deps = exportDeps(mock, api, ws, { channel: (id) => { if (id === mock.RANDOM.id && fail) throw new Error('browser closed'); return mock.ch[id]; } });
  const run = createExportHandler(deps);
  const sources = [
    { type: 'conv', convKey: 'exp:tmp:sel', temp: true, title: 'dm', channelId: mock.DM.id, folder: ['DMs', 'dm (1)'] },
    { type: 'channel', channelId: mock.RANDOM.id, guildId: mock.GID, title: 'random', channelType: 0, folder: ['S', 'random (2)'] },
  ];
  const opts = { ...applyPreset(DEFAULT_EXPORT_OPTIONS, BUILTIN_PRESETS[2]), includeThreads: false };
  const job = new Job({ id: 'resume1', type: 'export', title: 'x', ws, resumable: true, params: { rootName: 'r', sources, options: opts } });
  job.runtime = { sink };
  job.status = 'running';
  await assert.rejects(run(job), /browser closed/);
  const dmPage = sink.files.get('DMs/dm (1)/dm.html').toString();
  assert(dmPage.includes('Message 1 in'));
  const saved = await ws.getJob('resume1');
  fail = false;
  const job2 = new Job({ ...saved, resumable: true, ws });
  job2.runtime = { sink };
  job2.status = 'running';
  await run(job2);
  assert.equal(sink.files.get('DMs/dm (1)/dm.html').toString(), dmPage, 'finished source is not redone');
  const index = sink.files.get('index.html').toString();
  assert.equal((index.match(/<li>/g) || []).length, 2, 'two index entries');
  assert(sink.files.get('S/random (2)/random.html').toString().includes('Message'));
});
await test('failed download into a folder is aborted, not kept as a truncated file', async () => {
  const { mock, api } = setup();
  const ws = await openWs();
  const aborted = [];
  const sink = new MemSink();
  sink.file = async (path) => {
    const chunks = [];
    return { write: async (c) => chunks.push(Buffer.from(c)), close: async () => sink.files.set(path, Buffer.concat(chunks)), abort: async () => aborted.push(path) };
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, o) => {
    const res = await realFetch(url, o);
    if (!String(url).includes('photo_3.png')) return res;
    const body = new ReadableStream({ start(c) { c.enqueue(new Uint8Array([1, 2, 3])); c.error(new Error('connection reset')); } });
    return new Response(body, { status: 200, headers: { 'content-length': '999' } });
  };
  try {
    await ws.putConv({ key: 'k2', kind: 'channel', channelId: mock.DM.id });
    await ws.putMessages('k2', mock.msgs[mock.DM.id].slice(0, 10));
    const run = createExportHandler(exportDeps(mock, api, ws));
    const job = new Job({ type: 'export', title: 'x', ws, params: { sources: [{ type: 'conv', convKey: 'k2', title: 'dm', folder: ['d'] }], options: applyPreset(DEFAULT_EXPORT_OPTIONS, BUILTIN_PRESETS[7]) } });
    job.runtime = { sink };
    job.status = 'running';
    await run(job);
  } finally { globalThis.fetch = realFetch; }
  assert(aborted.some((p) => p.includes('photo_3.png')), 'aborted');
  assert(![...sink.files.keys()].some((p) => p.includes('photo_3.png')), 'no truncated file');
});

await test('full server export into a streamed .zip: valid archive, every local link resolves', async () => {
  const { ZipFileSink } = await import(SRC + 'export/sinks.js');
  const { mock, api } = setup();
  const ws = await openWs();
  const parts = [];
  const sink = new ZipFileSink({ write: async (b) => { parts.push(Buffer.from(b)); }, close: async () => {}, abort: async () => {} }, 'x.zip');
  const run = createExportHandler(exportDeps(mock, api, ws));
  const opts = { ...applyPreset(DEFAULT_EXPORT_OPTIONS, BUILTIN_PRESETS[9]), messagesPerPage: 15, artistMode: true };
  const sources = [mock.GENERAL, mock.FORUM, mock.RANDOM].map((c) => ({ type: 'channel', channelId: c.id, guildId: mock.GID, title: c.name, channelType: c.type, folder: ['Test Server #1', `${c.name} (${c.id})`] }));
  sources.push({ type: 'channel', channelId: mock.DM.id, guildId: null, title: 'friend 100%', channelType: 1, folder: ['Direct Messages', `friend 100% (${mock.DM.id})`] });
  const job = new Job({ type: 'export', title: 'x', ws, params: { rootName: 'r', sources, options: opts, criteria: null } });
  job.runtime = { sink };
  job.status = 'running';
  await run(job);
  const buf = Buffer.concat(parts);
  const out = pyCheck(buf, `assert z.testzip() is None
import re, posixpath, urllib.parse
names = set(z.namelist())
bad = []
dups = [n for n in names if re.search(r' \\(\\d+\\)(\\.|$)', n)]
for n in names:
    if not n.endswith('.html'): continue
    html = z.read(n).decode()
    assert '<script' not in html.lower(), n
    for m in re.finditer(r'(?:href|src)="([^"#]+)(#[^"]*)?"', html):
        u = m.group(1).replace('&amp;', '&')
        if re.match(r'^[a-z]+:', u): continue
        target = posixpath.normpath(posixpath.join(posixpath.dirname(n), urllib.parse.unquote(u)))
        if target not in names: bad.append((n, u))
print(len(names), len(bad), bad[:3], dups[:3])`);
  const [count, nbad, , ] = out.trim().split(' ');
  assert(Number(count) > 40, out);
  assert.equal(Number(nbad), 0, out);
  assert(out.trim().endsWith('[] []'), 'no renamed duplicate entries: ' + out);
});

console.log(`\n${passed} extra tests passed${process.exitCode ? ', some FAILED' : ''}`);
