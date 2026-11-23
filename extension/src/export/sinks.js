// Where export files go: a .zip on disk (streamed), a folder on disk (resumable), or an in-memory .zip download.

import { ZipWriter } from './zip.js';
import { downloadBlob } from '../util.js';

const enc = new TextEncoder();
const toBytes = (c) => (typeof c === 'string' ? enc.encode(c) : c instanceof Uint8Array ? c : new Uint8Array(c));

function concat(chunks, total) {
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

// Buffers small writes into ~4 MB blocks to keep the file system API fast.
class Buffered {
  constructor(write, size = 4 * 1024 * 1024) { this.writeFn = write; this.size = size; this.chunks = []; this.total = 0; }
  async write(bytes) {
    this.chunks.push(bytes);
    this.total += bytes.length;
    if (this.total >= this.size) await this.flush();
  }
  async flush() {
    if (!this.total) return;
    const block = this.chunks.length === 1 ? this.chunks[0] : concat(this.chunks, this.total);
    this.chunks = [];
    this.total = 0;
    await this.writeFn(block);
  }
}

export class ZipFileSink {
  static async pick(suggestedName) {
    const handle = await window.showSaveFilePicker({
      suggestedName,
      types: [{ description: 'ZIP archive', accept: { 'application/zip': ['.zip'] } }],
    });
    const writable = await handle.createWritable();
    return new ZipFileSink(writable, handle.name);
  }
  constructor(writable, name) {
    this.kind = 'zip';
    this.name = name;
    this.writable = writable;
    this.buf = new Buffered((b) => writable.write(b));
    this.zip = new ZipWriter((b) => this.buf.write(b));
  }
  async exists() { return false; }
  async file(path, { compress = false } = {}) {
    const e = await this.zip.entry(path, { compress });
    return { write: (c) => e.write(toBytes(c)), close: () => e.close() };
  }
  async finish() { await this.zip.finish(); await this.buf.flush(); await this.writable.close(); }
  async abort() { try { await this.writable.abort(); } catch { /* ignore */ } }
}

export class MemoryZipSink {
  constructor(name) {
    this.kind = 'zip';
    this.name = name;
    this.parts = [];
    this.buf = new Buffered(async (b) => { this.parts.push(b); }, 8 * 1024 * 1024);
    this.zip = new ZipWriter((b) => this.buf.write(b));
  }
  async exists() { return false; }
  async file(path, { compress = false } = {}) {
    const e = await this.zip.entry(path, { compress });
    return { write: (c) => e.write(toBytes(c)), close: () => e.close() };
  }
  async finish() {
    await this.zip.finish();
    await this.buf.flush();
    const blob = new Blob(this.parts, { type: 'application/zip' });
    this.parts = [];
    downloadBlob(blob, this.name);
    return blob;
  }
  async abort() { this.parts = []; }
}

export class FolderSink {
  static async pick() {
    const dir = await window.showDirectoryPicker({ mode: 'readwrite', id: 'cleancord-export' });
    return dir;
  }
  constructor(dirHandle) {
    this.kind = 'folder';
    this.root = dirHandle;
    this.dirs = new Map();
  }
  async _dir(parts) {
    let key = '';
    let dir = this.root;
    for (const p of parts) {
      key += '/' + p;
      if (this.dirs.has(key)) { dir = this.dirs.get(key); continue; }
      dir = await dir.getDirectoryHandle(p, { create: true });
      this.dirs.set(key, dir);
    }
    return dir;
  }
  async exists(path) {
    const parts = path.split('/');
    const name = parts.pop();
    try {
      const dir = await this._dir(parts);
      const fh = await dir.getFileHandle(name);
      const f = await fh.getFile();
      return f.size > 0;
    } catch { return false; }
  }
  async file(path) {
    const parts = path.split('/');
    const name = parts.pop();
    const dir = await this._dir(parts);
    const fh = await dir.getFileHandle(name, { create: true });
    const writable = await fh.createWritable({ keepExistingData: false });
    const buf = new Buffered((b) => writable.write(b), 2 * 1024 * 1024);
    return {
      write: (c) => buf.write(toBytes(c)),
      close: async () => { await buf.flush(); await writable.close(); },
      // Discards the file (nothing is committed to disk), e.g. after a failed download.
      abort: async () => {
        try { await writable.abort(); } catch { /* ignore */ }
        try { if ((await fh.getFile()).size === 0) await dir.removeEntry(name); } catch { /* ignore */ }
      },
    };
  }
  async finish() {}
  async abort() {}
}

export const canPickFiles = () => typeof window.showSaveFilePicker === 'function';
export const canPickFolders = () => typeof window.showDirectoryPicker === 'function';
