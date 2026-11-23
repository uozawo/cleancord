// Reads Discord's official data package ("Request all of my data" ZIP) entirely offline.
// Folder names are matched by structure, so packages in any Discord language work.

import { ZipReader } from './zipreader.js';

const CHANNEL_FILE = /^(.*\/)?c?(\d{15,22})\/(messages\.json|messages\.csv|channel\.json)$/i;
const GUILD_FILE = /^(.*\/)?(\d{15,22})\/guild\.json$/i;

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else q = false;
      } else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function normalizeTs(ts) {
  if (!ts) return null;
  let s = String(ts).trim().replace(' ', 'T');
  if (!/[zZ]|[+-]\d\d:?\d\d$/.test(s)) s += 'Z';
  const d = new Date(s);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

// IDs written as JSON numbers lose precision in JSON.parse; turn them into strings first. A quoted key
// like "id" can't occur inside a JSON string (its quotes would be escaped), so this never touches content.
function protectIds(text) {
  return String(text)
    .replace(/("(?:id|ID|guild_id|channel_id|user_id)"\s*:\s*)(-?\d+)(?=\s*[,}\]])/g, '$1"$2"')
    .replace(/("recipients"\s*:\s*\[)([\d\s,]*)\]/g, (_, k, list) => `${k}${list.replace(/\d+/g, '"$&"')}]`);
}

function channelKind(info) {
  const t = typeof info.type === 'string' ? info.type.trim().toUpperCase() : info.type;
  if (t === 1 || t === '1' || t === 'DM') return 'dm';
  if (t === 3 || t === '3' || t === 'GROUP_DM') return 'group';
  if (info.guild || info.guildId) return 'guild';
  return 'other';
}

export class DataPackage {
  static async open(file, onProgress = () => {}) {
    const zip = await ZipReader.open(file);
    const pkg = new DataPackage(zip, file.name);
    await pkg._index(onProgress);
    return pkg;
  }

  constructor(zip, name) {
    this.zip = zip;
    this.name = name;
    this.channels = new Map();
    this.guilds = new Map();
    this.user = null;
  }

  async _readJson(name) {
    try { return JSON.parse(protectIds(await this.zip.text(name))); } catch { return null; }
  }

  async _index(onProgress) {
    const names = this.zip.names();
    const nameSet = new Set(names);
    let prefix = null;
    for (const n of names) {
      const m = CHANNEL_FILE.exec(n);
      if (!m) continue;
      const id = m[2];
      prefix ??= m[1] || '';
      const c = this.channels.get(id) || { id, dir: n.slice(0, n.lastIndexOf('/') + 1) };
      const f = m[3].toLowerCase();
      if (f === 'channel.json') c.channelFile = n;
      else c.messagesFile = n;
      this.channels.set(id, c);
    }
    if (!this.channels.size) throw new Error('No messages found. Is this a Discord data package ZIP?');

    // Channel names from the messages index.
    const indexName = names.find((n) => n === `${prefix}index.json`) || names.find((n) => /(^|\/)[^/]+\/index\.json$/i.test(n) && n.startsWith(prefix || ''));
    const index = indexName ? (await this._readJson(indexName)) || {} : {};

    // Servers index (maps guild id -> name).
    for (const n of names) {
      const m = GUILD_FILE.exec(n);
      if (!m) continue;
      const gIndex = nameSet.has(`${m[1] || ''}index.json`) ? `${m[1] || ''}index.json` : null;
      if (gIndex && !this._guildIndexLoaded) {
        const gi = (await this._readJson(gIndex)) || {};
        for (const [id, name] of Object.entries(gi)) this.guilds.set(id, { id, name: String(name || `Server ${id}`) });
        this._guildIndexLoaded = true;
      }
      if (!this.guilds.has(m[2])) this.guilds.set(m[2], { id: m[2], name: `Server ${m[2]}` });
    }

    // Account info.
    const userFile = names.filter((n) => /(^|\/)user\.json$/i.test(n)).sort((a, b) => a.length - b.length)[0];
    const u = userFile ? await this._readJson(userFile) : null;
    this.user = u && u.id
      ? { id: String(u.id), username: u.username || 'you', global_name: u.global_name || null, discriminator: u.discriminator != null ? String(u.discriminator).padStart(4, '0').replace(/^0000$/, '0') : '0', avatar: u.avatar_hash || u.avatar || null }
      : { id: '0', username: 'you', global_name: 'You', discriminator: '0', avatar: null };

    // channel.json files are tiny; read them all for names, types and servers.
    const list = [...this.channels.values()];
    let done = 0;
    const worker = async () => {
      while (list.length) {
        const c = list.pop();
        const info = c.channelFile ? (await this._readJson(c.channelFile)) || {} : {};
        c.type = info.type;
        c.name = info.name || null;
        c.guildId = info.guild ? String(info.guild.id) : null;
        if (info.guild && !this.guilds.has(c.guildId)) this.guilds.set(c.guildId, { id: c.guildId, name: info.guild.name || `Server ${c.guildId}` });
        if (info.guild && info.guild.name) this.guilds.get(c.guildId).name = info.guild.name;
        c.recipients = (info.recipients || []).map(String);
        c.label = index[c.id] || null;
        c.kind = channelKind({ type: info.type, guildId: c.guildId });
        const e = c.messagesFile ? this.zip.get(c.messagesFile) : null;
        c.size = e ? e.usize : 0;
        c.title = c.kind === 'guild'
          ? `#${c.name || c.label || c.id}`
          : c.label || c.name || (c.kind === 'dm' ? `DM ${c.id}` : `Channel ${c.id}`);
        done++;
        if (done % 50 === 0) onProgress(done, this.channels.size);
      }
    };
    await Promise.all(Array.from({ length: 12 }, worker));
    onProgress(this.channels.size, this.channels.size);
  }

  tree() {
    const dms = [];
    const groups = [];
    const servers = new Map();
    const other = [];
    for (const c of this.channels.values()) {
      if (!c.messagesFile) continue;
      if (c.kind === 'dm') dms.push(c);
      else if (c.kind === 'group') groups.push(c);
      else if (c.kind === 'guild') {
        const g = servers.get(c.guildId) || { ...(this.guilds.get(c.guildId) || { id: c.guildId, name: c.guildId }), channels: [] };
        g.channels.push(c);
        servers.set(c.guildId, g);
      } else other.push(c);
    }
    const bySize = (a, b) => b.size - a.size;
    return {
      dms: dms.sort(bySize), groups: groups.sort(bySize), other: other.sort(bySize),
      servers: [...servers.values()].map((g) => ({ ...g, channels: g.channels.sort(bySize) })).sort((a, b) => a.name.localeCompare(b.name)),
    };
  }

  async messages(channelId) {
    const c = this.channels.get(channelId);
    if (!c || !c.messagesFile) return [];
    let rows;
    if (/\.json$/i.test(c.messagesFile)) {
      let text = await this.zip.text(c.messagesFile);
      // Message IDs are stored as JSON numbers that are too big for JavaScript; keep them as strings.
      text = text.replace(/"ID"\s*:\s*(\d+)/g, '"ID":"$1"');
      rows = JSON.parse(text);
      if (!Array.isArray(rows)) rows = Array.isArray(rows && rows.messages) ? rows.messages : [];
    } else {
      const table = parseCsv(await this.zip.text(c.messagesFile));
      const head = (table.shift() || []).map((h) => h.trim());
      rows = table.filter((r) => r.length > 1).map((r) => Object.fromEntries(head.map((h, i) => [h, r[i]])));
    }
    return rows.map((r) => this._toMessage(r, c)).filter(Boolean);
  }

  _toMessage(r, c) {
    const id = String(r.ID ?? r.id ?? '').trim();
    if (!/^\d+$/.test(id)) return null;
    const attachments = String(r.Attachments || r.attachments || '').split(/\s+/).filter((u) => /^https?:\/\//.test(u)).map((url, i) => {
      let filename = 'attachment';
      try { filename = decodeURIComponent(new URL(url).pathname.split('/').pop()) || filename; } catch { /* keep default */ }
      return { id: `${id}${i}`, url, proxy_url: url, filename, size: 0 };
    });
    return {
      id,
      channel_id: c.id,
      guild_id: c.guildId || undefined,
      type: 0,
      timestamp: normalizeTs(r.Timestamp || r.timestamp),
      content: r.Contents ?? r.contents ?? '',
      attachments,
      embeds: [],
      mentions: [],
      reactions: [],
      author: this.user,
      _package: true,
    };
  }
}
