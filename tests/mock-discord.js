// A fake Discord REST API + CDN implemented as a fetch() replacement, for testing Cleancord offline.
// Works as a classic script (sets window.createMockDiscord) and as an ES module side-effect import.
(function (root) {
  const EPOCH = 1420070400000n;
  let seq = 0n;
  const sf = (ms) => (((BigInt(ms) - EPOCH) << 22n) + (seq++ % 4096n)).toString();
  const cmp = (a, b) => (a.length - b.length) || (a < b ? -1 : a > b ? 1 : 0);
  const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 4, 0, 0, 0, 4, 8, 2, 0, 0, 0, 38, 147, 9, 41, 0, 0, 0, 21, 73, 68, 65, 84, 120, 94, 99, 140, 72, 253, 196, 0, 3, 76, 112, 22, 3, 3, 30, 14, 0, 84, 152, 1, 183, 172, 134, 125, 48, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130]);

  function createMockDiscord(opts = {}) {
    const admin = !!opts.admin;
    const perChannel = opts.perChannel || 60;
    const ME = { id: '100000000000000001', username: 'tester', global_name: 'Test User', avatar: null, discriminator: '0' };
    const OTHER = { id: '100000000000000002', username: 'friend', global_name: 'Friendly', avatar: 'a1b2c3', discriminator: '0' };
    const BOT = { id: '100000000000000003', username: 'robot', global_name: null, bot: true, avatar: null, discriminator: '0' };
    const GID = '200000000000000001';
    const GUILD = { id: GID, name: 'Test Server', icon: null, owner: false, permissions: '0' };
    const ROLE = { id: '600000000000000001', name: 'Mods', color: 0xe91e63, position: 2, icon: null, unicode_emoji: '🛡' };
    const roles = [{ id: GID, name: '@everyone', color: 0, position: 0 }, ROLE];
    const ch = {};
    const add = (c) => { ch[c.id] = c; return c; };
    const DM = add({ id: '300000000000000001', type: 1, recipients: [OTHER] });
    const GROUP = add({ id: '300000000000000002', type: 3, name: null, recipients: [OTHER, BOT] });
    const CAT = add({ id: '400000000000000001', type: 4, name: 'Text', guild_id: GID, position: 0 });
    const GENERAL = add({ id: '400000000000000002', type: 0, name: 'general', guild_id: GID, parent_id: CAT.id, position: 0 });
    const RANDOM = add({ id: '400000000000000003', type: 0, name: 'random', guild_id: GID, parent_id: CAT.id, position: 1 });
    const FORUM = add({ id: '400000000000000004', type: 15, name: 'help-forum', guild_id: GID, parent_id: null, position: 2 });
    const VOICE = add({ id: '400000000000000005', type: 2, name: 'Lounge', guild_id: GID, parent_id: CAT.id, position: 3 });
    const THREAD = add({ id: '500000000000000001', type: 11, name: 'old-thread', guild_id: GID, parent_id: GENERAL.id, thread_metadata: { archived: true, locked: false, archive_timestamp: '2024-01-01T00:00:00Z' } });
    const POST = add({ id: '500000000000000002', type: 11, name: 'How do I?', guild_id: GID, parent_id: FORUM.id, thread_metadata: { archived: false, locked: false, archive_timestamp: '2024-02-01T00:00:00Z' } });
    const msgs = {}; // cid -> array (ascending)
    const unindexed = new Set();
    const log = [];
    let deletes = 0;
    let searchedScopes = new Set();

    const t0 = Date.parse('2024-03-01T10:00:00Z');
    const authors = [ME, OTHER, ME, BOT, ME, OTHER];
    function gen(cid, n, guildId) {
      const list = [];
      for (let i = 0; i < n; i++) {
        const ms = t0 + i * 3600_000 + Number(cid.slice(-2)) * 1000;
        const id = sf(ms);
        const author = authors[i % authors.length];
        const m = {
          id, channel_id: cid, author, type: 0, content: `Message ${i} in ${cid.slice(-3)} **bold** _it_ \`code\``,
          timestamp: new Date(ms).toISOString(), edited_timestamp: null, attachments: [], embeds: [], mentions: [], mention_roles: [],
          pinned: false, reactions: [], ...(guildId ? { guild_id: guildId } : {}),
        };
        if (i % 7 === 3) m.attachments.push({ id: sf(ms + 1), filename: `photo_${i}.png`, size: 69, content_type: 'image/png', width: 800, height: 600,
          url: `https://cdn.discordapp.com/attachments/${cid}/${id}/photo_${i}.png?ex=${(i % 14 === 3 ? 1 : 0x7fffffff).toString(16)}&is=0&hm=abc&`,
          proxy_url: `https://media.discordapp.net/attachments/${cid}/${id}/photo_${i}.png?ex=7fffffff&is=0&hm=abc&` });
        if (i % 11 === 5) m.attachments.push({ id: sf(ms + 2), filename: `notes ${i}.txt`, size: 12, content_type: 'text/plain', url: `https://cdn.discordapp.com/attachments/${cid}/${id}/notes_${i}.txt?ex=7fffffff&is=0&hm=x&` });
        if (i % 5 === 2) m.reactions.push({ emoji: { id: null, name: '👍' }, count: 2, me: true, me_burst: false, burst_count: 0, _users: [ME.id, OTHER.id] });
        if (i % 9 === 4) m.reactions.push({ emoji: { id: '700000000000000001', name: 'party', animated: false }, count: 1, me: false, me_burst: false, burst_count: 0, _users: [OTHER.id] });
        if (i % 8 === 6 && list.length) { m.type = 19; m.message_reference = { message_id: list[i - 1].id, channel_id: cid, type: 0 }; m.referenced_message = { ...list[i - 1], referenced_message: undefined }; m.mentions = [list[i - 1].author]; }
        if (i % 13 === 7) m.content += ` hey <@${OTHER.id}> see <#${GENERAL.id}> <:party:700000000000000001> <@&${ROLE.id}> <t:1700000000:R> https://example.com/page?a=1&b=2 ||secret||`;
        if (i % 10 === 9) m.embeds.push({ type: 'rich', title: `Embed ${i}`, description: 'Some *embed* text', color: 0x2ecc71, url: 'https://example.com', fields: [{ name: 'A', value: '1', inline: true }, { name: 'B', value: '2', inline: true }], thumbnail: { url: 'https://example.com/t.png', proxy_url: 'https://images-ext-1.discordapp.net/external/abc/https/example.com/t.png', width: 80, height: 80 }, footer: { text: 'footer' } });
        if (i === 12) m.pinned = true;
        if (i === 15) { m.content = ''; m.message_snapshots = [{ message: { content: 'forwarded text', attachments: [], embeds: [], timestamp: new Date(ms - 1e6).toISOString() } }]; m.message_reference = { type: 1, message_id: '1', channel_id: '1' }; }
        if (i === 16) m.poll = { question: { text: 'Best fruit?' }, answers: [{ answer_id: 1, poll_media: { text: 'Apple' } }, { answer_id: 2, poll_media: { text: 'Pear', emoji: { name: '🍐' } } }], results: { is_finalized: true, answer_counts: [{ id: 1, count: 3, me_voted: true }, { id: 2, count: 1, me_voted: false }] } };
        if (i === 17) m.sticker_items = [{ id: '800000000000000001', name: 'wave', format_type: 1 }];
        if (i === 18) { m.type = guildId ? 7 : 3; m.content = ''; if (!guildId) m.call = { participants: [OTHER.id], ended_timestamp: new Date(ms + 125000).toISOString() }; }
        if (i === 19) { m.type = 6; m.content = ''; m.author = ME; m.message_reference = { message_id: list[12] && list[12].id, channel_id: cid }; }
        if (i === 20 && cid === GENERAL.id) { m.thread = { id: THREAD.id, name: THREAD.name, message_count: 4 }; }
        list.push(m);
      }
      msgs[cid] = list;
      unindexed.add(list[list.length - 1].id);
      unindexed.add(list[list.length - 2].id);
    }
    gen(DM.id, perChannel);
    gen(GROUP.id, Math.round(perChannel / 3));
    gen(GENERAL.id, perChannel, GID);
    gen(RANDOM.id, Math.round(perChannel / 2), GID);
    gen(THREAD.id, 8, GID);
    gen(POST.id, 6, GID);
    gen(VOICE.id, 4, GID);

    const json = (status, body, headers = {}) => new Response(body === null ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
    const err = (status, code, message) => json(status, { code, message });
    const findMsg = (cid, mid) => (msgs[cid] || []).find((m) => m.id === mid);
    const strip = (m) => {
      const o = JSON.parse(JSON.stringify(m));
      for (const r of o.reactions || []) delete r._users;
      if (o.referenced_message) for (const r of o.referenced_message.reactions || []) delete r._users;
      if (o.reactions && !o.reactions.length) delete o.reactions;
      return o;
    };
    const isGuildCh = (c) => !!(ch[c] && ch[c].guild_id);
    const threadOf = (c) => ch[c] && (ch[c].type === 11 || ch[c].type === 12) ? ch[c] : null;

    function hasType(m, t) {
      const atts = m.attachments || [];
      switch (t) {
        case 'link': return /https?:\/\//.test(m.content);
        case 'embed': return (m.embeds || []).length > 0;
        case 'file': return atts.length > 0;
        case 'image': return atts.some((a) => (a.content_type || '').startsWith('image/'));
        case 'video': return atts.some((a) => (a.content_type || '').startsWith('video/'));
        case 'sound': return false;
        case 'sticker': return !!(m.sticker_items && m.sticker_items.length);
        case 'poll': return !!m.poll;
        case 'snapshot': return !!m.message_snapshots;
        default: return true;
      }
    }

    function search(scope, q) {
      const key = scope;
      if (!searchedScopes.has(key) && opts.indexDelay) { searchedScopes.add(key); return json(202, { retry_after: 0.01, documents_indexed: 0 }); }
      let pool = [];
      if (scope.startsWith('g:')) {
        let ids = q.getAll('channel_id');
        if (!ids.length) ids = Object.keys(msgs).filter((c) => isGuildCh(c) && ch[c].guild_id === scope.slice(2));
        for (const c of ids) pool.push(...(msgs[c] || []));
      } else pool = [...(msgs[scope.slice(2)] || [])];
      const authorsQ = q.getAll('author_id');
      const has = q.getAll('has');
      const mentions = q.getAll('mentions');
      const content = (q.get('content') || '').toLowerCase();
      const min = q.get('min_id');
      const max = q.get('max_id');
      const pinned = q.get('pinned');
      pool = pool.filter((m) => !unindexed.has(m.id) && (m.type === 0 || m.type === 19)
        && (!authorsQ.length || authorsQ.includes(m.author.id))
        && (!content || m.content.toLowerCase().includes(content))
        && has.every((t) => hasType(m, t))
        && (!mentions.length || (m.mentions || []).some((u) => mentions.includes(u.id)))
        && (!min || cmp(m.id, min) > 0) && (!max || cmp(m.id, max) < 0)
        && (pinned == null || String(!!m.pinned) === pinned));
      pool.sort((a, b) => (q.get('sort_order') === 'asc' ? cmp(a.id, b.id) : cmp(b.id, a.id)));
      const offset = Number(q.get('offset') || 0);
      if (offset > 9975) return err(400, 50035, 'Invalid Form Body');
      const page = pool.slice(offset, offset + 25);
      const threads = [...new Set(page.map((m) => m.channel_id))].map((c) => threadOf(c)).filter(Boolean);
      return json(200, { total_results: pool.length, messages: page.map((m) => [{ ...strip(m), hit: true }]), threads });
    }

    function listMessages(cid, q) {
      const all = msgs[cid];
      if (!all) return err(404, 10003, 'Unknown Channel');
      if (ch[cid].type === 15) return err(400, 50024, 'Cannot execute action on this channel type');
      const limit = Math.min(100, Number(q.get('limit') || 50));
      let out;
      if (q.get('around')) {
        const a = q.get('around');
        const idx = all.findIndex((m) => cmp(m.id, a) >= 0);
        const i = idx < 0 ? all.length - 1 : idx;
        const half = Math.floor(limit / 2);
        out = all.slice(Math.max(0, i - half), Math.max(0, i - half) + limit);
      } else if (q.get('after')) {
        out = all.filter((m) => cmp(m.id, q.get('after')) > 0).slice(0, limit);
      } else {
        const b = q.get('before');
        const pool = b ? all.filter((m) => cmp(m.id, b) < 0) : all;
        out = pool.slice(Math.max(0, pool.length - limit));
      }
      return json(200, [...out].reverse().map(strip));
    }

    function reactionFor(m, emojiStr) {
      const e = decodeURIComponent(emojiStr);
      return (m.reactions || []).find((r) => (r.emoji.id ? `${r.emoji.name}:${r.emoji.id}` : r.emoji.name) === e);
    }

    async function handleApi(method, path, q, body) {
      let mm;
      if (path === '/users/@me') return json(200, ME);
      if (path === '/users/@me/guilds') return json(200, [GUILD]);
      if (path === '/users/@me/channels' && method === 'GET') return json(200, [DM, GROUP]);
      if (path === '/users/@me/channels' && method === 'POST') {
        const uid = (body.recipients || [])[0];
        let c = Object.values(ch).find((x) => x.type === 1 && x.recipients[0].id === uid);
        if (!c) { c = add({ id: sf(Date.now()), type: 1, recipients: [{ id: uid, username: 'someone', avatar: null, discriminator: '0' }] }); msgs[c.id] = []; }
        return json(200, c);
      }
      if (path === '/users/@me/relationships') return json(200, [{ id: OTHER.id, type: 1, user: OTHER, nickname: null }, { id: BOT.id, type: 2, user: BOT }]);
      if (path === '/attachments/refresh-urls') return json(200, { refreshed_urls: body.attachment_urls.map((u) => ({ original: u, refreshed: u.replace(/ex=[0-9a-f]+/, 'ex=7fffffff') })) });
      if ((mm = /^\/guilds\/(\d+)\/channels$/.exec(path))) return json(200, Object.values(ch).filter((c) => c.guild_id === mm[1] && c.type !== 11 && c.type !== 12));
      if ((mm = /^\/guilds\/(\d+)\/roles$/.exec(path))) return json(200, roles);
      if ((mm = /^\/guilds\/(\d+)$/.exec(path))) return json(200, { ...GUILD, roles });
      if ((mm = /^\/guilds\/(\d+)\/members\/(\d+)$/.exec(path))) {
        if (mm[2] === OTHER.id) return json(200, { nick: 'Buddy', roles: [ROLE.id], user: OTHER });
        if (mm[2] === ME.id || mm[2] === BOT.id) return json(200, { nick: null, roles: [], user: mm[2] === ME.id ? ME : BOT });
        return err(404, 10007, 'Unknown Member');
      }
      if ((mm = /^\/guilds\/(\d+)\/threads\/active$/.exec(path))) return err(403, 20002, 'Only bots can use this endpoint');
      if ((mm = /^\/guilds\/(\d+)\/messages\/search$/.exec(path))) return search('g:' + mm[1], q);
      if ((mm = /^\/channels\/(\d+)\/messages\/search$/.exec(path))) return search('c:' + mm[1], q);
      if ((mm = /^\/channels\/(\d+)\/threads\/archived\/(public|private)$/.exec(path))) {
        if (mm[2] === 'private') return err(403, 50013, 'Missing Permissions');
        return json(200, { threads: Object.values(ch).filter((c) => c.parent_id === mm[1] && c.type === 11 && c.thread_metadata.archived), members: [], has_more: false });
      }
      if ((mm = /^\/channels\/(\d+)\/threads\/search$/.exec(path))) {
        const archived = q.get('archived') === 'true';
        return json(200, { threads: Object.values(ch).filter((c) => c.parent_id === mm[1] && c.type === 11 && !!c.thread_metadata.archived === archived), has_more: false, total_results: 0 });
      }
      if ((mm = /^\/channels\/(\d+)$/.exec(path))) {
        const c = ch[mm[1]];
        if (!c) return err(404, 10003, 'Unknown Channel');
        if (method === 'PATCH') {
          if (c.thread_metadata && 'archived' in body) c.thread_metadata.archived = !!body.archived;
          return json(200, c);
        }
        return json(200, c);
      }
      if ((mm = /^\/channels\/(\d+)\/messages$/.exec(path))) return listMessages(mm[1], q);
      if ((mm = /^\/channels\/(\d+)\/messages\/(\d+)$/.exec(path))) {
        const [, cid, mid] = mm;
        const m = findMsg(cid, mid);
        if (!m) return err(404, 10008, 'Unknown Message');
        const th = threadOf(cid);
        if (th && th.thread_metadata.archived && method !== 'GET') return err(400, 50083, 'Thread is archived');
        if (method === 'DELETE') {
          deletes++;
          if (opts.rateLimitEvery && deletes % opts.rateLimitEvery === 0 && !m._limited) { m._limited = true; return json(429, { message: 'You are being rate limited.', retry_after: 0.05, global: false }); }
          if ([1, 2, 3, 4, 5, 21].includes(m.type)) return err(400, 50021, 'Cannot execute action on a system message');
          if (m.author.id !== ME.id) {
            if (!isGuildCh(cid)) return err(403, 50003, 'Cannot execute action on a DM channel');
            if (!admin) return err(403, 50013, 'Missing Permissions');
          }
          msgs[cid] = msgs[cid].filter((x) => x.id !== mid);
          return new Response(null, { status: 204 });
        }
        if (method === 'PATCH') {
          if (m.author.id !== ME.id) return err(403, 50005, 'Cannot edit a message authored by another user');
          if ('content' in body) m.content = body.content;
          if ('attachments' in body) { const keep = new Set(body.attachments.map((a) => a.id)); m.attachments = m.attachments.filter((a) => keep.has(a.id)); }
          if (!m.content && !m.attachments.length && !m.embeds.length) return err(400, 50006, 'Cannot send an empty message');
          m.edited_timestamp = new Date().toISOString();
          return json(200, strip(m));
        }
      }
      if ((mm = /^\/channels\/(\d+)\/messages\/(\d+)\/reactions(?:\/([^/]+)(?:\/([^/]+))?)?$/.exec(path))) {
        const [, cid, mid, emoji, who] = mm;
        const m = findMsg(cid, mid);
        if (!m) return err(404, 10008, 'Unknown Message');
        if (!emoji) {
          if (!admin) return err(403, 50013, 'Missing Permissions');
          m.reactions = [];
          return new Response(null, { status: 204 });
        }
        const r = reactionFor(m, emoji);
        if (method === 'GET') {
          if (!r) return json(200, []);
          const users = r._users.map((id) => [ME, OTHER, BOT].find((u) => u.id === id) || { id, username: 'x' });
          const after = q.get('after');
          return json(200, users.filter((u) => !after || cmp(u.id, after) > 0));
        }
        if (method === 'DELETE') {
          if (!r) return err(404, 10014, 'Unknown Emoji');
          if (!who) { if (!admin) return err(403, 50013, 'Missing Permissions'); m.reactions = m.reactions.filter((x) => x !== r); return new Response(null, { status: 204 }); }
          const uid = who === '@me' ? ME.id : who;
          if (uid !== ME.id && !admin) return err(403, 50013, 'Missing Permissions');
          r._users = r._users.filter((x) => x !== uid);
          r.count = r._users.length;
          if (uid === ME.id) r.me = false;
          if (!r.count) m.reactions = m.reactions.filter((x) => x !== r);
          return new Response(null, { status: 204 });
        }
      }
      return err(404, 0, `Mock: no route for ${method} ${path}`);
    }

    async function mockFetch(input, init = {}) {
      const url = new URL(typeof input === 'string' ? input : input.url);
      const method = (init.method || 'GET').toUpperCase();
      log.push({ method, url: url.toString(), auth: !!(init.headers && (init.headers.Authorization || init.headers.authorization)) });
      if (url.hostname === 'discord.com' && url.pathname.startsWith('/api/v9/')) {
        const hdr = init.headers || {};
        if (!hdr.Authorization && !hdr.authorization) return json(401, { message: '401: Unauthorized', code: 0 });
        const body = init.body ? JSON.parse(init.body) : null;
        return handleApi(method, url.pathname.slice(7), url.searchParams, body);
      }
      if (/(^|\.)discordapp\.(com|net)$/.test(url.hostname)) {
        if (init.headers && (init.headers.Authorization || init.headers.authorization)) throw new Error('TOKEN LEAKED TO CDN');
        const ex = url.searchParams.get('ex');
        if (ex && parseInt(ex, 16) * 1000 < Date.now()) return new Response('expired', { status: 404 });
        return new Response(PNG, { status: 200, headers: { 'content-type': 'image/png' } });
      }
      throw new Error(`Mock: blocked request to ${url.hostname}`);
    }

    return { fetch: mockFetch, log, msgs, ch, ME, OTHER, BOT, GUILD, GID, DM, GROUP, GENERAL, RANDOM, FORUM, VOICE, THREAD, POST, unindexed };
  }

  root.createMockDiscord = createMockDiscord;
})(typeof window !== 'undefined' ? window : globalThis);
