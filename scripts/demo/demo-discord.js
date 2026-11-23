// Demo version of the fake Discord API, filled with a fictional community, used to record the README screenshots and GIFs.
// Every person, server and message here is made up.
// Works as a classic script (sets window.createMockDiscord) and as an ES module side-effect import.
(function (root) {
  const EPOCH = 1420070400000n;
  let seq = 0n;
  const sf = (ms) => (((BigInt(ms) - EPOCH) << 22n) + (seq++ % 4096n)).toString();
  const cmp = (a, b) => (a.length - b.length) || (a < b ? -1 : a > b ? 1 : 0);
  // eslint-disable-next-line no-unused-vars
  const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 4, 0, 0, 0, 4, 8, 2, 0, 0, 0, 38, 147, 9, 41, 0, 0, 0, 21, 73, 68, 65, 84, 120, 94, 99, 140, 72, 253, 196, 0, 3, 76, 112, 22, 3, 3, 30, 14, 0, 84, 152, 1, 183, 172, 134, 125, 48, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130]);


  function createDemoDiscord(opts = {}) {
    const admin = false;
    const log = [];
    let deletes = 0;
    const searchedScopes = new Set();
    const unindexed = new Set();
    const u = (id, username, global_name, extra = {}) => ({ id, username, global_name, avatar: 'av' + id.slice(-2), discriminator: '0', ...extra });
    const ME = u('310000000000000001', 'alex.codes', 'Alex');
    const MIRA = u('310000000000000002', 'mira.pix', 'Mira');
    const JONAS = u('310000000000000003', 'jonas_k', 'Jonas');
    const SAM = u('310000000000000004', 'sam.draws', 'Sam');
    const RIN = u('310000000000000005', 'rinrin', 'Rin');
    const BOT = u('310000000000000006', 'PixelBot', 'PixelBot', { bot: true });
    const USERS = Object.fromEntries([ME, MIRA, JONAS, SAM, RIN, BOT].map((x) => [x.id, x]));
    const FRIENDS = [MIRA, JONAS, SAM, RIN];
    const G1 = '320000000000000001';
    const GUILDS = [
      { id: G1, name: 'Cozy Pixel Club', icon: 'icon01' },
      { id: '320000000000000002', name: 'Night Owls Study', icon: 'icon02' },
      { id: '320000000000000003', name: 'Indie Dev Lounge', icon: null },
      { id: '320000000000000004', name: 'Retro Racing League', icon: 'icon04' },
    ];
    const ROLES = {
      [G1]: [
        { id: G1, name: '@everyone', color: 0, position: 0 },
        { id: '360000000000000001', name: 'Admin', color: 0xf04747, position: 3, unicode_emoji: '👑' },
        { id: '360000000000000002', name: 'Artist', color: 0xb57bff, position: 2, unicode_emoji: '🎨' },
        { id: '360000000000000003', name: 'Member', color: 0x3ec27c, position: 1 },
      ],
    };
    const MEMBERS = {
      [G1]: {
        [ME.id]: { nick: null, roles: ['360000000000000003'] },
        [MIRA.id]: { nick: null, roles: ['360000000000000002', '360000000000000003'] },
        [SAM.id]: { nick: 'Sammy', roles: ['360000000000000002'] },
        [JONAS.id]: { nick: null, roles: ['360000000000000003'] },
        [RIN.id]: { nick: 'Rin ✦', roles: ['360000000000000001'] },
        [BOT.id]: { nick: null, roles: [] },
      },
    };
    const ch = {};
    const msgs = {};
    const add = (c) => { ch[c.id] = c; msgs[c.id] = msgs[c.id] || []; return c; };
    const gc = (id, name, type, parent, position, guild = G1) => add({ id, name, type, guild_id: guild, parent_id: parent, position });
    gc('330000000000000001', 'Info', 4, null, 0);
    gc('330000000000000002', 'rules', 0, '330000000000000001', 0);
    gc('330000000000000003', 'announcements', 5, '330000000000000001', 1);
    gc('330000000000000004', 'Chat', 4, null, 1);
    const GENERAL = gc('330000000000000005', 'general', 0, '330000000000000004', 0);
    const ART = gc('330000000000000006', 'art-share', 0, '330000000000000004', 1);
    const OFFTOPIC = gc('330000000000000007', 'off-topic', 0, '330000000000000004', 2);
    const MEMES = gc('330000000000000008', 'memes', 0, '330000000000000004', 3);
    gc('330000000000000009', 'Voice', 4, null, 2);
    const LOUNGE = gc('330000000000000010', 'Lounge', 2, '330000000000000009', 0);
    const FORUM = gc('330000000000000011', 'help-forum', 15, null, 3);
    const CHALLENGE = add({ id: '340000000000000001', type: 11, name: 'Weekly art challenge: Autumn', guild_id: G1, parent_id: ART.id, thread_metadata: { archived: false, locked: false, archive_timestamp: '2026-11-20T10:00:00Z' } });
    const OLDPLAN = add({ id: '340000000000000002', type: 11, name: 'Old event planning', guild_id: G1, parent_id: GENERAL.id, thread_metadata: { archived: true, locked: false, archive_timestamp: '2026-06-01T10:00:00Z' } });
    const POST = add({ id: '340000000000000003', type: 11, name: 'How do I export a sprite sheet?', guild_id: G1, parent_id: FORUM.id, thread_metadata: { archived: false, locked: false, archive_timestamp: '2026-11-18T10:00:00Z' } });
    for (const g of GUILDS.slice(1)) {
      add({ id: g.id.replace(/^32/, '37') , name: 'general', type: 0, guild_id: g.id, parent_id: null, position: 0 });
      add({ id: g.id.replace(/^32/, '38'), name: 'resources', type: 0, guild_id: g.id, parent_id: null, position: 1 });
    }
    const DMS = [
      add({ id: '350000000000000001', type: 1, recipients: [MIRA], last_message_id: '9' }),
      add({ id: '350000000000000002', type: 1, recipients: [JONAS], last_message_id: '8' }),
      add({ id: '350000000000000003', type: 3, name: 'Weekend trip 🏕️', recipients: [MIRA, JONAS, SAM], last_message_id: '7' }),
      add({ id: '350000000000000004', type: 1, recipients: [SAM], last_message_id: '6' }),
      add({ id: '350000000000000005', type: 1, recipients: [RIN], last_message_id: '5' }),
    ];

    const EPOCH = 1420070400000n;
    let seq = 0n;
    const sf = (ms) => (((BigInt(ms) - EPOCH) << 22n) + (seq++ % 4096n)).toString();
    const img = (cid, mid, name, w, h) => ({
      id: sf(Date.parse('2026-01-01')), filename: name, size: 48213, content_type: 'image/png', width: w, height: h,
      url: `https://cdn.discordapp.com/attachments/${cid}/${mid}/${name}?ex=7fffffff&is=0&hm=demo&`,
      proxy_url: `https://media.discordapp.net/attachments/${cid}/${mid}/${name}?ex=7fffffff&is=0&hm=demo&`,
    });
    const react = (name, users) => ({ emoji: { id: null, name }, count: users.length, me: users.includes(ME.id), me_burst: false, burst_count: 0, _users: users });

    // post(cid, iso, author, content, extra) — messages are kept in ascending order
    function post(cid, when, author, content, extra = {}) {
      const ms = typeof when === 'number' ? when : Date.parse(when);
      const id = sf(ms);
      const c = ch[cid];
      const m = { id, channel_id: cid, author, type: 0, content, timestamp: new Date(ms).toISOString(), edited_timestamp: null,
        attachments: [], embeds: [], mentions: [], mention_roles: [], pinned: false, reactions: [], ...(c.guild_id ? { guild_id: c.guild_id } : {}) };
      if (extra.image) m.attachments.push(img(cid, id, ...extra.image));
      if (extra.reactions) m.reactions = extra.reactions;
      if (extra.embed) m.embeds.push(extra.embed);
      if (extra.replyTo) { m.type = 19; m.message_reference = { message_id: extra.replyTo.id, channel_id: cid, type: 0 }; m.referenced_message = { ...extra.replyTo, reactions: [] }; m.mentions = [extra.replyTo.author]; }
      if (extra.poll) m.poll = extra.poll;
      if (extra.type != null) m.type = extra.type;
      if (extra.pinned) m.pinned = true;
      if (extra.thread) m.thread = extra.thread;
      if (extra.mentions) m.mentions = extra.mentions;
      msgs[cid].push(m);
      return m;
    }

    // ---- older history (so there is something to load, search and purge) ----
    const filler = {
      [ME.id]: ['lol', 'same here', 'brb', 'anyone up?', 'ok that was fun', 'gg everyone', 'who wants pizza later', 'night all 🌙', 'that update broke my save 😭', 'ok fixed it', 'lmao', 'send the link?', 'can someone check teh build', 'pizza again tonight?', 'back'],
      [MIRA.id]: ['new sketch soon 👀', 'omg yes', 'love that palette', 'haha', 'working on tiles again'],
      [JONAS.id]: ['game night?', 'who is online', 'I can host', 'nice!', 'pushing a fix now'],
      [SAM.id]: ['ooh', 'reminder: art challenge friday', 'that is so clean', 'agreed'],
      [RIN.id]: ['please keep memes in #memes 🙏', 'welcome!', 'server rules updated'],
    };
    const people = [ME, MIRA, JONAS, SAM, RIN, ME, ME];
    let pick = 7;
    const next = (arr) => arr[(pick = (pick * 31 + 17) % 9973) % arr.length];
    function history(cid, count, startIso, endIso) {
      const a = Date.parse(startIso), b = Date.parse(endIso);
      for (let i = 0; i < count; i++) {
        const who = next(people);
        post(cid, a + Math.floor((b - a) * (i / count)), who, next(filler[who.id]));
      }
    }
    history(GENERAL.id, 140, '2026-06-01T12:00:00Z', '2026-11-20T09:00:00Z');
    history(OFFTOPIC.id, 40, '2026-08-01T12:00:00Z', '2026-11-19T09:00:00Z');
    history(MEMES.id, 30, '2026-07-01T12:00:00Z', '2026-11-19T09:00:00Z');
    history(OLDPLAN.id, 12, '2026-04-01T12:00:00Z', '2026-05-20T09:00:00Z');
    for (const g of GUILDS.slice(1)) history(g.id.replace(/^32/, '37'), 25, '2026-09-01T12:00:00Z', '2026-11-21T09:00:00Z');

    post('330000000000000002', '2026-01-10T12:00:00Z', RIN, '# Server rules\n1. Be kind\n2. Credit artists when you share their work\n3. Keep memes in <#330000000000000008>', { pinned: true });
    post('330000000000000003', '2026-11-15T12:00:00Z', RIN, '📣 **Winter jam** starts December 1st! Theme reveal at noon.', { reactions: [react('🎉', [ME.id, MIRA.id, SAM.id, JONAS.id])] });

    // ---- #general: the "story" shown in screenshots ----
    const t = (h, m) => Date.UTC(2026, 10, 22, h, m);
    post(GENERAL.id, t(16, 2), RIN, `Welcome to everyone who joined this week! 👋 Read <#330000000000000002> and say hi`);
    const tiles = post(GENERAL.id, t(16, 10), MIRA, 'Finished the forest tileset I have been working on 🌲✨', { image: ['forest_tileset.png', 960, 540], reactions: [react('😍', [ME.id, SAM.id, JONAS.id, RIN.id, BOT.id]), react('🔥', [JONAS.id, SAM.id, ME.id])] });
    post(GENERAL.id, t(16, 12), ME, 'that looks amazing, the light on the water is so good');
    const gn = post(GENERAL.id, t(16, 40), JONAS, 'Game night tonight at 8? I can host 🎮');
    post(GENERAL.id, t(16, 41), ME, "I'm in! bringing pizza 🍕", { replyTo: gn, reactions: [react('🍕', [JONAS.id, MIRA.id])] });
    post(GENERAL.id, t(16, 45), BOT, '', { embed: { type: 'rich', title: '🎮 Game night tonight', description: 'Hosted by **Jonas** in the Lounge voice channel. Bring snacks!', color: 0x10b981, fields: [{ name: 'When', value: '20:00', inline: true }, { name: 'Game', value: 'Pixel Party', inline: true }, { name: 'Players', value: '4 / 8', inline: true }], footer: { text: 'PixelBot • reply with /join' } } });
    post(GENERAL.id, t(17, 3), SAM, `reminder: this week's art challenge theme is ***autumn*** 🍂`, { thread: { id: CHALLENGE.id, name: CHALLENGE.name, message_count: 6 } });
    post(GENERAL.id, t(17, 20), ME, 'ok who keeps posting cat pictures in <#330000000000000008> 😂');
    post(GENERAL.id, t(17, 21), MIRA, 'guilty 🐱', { image: ['cat_sketch.png', 640, 640], reactions: [react('😂', [ME.id, JONAS.id, RIN.id, SAM.id])] });
    post(GENERAL.id, t(17, 35), ME, 'found a great guide on lighting: https://example.com/pixel-art-lighting', { embed: { type: 'article', url: 'https://example.com/pixel-art-lighting', title: 'Lighting tricks for pixel art', description: 'Rim light, dithering and color ramps, explained with examples you can copy.', provider: { name: 'Example Blog' }, color: 0x0ea5e9, thumbnail: { url: 'https://example.com/lighting_thumb.png', proxy_url: 'https://images-ext-1.discordapp.net/external/demo/https/example.com/lighting_thumb.png', width: 400, height: 400 } } });
    post(GENERAL.id, t(18, 2), RIN, 'Next game night?', { poll: { question: { text: 'Next game night?' }, answers: [{ answer_id: 1, poll_media: { text: 'Friday', emoji: { name: '🎉' } } }, { answer_id: 2, poll_media: { text: 'Saturday', emoji: { name: '🌙' } } }], results: { is_finalized: false, answer_counts: [{ id: 1, count: 4, me_voted: false }, { id: 2, count: 7, me_voted: true }] } } });
    post(GENERAL.id, t(18, 20), JONAS, 'anyone tried the new **Pixel Party** update?');
    post(GENERAL.id, t(18, 22), ME, 'yes! the new levels are wild. also `/party join` finally works');
    post(GENERAL.id, t(18, 30), MIRA, `<@${ME.id}> see you at 8 then!`, { mentions: [ME] });

    // ---- #art-share + thread ----
    post(ART.id, t(12, 0), SAM, 'autumn study, still WIP 🍂', { image: ['autumn_leaves.png', 900, 600], reactions: [react('🍂', [MIRA.id, ME.id, RIN.id])] });
    post(ART.id, t(13, 30), MIRA, 'night city practice', { image: ['city_night.png', 960, 540], reactions: [react('✨', [SAM.id, ME.id])] });
    post(ART.id, t(14, 0), ME, 'these are so good, I need to start drawing again');
    post(CHALLENGE.id, t(10, 5), SAM, 'Post your autumn pieces here 🍁');
    post(CHALLENGE.id, t(11, 0), MIRA, 'mine!', { image: ['autumn_leaves.png', 900, 600] });
    post(CHALLENGE.id, t(11, 30), ME, 'mine is late but here it is', { image: ['forest_tileset.png', 960, 540] });
    post(POST.id, t(9, 0), JONAS, 'Which tool do you all use to export sprite sheets?');
    post(POST.id, t(9, 20), ME, 'I use the built-in exporter, then trim with a script');
    post(LOUNGE.id, t(20, 5), JONAS, 'voice chat link for later 🎧');

    // ---- #off-topic: lots of Alex messages to clean up ----
    post(OFFTOPIC.id, t(9, 0), ME, 'does anyone remember the name of that racing game?');
    post(OFFTOPIC.id, t(9, 5), JONAS, 'Retro Racer 2?');
    post(OFFTOPIC.id, t(9, 6), ME, 'YES thank you');

    // ---- DMs ----
    const d = (day, h, m) => Date.UTC(2026, 10, day, h, m);
    const M = DMS[0].id;
    post(M, d(18, 18, 0), MIRA, 'hey! did you see the new tileset pack?');
    post(M, d(18, 18, 3), ME, 'not yet, sending me teh link?');
    post(M, d(18, 18, 4), MIRA, 'here 👉 https://example.com/tiles');
    post(M, d(18, 18, 10), ME, 'wow teh water tiles are perfect for my game');
    post(M, d(19, 20, 0), ME, 'also I finished teh first level!', { image: ['level_one.png', 960, 540], reactions: [react('🎉', [MIRA.id])] });
    post(M, d(19, 20, 4), MIRA, 'that looks so good!! the colors 😍');
    post(M, d(20, 9, 15), ME, 'thanks! teh boss fight is next');
    post(M, d(21, 21, 30), MIRA, 'game night tomorrow?');
    post(M, d(21, 21, 31), ME, 'for sure, I will bring snacks');
    post(M, d(22, 10, 0), MIRA, 'pizza or tacos?');
    post(M, d(22, 10, 1), ME, 'pizza obviously 🍕');
    const W = DMS[2].id;
    post(W, d(15, 12, 0), SAM, 'cabin is booked! 🏕️');
    post(W, d(15, 12, 2), ME, 'amazing, I will drive');
    post(W, d(15, 12, 5), JONAS, 'I can bring the board games');
    post(W, d(16, 9, 0), MIRA, 'packing list?', { poll: { question: { text: 'Who brings the speaker?' }, answers: [{ answer_id: 1, poll_media: { text: 'Jonas' } }, { answer_id: 2, poll_media: { text: 'Alex' } }], results: { is_finalized: true, answer_counts: [{ id: 1, count: 3, me_voted: true }, { id: 2, count: 1, me_voted: false }] } } });
    history(DMS[1].id, 30, '2026-10-01T12:00:00Z', '2026-11-21T09:00:00Z');
    history(DMS[3].id, 12, '2026-10-01T12:00:00Z', '2026-11-21T09:00:00Z');
    history(DMS[4].id, 8, '2026-10-01T12:00:00Z', '2026-11-21T09:00:00Z');
    for (const list of Object.values(msgs)) list.sort((a, b) => cmp(a.id, b.id));
    // Discord search lags a little behind: the newest message of each channel isn't indexed yet.
    for (const list of Object.values(msgs)) if (list.length) unindexed.add(list[list.length - 1].id);

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
      if (path === '/users/@me/guilds') return json(200, GUILDS);
      if (path === '/users/@me/channels' && method === 'GET') return json(200, DMS);
      if (path === '/users/@me/channels' && method === 'POST') {
        const uid = (body.recipients || [])[0];
        let c = Object.values(ch).find((x) => x.type === 1 && x.recipients[0].id === uid);
        if (!c) { c = add({ id: sf(Date.now()), type: 1, recipients: [{ id: uid, username: 'someone', avatar: null, discriminator: '0' }] }); msgs[c.id] = []; }
        return json(200, c);
      }
      if (path === '/users/@me/relationships') return json(200, FRIENDS.map((u) => ({ id: u.id, type: 1, user: u, nickname: null })));
      if (path === '/attachments/refresh-urls') return json(200, { refreshed_urls: body.attachment_urls.map((u) => ({ original: u, refreshed: u.replace(/ex=[0-9a-f]+/, 'ex=7fffffff') })) });
      if ((mm = /^\/guilds\/(\d+)\/channels$/.exec(path))) return json(200, Object.values(ch).filter((c) => c.guild_id === mm[1] && c.type !== 11 && c.type !== 12));
      if ((mm = /^\/guilds\/(\d+)\/roles$/.exec(path))) return json(200, ROLES[mm[1]] || []);
      if ((mm = /^\/guilds\/(\d+)$/.exec(path))) return json(200, { ...GUILDS.find((g) => g.id === mm[1]), roles: ROLES[mm[1]] || [] });
      if ((mm = /^\/guilds\/(\d+)\/members\/(\d+)$/.exec(path))) {
        const mem = (MEMBERS[mm[1]] || {})[mm[2]];
        return mem ? json(200, { ...mem, user: USERS[mm[2]] }) : err(404, 10007, 'Unknown Member');
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
          const users = r._users.map((id) => USERS[id] || { id, username: 'someone' });
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
        return opts.cdnFetch(url.toString());
      }
      throw new Error(`Mock: blocked request to ${url.hostname}`);
    }

    return { fetch: mockFetch, log, msgs, ch, ME, USERS, GUILDS, DMS, GENERAL, OFFTOPIC, ART, CHALLENGE, unindexed };
  }

  root.createDemoDiscord = createDemoDiscord;
})(typeof window !== 'undefined' ? window : globalThis);
