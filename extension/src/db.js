// Workspaces: loaded conversations, jobs and caches kept in IndexedDB on this computer.

import { padId } from './util.js';

const VERSION = 1;
const STORES = ['conversations', 'messages', 'users', 'jobs', 'kv', 'pkgcache'];

export class StorageFullError extends Error {
  constructor() { super('Browser storage is full'); this.name = 'StorageFullError'; }
}

const req = (r) => new Promise((resolve, reject) => {
  r.onsuccess = () => resolve(r.result);
  r.onerror = () => reject(r.error);
});
const done = (tx) => new Promise((resolve, reject) => {
  tx.oncomplete = () => resolve();
  tx.onabort = () => reject(tx.error && tx.error.name === 'QuotaExceededError' ? new StorageFullError() : tx.error || new Error('Transaction aborted'));
  tx.onerror = () => {};
});

// Internal storage name kept from the project's earlier name so existing saved data stays readable.
export const dbName = (ws) => `scrubkit-ws-${encodeURIComponent(ws)}`;

// Folder handles (export jobs keep one in their params) can't be serialized: JSON would turn them into {}.
const noHandles = (k, v) => (typeof FileSystemHandle !== 'undefined' && v instanceof FileSystemHandle ? undefined : v);

export async function listWorkspaces() {
  const { workspaces, currentWorkspace } = await chrome.storage.local.get({ workspaces: ['Default'], currentWorkspace: 'Default' });
  return { workspaces: workspaces.length ? workspaces : ['Default'], current: currentWorkspace || 'Default' };
}
export async function saveWorkspaceList(workspaces, current) {
  await chrome.storage.local.set({ workspaces, currentWorkspace: current });
}
export function deleteWorkspaceDb(ws) {
  return req(indexedDB.deleteDatabase(dbName(ws))).catch(() => {});
}

export class Workspace {
  static async open(name) {
    const open = indexedDB.open(dbName(name), VERSION);
    open.onupgradeneeded = () => {
      const db = open.result;
      if (!db.objectStoreNames.contains('conversations')) db.createObjectStore('conversations', { keyPath: 'key' });
      if (!db.objectStoreNames.contains('messages')) db.createObjectStore('messages', { keyPath: ['conv', 'sid'] });
      if (!db.objectStoreNames.contains('users')) db.createObjectStore('users', { keyPath: 'key' });
      if (!db.objectStoreNames.contains('jobs')) db.createObjectStore('jobs', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv', { keyPath: 'k' });
      if (!db.objectStoreNames.contains('pkgcache')) db.createObjectStore('pkgcache', { keyPath: 'id' });
    };
    const db = await req(open);
    // Let another Cleancord tab delete this workspace instead of blocking it forever.
    db.onversionchange = () => db.close();
    return new Workspace(db, name);
  }

  constructor(db, name) {
    this.db = db;
    this.name = name;
  }

  close() { this.db.close(); }

  async _get(store, key) {
    return req(this.db.transaction(store).objectStore(store).get(key));
  }
  async _put(store, value) {
    const tx = this.db.transaction(store, 'readwrite');
    tx.objectStore(store).put(value);
    return done(tx);
  }
  async _delete(store, key) {
    const tx = this.db.transaction(store, 'readwrite');
    tx.objectStore(store).delete(key);
    return done(tx);
  }
  async _all(store) {
    return req(this.db.transaction(store).objectStore(store).getAll());
  }

  // ----- conversations -----
  getConv(key) { return this._get('conversations', key); }
  putConv(meta) { return this._put('conversations', { ...meta, updatedAt: Date.now() }); }
  listConvs() { return this._all('conversations'); }
  async deleteConv(key) {
    const tx = this.db.transaction(['conversations', 'messages'], 'readwrite');
    tx.objectStore('conversations').delete(key);
    tx.objectStore('messages').delete(IDBKeyRange.bound([key, ''], [key, '￿']));
    return done(tx);
  }

  // ----- messages -----
  async putMessages(conv, msgs) {
    if (!msgs.length) return;
    const tx = this.db.transaction('messages', 'readwrite');
    const st = tx.objectStore('messages');
    for (const m of msgs) st.put({ conv, sid: padId(m.id), m });
    return done(tx);
  }
  async deleteMessages(conv, ids) {
    if (!ids.length) return;
    const tx = this.db.transaction('messages', 'readwrite');
    const st = tx.objectStore('messages');
    for (const id of ids) st.delete([conv, padId(id)]);
    return done(tx);
  }
  countMessages(conv) {
    return req(this.db.transaction('messages').objectStore('messages').count(IDBKeyRange.bound([conv, ''], [conv, '￿'])));
  }
  async getMessages(conv) {
    const rows = await req(this.db.transaction('messages').objectStore('messages').getAll(IDBKeyRange.bound([conv, ''], [conv, '￿'])));
    return rows.map((r) => r.m);
  }
  // Oldest -> newest, in batches, without holding a transaction open between batches.
  async *iterate(conv, batch = 500) {
    let last = '';
    for (;;) {
      const range = IDBKeyRange.bound([conv, last], [conv, '￿'], true, false);
      const rows = await req(this.db.transaction('messages').objectStore('messages').getAll(range, batch));
      if (!rows.length) return;
      yield rows.map((r) => r.m);
      last = rows[rows.length - 1].sid;
      if (rows.length < batch) return;
    }
  }

  // ----- users / members cache -----
  getUser(key) { return this._get('users', key); }
  putUser(key, value) { return this._put('users', { key, value, at: Date.now() }); }

  // ----- jobs -----
  // A job's params (a bulk task's item list can be tens of MB) are written once, as kv 'jobparams:<id>';
  // the frequent checkpoints then only rewrite the small state record.
  async putJob(job, { withParams = true } = {}) {
    const { params, ...rec } = job;
    const tx = this.db.transaction(['jobs', 'kv'], 'readwrite');
    tx.objectStore('jobs').put(rec);
    if (withParams) tx.objectStore('kv').put({ k: `jobparams:${job.id}`, v: params ?? {} });
    return done(tx);
  }
  async _withParams(j) {
    if (j && j.params === undefined) j.params = await this.kvGet(`jobparams:${j.id}`, {}); // older records keep params inline
    return j;
  }
  async getJob(id) { return this._withParams(await this._get('jobs', id)); }
  async deleteJob(id) {
    const tx = this.db.transaction(['jobs', 'kv'], 'readwrite');
    tx.objectStore('jobs').delete(id);
    tx.objectStore('kv').delete(`jobparams:${id}`);
    return done(tx);
  }
  async listJobs() { return Promise.all((await this._all('jobs')).map((j) => this._withParams(j))); }

  // ----- key/value -----
  async kvGet(k, fallback = null) { const r = await this._get('kv', k); return r ? r.v : fallback; }
  kvSet(k, v) { return this._put('kv', { k, v }); }

  // ----- data-package lookups cache -----
  getPkgCache(id) { return this._get('pkgcache', id); }
  putPkgCache(id, value) { return this._put('pkgcache', { id, value, at: Date.now() }); }

  // ----- export / import (NDJSON, streamed) -----
  async exportTo(write) {
    await write(JSON.stringify({ cleancordWorkspace: 1, name: this.name, exportedAt: new Date().toISOString() }) + '\n');
    for (const store of STORES) {
      let lastKey = null;
      for (;;) {
        const range = lastKey === null ? null : IDBKeyRange.lowerBound(lastKey, true);
        const tx = this.db.transaction(store);
        const os = tx.objectStore(store);
        const [rows, keys] = await Promise.all([req(os.getAll(range, 500)), req(os.getAllKeys(range, 500))]);
        if (!rows.length) break;
        await write(rows.map((v) => JSON.stringify({ s: store, v }, noHandles)).join('\n') + '\n');
        lastKey = keys[keys.length - 1];
        if (rows.length < 500) break;
      }
    }
  }

  async importFrom(file, onProgress = () => {}) {
    const reader = file.stream().pipeThrough(new TextDecoderStream()).getReader();
    let buf = '';
    let first = true;
    let pending = [];
    let count = 0;
    const flush = async () => {
      if (!pending.length) return;
      const byStore = {};
      for (const { s, v } of pending) (byStore[s] ||= []).push(v);
      const names = Object.keys(byStore).filter((s) => STORES.includes(s));
      if (names.length) {
        const tx = this.db.transaction(names, 'readwrite');
        for (const s of names) for (const v of byStore[s]) tx.objectStore(s).put(v);
        await done(tx);
      }
      count += pending.length;
      pending = [];
      onProgress(count);
    };
    for (;;) {
      const { done: end, value } = await reader.read();
      if (value) buf += value;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        const obj = JSON.parse(line);
        if (first) {
          first = false;
          if (!obj.cleancordWorkspace && !obj.scrubkitWorkspace) throw new Error('This is not a Cleancord workspace file');
          continue;
        }
        pending.push(obj);
        if (pending.length >= 500) await flush();
      }
      if (end) break;
    }
    if (buf.trim()) pending.push(JSON.parse(buf));
    await flush();
    return count;
  }
}
