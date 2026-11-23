// Node tests for Cleancord's logic against the mock Discord API.
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import './mock-discord.js';

const SRC = new URL('../extension/src/', import.meta.url).href;
globalThis.chrome = { storage: { local: { get: async () => ({}), set: async () => {} }, session: { get: async () => ({}) } } };

const { createApi, extractSearchHits } = await import(SRC + 'api.js');
const { Workspace } = await import(SRC + 'db.js');
const { Job, JobManager } = await import(SRC + 'jobs.js');
const { createPurgeHandler } = await import(SRC + 'purge.js');
const { createBulkHandler, slimForBulk, computeEdit } = await import(SRC + 'bulk.js');
const { createExportHandler, DEFAULT_EXPORT_OPTIONS, BUILTIN_PRESETS, applyPreset } = await import(SRC + 'export/exporter.js');
const { ZipWriter } = await import(SRC + 'export/zip.js');
const { ZipReader } = await import(SRC + 'package/zipreader.js');
const { DataPackage, parseCsv } = await import(SRC + 'package/datapkg.js');
const { renderMarkdown } = await import(SRC + 'markdown.js');
const { makeContext, renderMessages } = await import(SRC + 'render.js');
const { loadHistory, loadSearch, listThreads } = await import(SRC + 'discord.js');
const { matchesCriteria, buildSearchQuery } = await import(SRC + 'criteria.js');
const { computeAnalytics } = await import(SRC + 'analytics.js');
const { sanitizeFilename, csvCell, dateToSnowflake, snowflakeToDate } = await import(SRC + 'util.js');

let passed = 0;
const test = async (name, fn) => {
  try { await fn(); passed++; console.log('  ✔', name); } catch (e) { console.log('  ✖', name); console.log(e); process.exitCode = 1; }
};

const settings = { modifyDelay: 0, searchDelay: 0, delaySpread: 0, dateFormat: 'iso', timeFormat: '24h', timezone: 'utc', lookupMembers: true, memberCacheHours: 24 };
function setup(opts = {}) {
  const mock = globalThis.createMockDiscord(opts);
  globalThis.fetch = mock.fetch;
  const logs = [];
  const api = createApi({ getAuth: async () => ({ token: 'test-token', headers: {} }), getSettings: () => settings, log: (l, m) => logs.push([l, m]) });
  return { mock, api, logs };
}
let wsN = 0;
const openWs = () => Workspace.open('test' + wsN++);

// Collects files written by the exporter.
class MemSink {
  constructor() { this.kind = 'folder'; this.files = new Map(); this.finished = false; }
  async exists(p) { return this.files.has(p); }
  async file(path) {
    const chunks = [];
    return {
      write: async (c) => chunks.push(typeof c === 'string' ? Buffer.from(c) : Buffer.from(c)),
      close: async () => { this.files.set(path, Buffer.concat(chunks)); },
    };
  }
  async finish() { this.finished = true; }
}

console.log('markdown & rendering');
await test('escapes HTML and blocks javascript: links', () => {
  const html = renderMarkdown('<img src=x onerror=alert(1)> [click](javascript:alert(1)) "quote" & <script>');
  assert(!html.includes('<img src=x'));
  assert(!html.includes('<script'));
  assert(!/href="javascript/i.test(html));
  assert(html.includes('&lt;img'));
});
await test('formats bold/italic/code/spoiler/quote/links/mentions', () => {
  const ctx = makeContext({ users: new Map([['1', { id: '1', username: 'bob', global_name: 'Bob' }]]) });
  const html = renderMarkdown('**b** *i* __u__ ~~s~~ `x<y` ||sp|| <@1> https://a.com/x?y=1&z=2\n> quoted\n```js\nlet a = "<b>";\n```', ctx);
  assert(html.includes('<strong>b</strong>'));
  assert(html.includes('<em>i</em>'));
  assert(html.includes('<u>u</u>'));
  assert(html.includes('<s>s</s>'));
  assert(html.includes('<code class="md-code">x&lt;y</code>'));
  assert(html.includes('md-spoiler'));
  assert(html.includes('@Bob'));
  assert(html.includes('href="https://a.com/x?y=1&amp;z=2"'));
  assert(html.includes('<blockquote'));
  assert(html.includes('let a = &quot;&lt;b&gt;&quot;;'));
});
await test('masked link with quote cannot break out of href', () => {
  const html = renderMarkdown('[x](https://a.com/" onmouseover="alert(1))');
  assert(!html.includes('onmouseover="alert'));
});
await test('snake_case is not italicised; emoji-only is jumbo', () => {
  assert(!renderMarkdown('some_var_name').includes('<em>'));
  assert(renderMarkdown('😀😀').includes('md-jumbo'));
  assert(renderMarkdown('<:party:123456789012345678>', makeContext()).includes('md-jumbo'));
});
await test('renders every message type in the mock without throwing', () => {
  const { mock } = setup();
  const ctx = makeContext({ meId: mock.ME.id, settings });
  for (const list of Object.values(mock.msgs)) {
    const html = renderMessages(list, ctx);
    assert(html.length > 100);
  }
  const html = renderMessages(mock.msgs[mock.DM.id], ctx);
  assert(html.includes('started a call'));
  assert(html.includes('pinned'));
  assert(html.includes('Forwarded'));
  assert(html.includes('Best fruit?'));
  assert(html.includes('data-jump'));
});

console.log('utilities');
await test('snowflake <-> date', () => {
  const d = new Date('2024-01-02T03:04:05Z');
  assert.equal(snowflakeToDate(dateToSnowflake(d)).toISOString(), d.toISOString());
});
await test('filenames and CSV cells are safe', () => {
  assert.equal(sanitizeFilename('a/b:c*?.png'), 'a_b_c__.png');
  assert.equal(sanitizeFilename('CON'), '_CON');
  assert.equal(csvCell('=SUM(A1)'), "'=SUM(A1)");
  assert.equal(csvCell('a,"b"'), '"a,""b"""');
});
await test('CSV parser handles quotes and newlines', () => {
  const rows = parseCsv('ID,Contents\n1,"hello, ""world""\nline2"\n2,plain\n');
  assert.equal(rows.length, 3);
  assert.equal(rows[1][1], 'hello, "world"\nline2');
});

console.log('zip');
await test('ZipWriter output is a valid ZIP (python zipfile) and round-trips through ZipReader', async () => {
  const parts = [];
  const z = new ZipWriter(async (b) => { parts.push(Buffer.from(b)); });
  await z.addFile('hello.txt', 'Hello world', { compress: true });
  await z.addFile('dir/ünïcode 文件.json', JSON.stringify({ a: 1 }));
  const big = new Uint8Array(300_000).map((_, i) => i % 251);
  const w = await z.entry('media/big.bin');
  for (let i = 0; i < big.length; i += 65536) await w.write(big.subarray(i, i + 65536));
  await w.close();
  await z.addFile('hello.txt', 'dup');
  await z.finish();
  const buf = Buffer.concat(parts);
  const dir = mkdtempSync(join(tmpdir(), 'zt'));
  const p = join(dir, 't.zip');
  writeFileSync(p, buf);
  const out = execFileSync('python3', ['-c', `import zipfile,sys; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; print('|'.join(z.namelist())); print(z.read('hello.txt').decode())`, p]).toString();
  assert(out.includes('dir/ünïcode 文件.json'));
  assert(out.includes('hello (2).txt'));
  assert(out.includes('Hello world'));
  const r = await ZipReader.open(new File([buf], 't.zip'));
  assert.equal(await r.text('hello.txt'), 'Hello world');
  const back = new Uint8Array(await (await r.blob('media/big.bin')).arrayBuffer());
  assert.equal(back.length, big.length);
  assert.equal(back[299_999], big[299_999]);
});

console.log('data package');
await test('parses a synthetic Discord data package (json + csv, big IDs, servers)', async () => {
  const parts = [];
  const z = new ZipWriter(async (b) => { parts.push(Buffer.from(b)); });
  await z.addFile('Account/user.json', JSON.stringify({ id: '100000000000000001', username: 'tester', global_name: 'Test', discriminator: 0, avatar_hash: null }));
  await z.addFile('Messages/index.json', JSON.stringify({ '1100000000000000001': 'Direct Message with friend#0', '1100000000000000002': 'general in Old Server', '1100000000000000003': null }), { compress: true });
  await z.addFile('Messages/c1100000000000000001/channel.json', JSON.stringify({ id: '1100000000000000001', type: 'DM', recipients: ['100000000000000001', '100000000000000002'] }));
  await z.addFile('Messages/c1100000000000000001/messages.json', '[{"ID": 1234567890123456789, "Timestamp": "2023-05-01 12:00:00", "Contents": "hi there", "Attachments": ""}, {"ID": 1234567890123456799, "Timestamp": "2023-05-01 12:01:00", "Contents": "pic", "Attachments": "https://cdn.discordapp.com/attachments/1/2/cat.png"}]', { compress: true });
  await z.addFile('Messages/c1100000000000000002/channel.json', JSON.stringify({ id: '1100000000000000002', type: 0, name: 'general', guild: { id: '1200000000000000001', name: 'Old Server' } }));
  await z.addFile('Messages/c1100000000000000002/messages.csv', 'ID,Timestamp,Contents,Attachments\n1234567890123456800,2021-01-01 00:00:00.000000+00:00,"multi\nline, with ""quotes""",\n');
  await z.addFile('Messages/c1100000000000000003/channel.json', JSON.stringify({ id: '1100000000000000003', type: 3 }));
  await z.addFile('Messages/c1100000000000000003/messages.json', '[]');
  await z.addFile('Servers/index.json', JSON.stringify({ '1200000000000000001': 'Old Server' }));
  await z.addFile('Servers/1200000000000000001/guild.json', JSON.stringify({ id: '1200000000000000001', name: 'Old Server' }));
  await z.finish();
  const pkg = await DataPackage.open(new File([Buffer.concat(parts)], 'package.zip'));
  assert.equal(pkg.user.id, '100000000000000001');
  const tree = pkg.tree();
  assert.equal(tree.dms.length, 1);
  assert.equal(tree.groups.length, 1);
  assert.equal(tree.servers[0].name, 'Old Server');
  const dm = await pkg.messages('1100000000000000001');
  assert.equal(dm[0].id, '1234567890123456789'); // no precision loss
  assert.equal(dm[1].attachments[0].filename, 'cat.png');
  assert.equal(dm[0].timestamp, '2023-05-01T12:00:00.000Z');
  const g = await pkg.messages('1100000000000000002');
  assert.equal(g[0].content, 'multi\nline, with "quotes"');
  assert.equal(g[0].guild_id, '1200000000000000001');
});

console.log('api + loading');
await test('API client sends token to discord.com only, handles 202 indexing and 429', async () => {
  const { mock, api } = setup({ indexDelay: true });
  const res = await api.search({ guildId: mock.GID }, { author_id: [mock.ME.id] });
  assert(res.total_results > 0);
  for (const r of mock.log) if (!r.url.startsWith('https://discord.com/')) assert(!r.auth, 'auth sent to ' + r.url);
});
await test('loadHistory pages to the start and records cursors; loadSearch walks all results', async () => {
  const { mock, api } = setup({ perChannel: 250 });
  const ws = await openWs();
  await ws.putConv({ key: 'ch:x', kind: 'channel', channelId: mock.DM.id, count: 0 });
  await loadHistory({ api, ws, job: null, convKey: 'ch:x', channelId: mock.DM.id });
  assert.equal(await ws.countMessages('ch:x'), 250);
  const conv = await ws.getConv('ch:x');
  assert(conv.doneChannels[mock.DM.id]);
  const all = await ws.getMessages('ch:x');
  assert(all.every((m, i) => i === 0 || BigInt(all[i - 1].id) < BigInt(m.id)), 'ascending order');
  await ws.putConv({ key: 's', kind: 'search', scope: { guildId: mock.GID }, criteria: { authorIds: [mock.ME.id] }, count: 0 });
  await loadSearch({ api, ws, job: null, convKey: 's', maxPages: Infinity });
  const expected = Object.values(mock.msgs).flat().filter((m) => m.guild_id && m.author.id === mock.ME.id && (m.type === 0 || m.type === 19) && !mock.unindexed.has(m.id)).length;
  assert.equal(await ws.countMessages('s'), expected);
});
await test('thread discovery finds archived threads and forum posts', async () => {
  const { mock, api } = setup();
  const t1 = await listThreads(api, mock.GENERAL);
  assert(t1.some((t) => t.id === mock.THREAD.id));
  const t2 = await listThreads(api, mock.FORUM);
  assert(t2.some((t) => t.id === mock.POST.id));
});

console.log('purge');
function purgeDeps(mock, api, ws, extra = {}) {
  const deleted = [];
  return {
    deleted,
    deps: {
      api, ws, log: () => {}, meId: () => mock.ME.id, channel: (id) => mock.ch[id], channelName: (id) => (mock.ch[id] || {}).name || id,
      onDeleted: (m) => deleted.push(m.id), onUpdated: () => {}, ...extra,
    },
  };
}
await test('search purge of a whole server deletes all of my messages incl. archived thread + unindexed newest (final pass)', async () => {
  const { mock, api } = setup({ rateLimitEvery: 7 });
  const ws = await openWs();
  const { deps, deleted } = purgeDeps(mock, api, ws);
  const run = createPurgeHandler(deps);
  const job = new Job({ type: 'purge', title: 't', ws, resumable: true, params: {
    targets: [{ type: 'guild', id: mock.GID, guildId: mock.GID, name: 'Test Server' }], mode: 'delete', authorMode: 'me', criteria: {},
    systemGroups: ['pins'], scan: 'search', finalPass: 100, finalPassScope: 'all', includeThreads: true,
  } });
  job.status = 'running';
  await run(job);
  const leftMine = Object.values(mock.msgs).flat().filter((m) => m.guild_id && m.author.id === mock.ME.id && ![3, 7].includes(m.type));
  assert.equal(leftMine.length, 0, `left: ${leftMine.map((m) => m.channel_id + ':' + m.type).join(',')}`);
  assert(Object.values(mock.msgs).flat().some((m) => m.author.id === mock.OTHER.id), 'others untouched');
  assert.equal(mock.THREAD.thread_metadata.archived, true, 'thread re-archived');
  assert(deleted.length > 20);
});
await test('DM purge with date + content criteria only removes matching messages', async () => {
  const { mock, api } = setup();
  const ws = await openWs();
  const { deps } = purgeDeps(mock, api, ws);
  const before = mock.msgs[mock.DM.id].length;
  const cutoff = mock.msgs[mock.DM.id][30].timestamp;
  const job = new Job({ type: 'purge', title: 't', ws, params: { targets: [{ type: 'dm', id: mock.DM.id, name: 'dm' }], mode: 'delete', authorMode: 'me', criteria: { before: cutoff, content: 'bold' }, scan: 'history', finalPass: 0 } });
  job.status = 'running';
  await createPurgeHandler(deps)(job);
  const left = mock.msgs[mock.DM.id];
  assert(left.length < before);
  assert(left.filter((m) => m.author.id === mock.ME.id && m.type === 0 && m.content.includes('bold') && m.timestamp < cutoff).length === 0);
  assert(left.some((m) => m.author.id === mock.ME.id && m.timestamp > cutoff), 'later messages kept');
});
await test('attachment-only purge strips files and keeps text; reactions purge removes my reactions', async () => {
  const { mock, api } = setup();
  const ws = await openWs();
  const { deps } = purgeDeps(mock, api, ws);
  let job = new Job({ type: 'purge', title: 't', ws, params: { targets: [{ type: 'dm', id: mock.DM.id, name: 'dm' }], mode: 'attachments', authorMode: 'me', criteria: {}, scan: 'search', finalPass: 50, emptyPolicy: 'skip' } });
  job.status = 'running';
  await createPurgeHandler(deps)(job);
  assert.equal(mock.msgs[mock.DM.id].filter((m) => m.author.id === mock.ME.id && m.attachments.length).length, 0);
  assert(job.stats.edited > 0);
  job = new Job({ type: 'purge', title: 't', ws, params: { targets: [{ type: 'dm', id: mock.DM.id, name: 'dm' }], mode: 'reactions', reactionUsers: ['@me'], criteria: {}, scan: 'history' } });
  job.status = 'running';
  await createPurgeHandler(deps)(job);
  assert.equal(mock.msgs[mock.DM.id].filter((m) => (m.reactions || []).some((r) => r._users.includes(mock.ME.id))).length, 0);
  assert(mock.msgs[mock.DM.id].some((m) => (m.reactions || []).some((r) => r._users.includes(mock.OTHER.id))), 'other people’s reactions remain');
});
await test('purge can be cancelled and resumed from its checkpoint', async () => {
  const { mock, api } = setup({ perChannel: 200 });
  const ws = await openWs();
  const { deps } = purgeDeps(mock, api, ws);
  const run = createPurgeHandler(deps);
  const params = { targets: [{ type: 'dm', id: mock.DM.id, name: 'dm' }], mode: 'delete', authorMode: 'me', criteria: {}, scan: 'search', finalPass: 100 };
  const jm = new JobManager({ log: () => {} });
  jm.register('purge', run);
  const job = new Job({ id: 'resume-me', type: 'purge', title: 't', ws, resumable: true, params });
  let n = 0;
  job.on(() => { if (job.stats.deleted >= 20 && !n++) job.cancel(); });
  await jm.start(job);
  const mid = mock.msgs[mock.DM.id].filter((m) => m.author.id === mock.ME.id && m.type === 0).length;
  assert(mid > 0, 'stopped part-way');
  // simulate a crash-resume: save state like an interrupted run, then resume
  const job2 = new Job({ id: 'resume-2', type: 'purge', title: 't', ws, resumable: true, params, state: { ...job.state } });
  await jm.start(job2);
  assert.equal(mock.msgs[mock.DM.id].filter((m) => m.author.id === mock.ME.id && (m.type === 0 || m.type === 19)).length, 0);
});

console.log('bulk');
await test('bulk edit / find-replace / attachments / reactions', async () => {
  const { mock, api } = setup();
  const ws = await openWs();
  const updated = [];
  const deps = { api, log: () => {}, onDeleted: () => {}, onUpdated: (m) => updated.push(m), onReactionsChanged: () => {} };
  const run = createBulkHandler(deps);
  const mineMsgs = mock.msgs[mock.DM.id].filter((m) => m.author.id === mock.ME.id && m.type === 0 && m.content).slice(0, 5);
  let job = new Job({ type: 'bulk', title: 'e', ws, params: { action: 'edit', items: mineMsgs.map(slimForBulk), edit: { mode: 'find', find: 'BOLD', replace: 'strong', ignoreCase: true } } });
  job.status = 'running';
  await run(job);
  assert.equal(job.stats.done, 5);
  assert(mock.msgs[mock.DM.id].find((m) => m.id === mineMsgs[0].id).content.includes('**strong**'));
  assert.equal(computeEdit('aXbXc', { mode: 'find', find: 'x', replace: '-', regex: true, ignoreCase: true }), 'a-b-c');
  const withAtt = mock.msgs[mock.DM.id].filter((m) => m.author.id === mock.ME.id && m.attachments.length);
  job = new Job({ type: 'bulk', title: 'a', ws, params: { action: 'attachments', items: withAtt.map(slimForBulk), attachments: { filter: '.png', emptyPolicy: 'skip' } } });
  job.status = 'running';
  await run(job);
  assert.equal(mock.msgs[mock.DM.id].filter((m) => m.attachments.some((a) => a.filename.endsWith('.png') && m.author.id === mock.ME.id)).length, 0);
  const others = mock.msgs[mock.DM.id].filter((m) => m.author.id === mock.OTHER.id).slice(0, 2);
  job = new Job({ type: 'bulk', title: 'd', ws, params: { action: 'delete', items: others.map(slimForBulk) } });
  job.status = 'running';
  await run(job);
  assert.equal(job.stats.failed, 2, 'cannot delete others in DM');
});

console.log('export');
await test('exports a server (channels + threads) to HTML/JSON/CSV/TXT with media, artist mode, and an index', async () => {
  const { mock, api } = setup();
  const ws = await openWs();
  const sink = new MemSink();
  const run = createExportHandler({
    api, ws, log: () => {}, meId: () => mock.ME.id, channel: (id) => mock.ch[id], channelNames: () => new Map(Object.values(mock.ch).map((c) => [c.id, c.name || 'dm'])),
    getRoles: async () => new Map([[ '600000000000000001', { id: '600000000000000001', name: 'Mods', color: 0xe91e63, position: 2 } ]]),
    getMembers: async (gid, ids) => new Map(ids.map((id) => [id, id === mock.OTHER.id ? { nick: 'Buddy', roles: ['600000000000000001'] } : null])),
    settings: () => settings, cssText: async () => '.x{}',
  });
  const opts = applyPreset(DEFAULT_EXPORT_OPTIONS, BUILTIN_PRESETS[9]);
  opts.messagesPerPage = 20;
  opts.artistMode = true;
  const sources = [mock.GENERAL, mock.FORUM, mock.VOICE].map((c) => ({ type: 'channel', channelId: c.id, guildId: mock.GID, title: c.name, channelType: c.type, folder: ['Test Server', `${c.name} (${c.id})`] }));
  const job = new Job({ type: 'export', title: 'x', ws, params: { rootName: 'r', sources, options: opts, criteria: null } });
  job.runtime = { sink };
  job.status = 'running';
  const res = await run(job);
  const names = [...sink.files.keys()];
  assert(sink.finished);
  assert(names.includes('index.html'));
  assert(names.some((n) => n.startsWith('Test Server/general (400000000000000002)/general_page_3.html')));
  assert(names.some((n) => n.includes('/threads/old-thread (500000000000000001)/old-thread.html')), 'archived thread exported');
  assert(names.some((n) => n.includes('help-forum (400000000000000004)/threads/How do I_ (500000000000000002)/')), 'forum post exported');
  assert(names.some((n) => n.includes('/media/by-author/Test User (100000000000000001)/')), 'artist mode');
  assert(names.some((n) => n.includes('/media/avatars/100000000000000002_a1b2c3.png')));
  assert(names.some((n) => n.includes('/media/emojis/700000000000000001.png')));
  const json = JSON.parse(sink.files.get('Test Server/general (400000000000000002)/general.json').toString());
  assert.equal(json.messages.length, mock.msgs[mock.GENERAL.id].length);
  const csv = sink.files.get('Test Server/general (400000000000000002)/general.csv').toString();
  assert(csv.startsWith('﻿message_id,'));
  assert(csv.includes('media/by-author/'), 'CSV points at local media');
  const page1 = sink.files.get('Test Server/general (400000000000000002)/general_page_1.html').toString();
  assert(page1.includes('Buddy') && page1.includes('color:#e91e63'), 'nicknames + role colors');
  assert(page1.includes('src="media/'), 'local media in HTML');
  assert(!/<script/i.test(page1), 'no scripts in export');
  const txt = sink.files.get('Test Server/general (400000000000000002)/general.txt').toString();
  assert(txt.includes('Buddy'));
  assert(res.count > 60);
  assert.equal((await ws.listConvs()).filter((c) => c.key.startsWith('exp:')).length, 0, 'temp data cleaned up');
});
await test('expired attachment links get refreshed during export', async () => {
  const { mock, api } = setup();
  const ws = await openWs();
  const sink = new MemSink();
  await ws.putConv({ key: 'ch:1', kind: 'channel', channelId: mock.DM.id });
  await ws.putMessages('ch:1', mock.msgs[mock.DM.id]);
  const run = createExportHandler({ api, ws, log: () => {}, meId: () => mock.ME.id, channel: (id) => mock.ch[id], channelNames: () => new Map(), getRoles: async () => new Map(), getMembers: async () => new Map(), settings: () => settings, cssText: async () => '' });
  const job = new Job({ type: 'export', title: 'x', ws, params: { sources: [{ type: 'conv', convKey: 'ch:1', title: 'dm', folder: ['DMs', 'dm'] }], options: applyPreset(DEFAULT_EXPORT_OPTIONS, BUILTIN_PRESETS[7]) } });
  job.runtime = { sink };
  job.status = 'running';
  await run(job);
  const imgs = [...sink.files.keys()].filter((n) => n.endsWith('.png') && n.includes('attachments'));
  const expected = mock.msgs[mock.DM.id].filter((m) => m.attachments.some((a) => a.filename.endsWith('.png'))).length;
  assert.equal(imgs.length, expected);
  assert(mock.log.some((r) => r.url.includes('refresh-urls')));
  assert(await ws.getConv('ch:1'), 'saved conversations are not deleted by export');
});

console.log('analytics & criteria');
await test('mention analytics + local criteria matching', () => {
  const { mock } = setup();
  const ctx = makeContext({ channels: new Map([[mock.GENERAL.id, 'general']]) });
  for (const m of mock.msgs[mock.GENERAL.id]) { ctx.users.set(m.author.id, m.author); for (const u of m.mentions) ctx.users.set(u.id, u); }
  const a = computeAnalytics(mock.msgs[mock.GENERAL.id], ctx);
  assert(a.users.find((u) => u.id === mock.OTHER.id).count > 0);
  assert(a.roles.length === 1 && a.channels.length === 1);
  const m = mock.msgs[mock.DM.id].find((x) => x.attachments.length);
  assert(matchesCriteria(m, { has: ['file', 'image'] }));
  assert(!matchesCriteria(m, { has: ['poll'] }));
  assert.deepEqual(buildSearchQuery({ authorIds: ['1'], pinned: 'exclude' }).pinned, false);
});

console.log(`\n${passed} tests passed${process.exitCode ? ', some FAILED' : ''}`);
