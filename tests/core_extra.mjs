// Extra Node tests for the core (api / purge / bulk / jobs / db / discord) fixes. Same harness as unit.mjs.
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import './mock-discord.js';

const SRC = new URL('../extension/src/', import.meta.url).href;
globalThis.chrome = { storage: { local: { get: async () => ({}), set: async () => {} }, session: { get: async () => ({}) } } };

const { createApi } = await import(SRC + 'api.js');
const { Workspace, StorageFullError } = await import(SRC + 'db.js');
const { Job, JobManager } = await import(SRC + 'jobs.js');
const { createPurgeHandler } = await import(SRC + 'purge.js');
const { createBulkHandler, slimForBulk } = await import(SRC + 'bulk.js');
const { loadHistory } = await import(SRC + 'discord.js');

let passed = 0;
const test = async (name, fn) => {
  try { await fn(); passed++; console.log('  ✔', name); } catch (e) { console.log('  ✖', name); console.log(e); process.exitCode = 1; }
};
const settings = { modifyDelay: 0, searchDelay: 0, delaySpread: 0 };
function setup(opts = {}) {
  const mock = globalThis.createMockDiscord(opts);
  globalThis.fetch = mock.fetch;
  const api = createApi({ getAuth: async () => ({ token: 'test-token', headers: {} }), getSettings: () => settings, log: () => {} });
  return { mock, api };
}
let wsN = 0;
const openWs = () => Workspace.open('extra' + wsN++);
const mine = (mock, cid) => mock.msgs[cid].filter((m) => m.author.id === mock.ME.id && (m.type === 0 || m.type === 19));
function purgeDeps(mock, api, ws, extra = {}) {
  const deleted = [];
  return {
    deleted,
    deps: {
      api, ws, log: () => {}, meId: () => mock.ME.id, channel: (id) => mock.ch[id], channelName: (id) => (mock.ch[id] || {}).name || id,
      onDeleted: (m) => deleted.push(m), onUpdated: () => {}, ...extra,
    },
  };
}
// Wrap the mock's fetch with extra routes; `handler` returns a Response or undefined to fall through.
function wrapFetch(mock, handler) {
  const base = mock.fetch;
  mock.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    const method = (init.method || 'GET').toUpperCase();
    const r = await handler(method, url, init);
    return r || base(input, init);
  };
  globalThis.fetch = mock.fetch;
}
const reactionFor = (m, enc) => {
  const e = decodeURIComponent(enc);
  return (m.reactions || []).find((r) => (r.emoji.id ? `${r.emoji.name}:${r.emoji.id}` : r.emoji.name) === e);
};

console.log('purge');
await test('cancelling a purge still re-archives the threads it unarchived', async () => {
  const { mock, api } = setup();
  const ws = await openWs();
  let job;
  const { deps } = purgeDeps(mock, api, ws, { onDeleted: (m) => { if (m.channel_id === mock.THREAD.id) job.cancel(); } });
  const jm = new JobManager({ log: () => {} });
  jm.register('purge', createPurgeHandler(deps));
  job = new Job({ type: 'purge', title: 't', ws, resumable: true, params: {
    targets: [{ type: 'channel', id: mock.GENERAL.id, guildId: mock.GID, name: '#general', channelType: 0 }],
    mode: 'delete', authorMode: 'me', criteria: {}, scan: 'history', includeThreads: true, finalPass: 0,
  } });
  await jm.start(job);
  assert.equal(job.status, 'cancelled');
  assert(mine(mock, mock.THREAD.id).length > 0, 'stopped part-way through the thread');
  assert.equal(mock.THREAD.thread_metadata.archived, true, 'thread re-archived after cancel');
});

await test('super (burst) reactions are removed with the reaction type in the path', async () => {
  const { mock, api } = setup({ admin: true }); // removing other people's reactions needs Manage Messages
  const ws = await openWs();
  const target = mock.msgs[mock.GENERAL.id].find((m) => m.author.id === mock.OTHER.id && !m.reactions.length);
  target.reactions.push({ emoji: { id: null, name: '🔥' }, count: 2, count_details: { burst: 2, normal: 0 }, me: false, me_burst: true, burst_colors: [], _users: [], _burst: [mock.ME.id, mock.OTHER.id] });
  const burstDeletes = [];
  wrapFetch(mock, (method, url) => {
    let mm;
    if (method === 'DELETE' && (mm = /^\/api\/v9\/channels\/(\d+)\/messages\/(\d+)\/reactions\/([^/]+)\/1\/([^/]+)$/.exec(url.pathname))) {
      burstDeletes.push(mm[4]);
      const r = reactionFor(mock.msgs[mm[1]].find((m) => m.id === mm[2]), mm[3]);
      const uid = mm[4] === '@me' ? mock.ME.id : mm[4];
      r._burst = r._burst.filter((x) => x !== uid);
      if (uid === mock.ME.id) r.me_burst = false;
      return new Response(null, { status: 204 });
    }
    if (method === 'GET' && url.searchParams.get('type') === '1' && (mm = /^\/api\/v9\/channels\/(\d+)\/messages\/(\d+)\/reactions\/([^/]+)$/.exec(url.pathname))) {
      const r = reactionFor(mock.msgs[mm[1]].find((m) => m.id === mm[2]), mm[3]);
      return new Response(JSON.stringify((r ? r._burst : []).map((id) => ({ id, username: 'u' }))), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return undefined;
  });
  const refreshed = [];
  const { deps } = purgeDeps(mock, api, ws, { onReactionsChanged: (m) => refreshed.push(m.id) });
  const job = new Job({ type: 'purge', title: 't', ws, params: { targets: [{ type: 'channel', id: mock.GENERAL.id, guildId: mock.GID, name: '#general' }], mode: 'reactions', reactionUsers: ['@me', mock.OTHER.id], criteria: {}, scan: 'history', includeThreads: false } });
  job.status = 'running';
  await createPurgeHandler(deps)(job);
  const r = target.reactions.find((x) => x.emoji.name === '🔥');
  assert.equal(r.me_burst, false, 'my super reaction removed');
  assert.deepEqual(r._burst, [], 'other user’s super reaction (found via count_details) removed');
  assert(burstDeletes.includes('@me') && burstDeletes.includes(mock.OTHER.id));
  assert(refreshed.includes(target.id), 'the on-screen copy is refreshed');
});

await test('forum channel target works when the channel is not loaded (search + final pass, and history)', async () => {
  for (const scan of ['search', 'history']) {
    const { mock, api } = setup();
    const ws = await openWs();
    const { deps } = purgeDeps(mock, api, ws, { channel: () => undefined });
    const job = new Job({ type: 'purge', title: 't', ws, params: {
      targets: [{ type: 'channel', id: mock.FORUM.id, guildId: mock.GID, name: '#help-forum', channelType: 15 }],
      mode: 'delete', authorMode: 'me', criteria: {}, scan, includeThreads: true, finalPass: 50,
    } });
    job.status = 'running';
    await createPurgeHandler(deps)(job);
    assert.equal(mine(mock, mock.POST.id).length, 0, `${scan}: my forum post messages deleted`);
  }
});

await test('server search purge with "Include threads" off leaves thread messages alone', async () => {
  const { mock, api } = setup();
  const ws = await openWs();
  const before = mine(mock, mock.THREAD.id).length;
  const { deps } = purgeDeps(mock, api, ws, { channel: () => undefined });
  const job = new Job({ type: 'purge', title: 't', ws, params: {
    targets: [{ type: 'guild', id: mock.GID, guildId: mock.GID, name: 'Test Server' }],
    mode: 'delete', authorMode: 'me', criteria: {}, scan: 'search', includeThreads: false, finalPass: 0,
  } });
  job.status = 'running';
  await createPurgeHandler(deps)(job);
  assert.equal(mine(mock, mock.THREAD.id).length, before, 'thread untouched');
  assert.equal(mock.THREAD.thread_metadata.archived, true);
  assert(mine(mock, mock.GENERAL.id).length <= 2, 'channel messages deleted (only unindexed ones left)');
});

await test('an "only mine" purge refuses to run without knowing who "me" is', async () => {
  const { mock, api } = setup();
  const ws = await openWs();
  const { deps } = purgeDeps(mock, api, ws, { meId: () => null });
  const job = new Job({ type: 'purge', title: 't', ws, params: { targets: [{ type: 'dm', id: mock.DM.id, name: 'dm' }], mode: 'delete', authorMode: 'me', criteria: {}, scan: 'search', finalPass: 0 } });
  job.status = 'running';
  await assert.rejects(createPurgeHandler(deps)(job), (e) => e.name === 'AuthError');
});

await test('multi-target purge saves the next target index before starting it', async () => {
  const { mock, api } = setup();
  const ws = await openWs();
  const saves = [];
  const put = ws.putJob.bind(ws);
  ws.putJob = (rec, o) => { saves.push(structuredClone(rec.state)); return put(rec, o); };
  let tiAtSecondStart = null;
  const { deps } = purgeDeps(mock, api, ws, { log: (l, m) => { if (/^Purging group/.test(m)) tiAtSecondStart = saves[saves.length - 1].ti; } });
  const job = new Job({ type: 'purge', title: 't', ws, resumable: true, params: {
    targets: [{ type: 'dm', id: mock.DM.id, name: 'dm' }, { type: 'dm', id: mock.GROUP.id, name: 'group' }],
    mode: 'delete', authorMode: 'me', criteria: {}, scan: 'history',
  } });
  job.status = 'running';
  await createPurgeHandler(deps)(job);
  assert.equal(tiAtSecondStart, 1, 'checkpoint points at the second target');
  assert.equal(mine(mock, mock.GROUP.id).length, 0);
});

await test('"everyone" purge without Manage Messages still deletes my own messages after others fail', async () => {
  const { mock, api } = setup(); // not admin: deleting other people's messages fails with 50013
  const ws = await openWs();
  const { deps } = purgeDeps(mock, api, ws);
  const job = new Job({ type: 'purge', title: 't', ws, params: {
    targets: [{ type: 'channel', id: mock.GENERAL.id, guildId: mock.GID, name: '#general' }],
    mode: 'delete', authorMode: 'anyone', criteria: {}, scan: 'history', includeThreads: false,
  } });
  job.status = 'running';
  await createPurgeHandler(deps)(job);
  assert.equal(mine(mock, mock.GENERAL.id).length, 0, 'all of mine deleted');
  assert(job.stats.failed >= 5 && job.stats.failed < 15, 'stopped trying other people’s messages');
  assert(mock.msgs[mock.GENERAL.id].some((m) => m.author.id === mock.OTHER.id));
});

console.log('bulk');
await test('bulk keeps unarchived threads in its saved state and re-archives them on cancel', async () => {
  const { mock, api } = setup();
  const ws = await openWs();
  let job;
  const deps = { api, log: () => {}, onDeleted: () => job.pause(), onUpdated: () => {}, onReactionsChanged: () => {} };
  const items = mine(mock, mock.THREAD.id).map((m) => slimForBulk(m));
  job = new Job({ type: 'bulk', title: 'b', ws, resumable: true, params: { action: 'delete', items } });
  job.status = 'running';
  const run = createBulkHandler(deps)(job);
  while (!job.paused) await new Promise((r) => setTimeout(r, 5));
  const saved = await ws.getJob(job.id);
  assert.deepEqual(saved.state.rearchive, [mock.THREAD.id], 'saved for a resume after a crash');
  assert.equal(mock.THREAD.thread_metadata.archived, false);
  job.cancel();
  await assert.rejects(run, (e) => e.name === 'CancelledError');
  assert.equal(mock.THREAD.thread_metadata.archived, true, 're-archived');
});

await test('bulk skips the rest of a channel after Missing Access instead of one request per message', async () => {
  const { mock, api } = setup();
  let deletes = 0;
  wrapFetch(mock, (method, url) => {
    if (method === 'DELETE' && url.pathname.startsWith('/api/v9/channels/999999999999999999/')) {
      deletes++;
      return new Response(JSON.stringify({ code: 50001, message: 'Missing Access' }), { status: 403, headers: { 'content-type': 'application/json' } });
    }
    return undefined;
  });
  const items = Array.from({ length: 5 }, (_, i) => ({ id: String(1100000000000000000n + BigInt(i)), channel_id: '999999999999999999', type: 0, content: 'x', attachments: [], reactions: [] }));
  const job = new Job({ type: 'bulk', title: 'b', params: { action: 'delete', items } });
  job.status = 'running';
  await createBulkHandler({ api, log: () => {}, onDeleted: () => {} })(job);
  assert.equal(deletes, 1);
  assert.equal(job.stats.skipped, 5);
  assert.equal(job.stats.failed, 0);
});

console.log('jobs + db');
await test('job params are written once; listJobs/getJob return them; deleteJob removes them; old records still load', async () => {
  const ws = await openWs();
  const job = new Job({ id: 'j1', type: 'bulk', title: 't', ws, resumable: true, params: { action: 'delete', items: [{ id: '1' }] } });
  let paramWrites = 0;
  const put = ws.putJob.bind(ws);
  ws.putJob = (rec, o = {}) => { if (o.withParams !== false) paramWrites++; return put(rec, o); };
  job.state.i = 1; await job.save();
  job.state.i = 2; await job.save();
  assert.equal(paramWrites, 1);
  const got = await ws.getJob('j1');
  assert.equal(got.state.i, 2);
  assert.deepEqual(got.params.items, [{ id: '1' }]);
  await ws._put('jobs', { id: 'old', type: 'purge', title: 'o', params: { targets: [] }, state: {} });
  const list = await ws.listJobs();
  assert.deepEqual(list.find((j) => j.id === 'old').params, { targets: [] });
  assert.deepEqual(list.find((j) => j.id === 'j1').params.items, [{ id: '1' }]);
  // export -> import keeps them
  let text = '';
  await ws.exportTo(async (s) => { text += s; });
  const ws2 = await openWs();
  await ws2.importFrom(new File([text], 'w.ndjson'));
  assert.deepEqual((await ws2.getJob('j1')).params.items, [{ id: '1' }]);
  await ws.deleteJob('j1');
  assert.equal(await ws.getJob('j1'), undefined);
  assert.equal(await ws.kvGet('jobparams:j1'), null);
});

await test('storage full on the very first checkpoint pauses the task instead of failing it', async () => {
  const ws = await openWs();
  let fail = true;
  const put = ws.putJob.bind(ws);
  ws.putJob = (rec, o) => { if (fail) { fail = false; return Promise.reject(new StorageFullError()); } return put(rec, o); };
  const jm = new JobManager({ log: () => {} });
  let ran = 0;
  jm.register('t', async () => { ran++; return 'ok'; });
  const job = new Job({ type: 't', title: 't', ws, resumable: true });
  const p = jm.start(job);
  while (!job.paused) await new Promise((r) => setTimeout(r, 5));
  assert.equal(job.pauseReason, 'Storage full');
  job.resume();
  assert.equal(await p, 'ok');
  assert.equal(ran, 1);
});

console.log('loading');
await test('loadHistory saves "fully loaded" for an empty channel, and does not resurrect a removed conversation', async () => {
  const { mock, api } = setup();
  const ws = await openWs();
  const empty = await api.openDm('100000000000000099');
  await ws.putConv({ key: 'ch:e', kind: 'channel', channelId: empty.id, count: 0 });
  await loadHistory({ api, ws, job: null, convKey: 'ch:e', channelId: empty.id, maxPages: 1 });
  assert.equal((await ws.getConv('ch:e')).doneChannels[empty.id], true);
  await ws.putConv({ key: 'ch:r', kind: 'channel', channelId: mock.DM.id, count: 0 });
  const realMessages = api.messages;
  api.messages = async (...a) => { await ws.deleteConv('ch:r'); return realMessages(...a); };
  await assert.rejects(loadHistory({ api, ws, job: null, convKey: 'ch:r', channelId: mock.DM.id, maxPages: 1 }), /removed/);
  api.messages = realMessages;
  assert.equal(await ws.getConv('ch:r'), undefined);
  assert.equal(await ws.countMessages('ch:r'), 0);
});

console.log(`\n${passed} tests passed${process.exitCode ? ', some FAILED' : ''}`);
