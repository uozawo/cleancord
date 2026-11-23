// Minimal streaming ZIP writer (no third-party code). Entries are written one at a time; each
// is either stored or deflated with the browser's built-in CompressionStream. Sizes and CRCs go in
// data descriptors so nothing has to be buffered. ZIP64 records are added when the archive passes 4 GB,
// an entry passes 4 GB, or there are 65535+ entries.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(data, crc = 0) {
  let c = crc ^ 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const enc = new TextEncoder();
const MAX32 = 0xffffffff;

function dosTime(d) {
  return {
    time: ((d.getHours() & 31) << 11) | ((d.getMinutes() & 63) << 5) | (Math.floor(d.getSeconds() / 2) & 31),
    date: (((d.getFullYear() - 1980) & 127) << 9) | (((d.getMonth() + 1) & 15) << 5) | (d.getDate() & 31),
  };
}

export class ZipWriter {
  // out: async (Uint8Array) => void
  constructor(out) {
    this.out = out;
    this.offset = 0;
    this.entries = [];
    this.open = null;
    this.names = new Set();
  }

  async _emit(bytes) {
    this.offset += bytes.length;
    await this.out(bytes);
  }

  uniqueName(name) {
    if (!this.names.has(name)) return name;
    const dot = name.lastIndexOf('.');
    const slash = name.lastIndexOf('/');
    const base = dot > slash ? name.slice(0, dot) : name;
    const ext = dot > slash ? name.slice(dot) : '';
    let i = 2;
    while (this.names.has(`${base} (${i})${ext}`)) i++;
    return `${base} (${i})${ext}`;
  }

  has(name) { return this.names.has(name); }

  async entry(name, { compress = false, date = new Date() } = {}) {
    if (this.open) throw new Error('Previous ZIP entry still open');
    name = this.uniqueName(name);
    this.names.add(name);
    const nameBytes = enc.encode(name);
    const { time, date: dd } = dosTime(date);
    const method = compress ? 8 : 0;
    const header = new DataView(new ArrayBuffer(30));
    header.setUint32(0, 0x04034b50, true);
    header.setUint16(4, 20, true);
    header.setUint16(6, 0x0808, true); // data descriptor + UTF-8 names
    header.setUint16(8, method, true);
    header.setUint16(10, time, true);
    header.setUint16(12, dd, true);
    // crc / sizes = 0 (in data descriptor)
    header.setUint16(26, nameBytes.length, true);
    header.setUint16(28, 0, true);
    const e = { name, nameBytes, method, time, date: dd, offset: this.offset, crc: 0, csize: 0, usize: 0 };
    await this._emit(new Uint8Array(header.buffer));
    await this._emit(nameBytes);

    let comp = null, pump = null, writer = null;
    if (compress) {
      comp = new CompressionStream('deflate-raw');
      writer = comp.writable.getWriter();
      const reader = comp.readable.getReader();
      pump = (async () => {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          e.csize += value.length;
          await this._emit(value);
        }
      })();
      pump.catch(() => {}); // handled below; an output error must not leave writer.write() waiting forever
    }
    // Wait for a compressor write/close, but fail as soon as writing the output fails.
    const guarded = (p) => (pump ? Promise.race([p, pump.then(() => p)]) : p);
    const self = this;
    const handle = {
      async write(chunk) {
        const bytes = typeof chunk === 'string' ? enc.encode(chunk) : chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
        if (!bytes.length) return;
        e.crc = crc32(bytes, e.crc);
        e.usize += bytes.length;
        if (compress) await guarded(writer.write(bytes));
        else { e.csize += bytes.length; await self._emit(bytes); }
      },
      async close() {
        if (compress) { await guarded(writer.close()); await pump; }
        let dd;
        if (e.csize >= MAX32 || e.usize >= MAX32) { // ZIP64 data descriptor (8-byte sizes)
          dd = new DataView(new ArrayBuffer(24));
          dd.setBigUint64(8, BigInt(e.csize), true);
          dd.setBigUint64(16, BigInt(e.usize), true);
        } else {
          dd = new DataView(new ArrayBuffer(16));
          dd.setUint32(8, e.csize, true);
          dd.setUint32(12, e.usize, true);
        }
        dd.setUint32(0, 0x08074b50, true);
        dd.setUint32(4, e.crc, true);
        await self._emit(new Uint8Array(dd.buffer));
        self.entries.push(e);
        self.open = null;
      },
    };
    this.open = handle;
    return handle;
  }

  async addFile(name, data, opts) {
    const w = await this.entry(name, opts);
    await w.write(data);
    await w.close();
  }

  async finish() {
    if (this.open) await this.open.close();
    const cdStart = this.offset;
    for (const e of this.entries) {
      // ZIP64 extra field: holds every value whose 32-bit field is set to 0xFFFFFFFF, in the order
      // uncompressed size, compressed size, local header offset (APPNOTE 4.5.3). Set all three together.
      const zip64 = e.offset >= MAX32 || e.csize >= MAX32 || e.usize >= MAX32;
      const extra = zip64 ? new DataView(new ArrayBuffer(28)) : null;
      if (extra) {
        extra.setUint16(0, 0x0001, true);
        extra.setUint16(2, 24, true);
        extra.setBigUint64(4, BigInt(e.usize), true);
        extra.setBigUint64(12, BigInt(e.csize), true);
        extra.setBigUint64(20, BigInt(e.offset), true);
      }
      const cd = new DataView(new ArrayBuffer(46));
      cd.setUint32(0, 0x02014b50, true);
      cd.setUint16(4, (3 << 8) | 45, true); // made by: unix, v4.5
      cd.setUint16(6, zip64 ? 45 : 20, true);
      cd.setUint16(8, 0x0808, true);
      cd.setUint16(10, e.method, true);
      cd.setUint16(12, e.time, true);
      cd.setUint16(14, e.date, true);
      cd.setUint32(16, e.crc, true);
      cd.setUint32(20, zip64 ? MAX32 : e.csize, true);
      cd.setUint32(24, zip64 ? MAX32 : e.usize, true);
      cd.setUint16(28, e.nameBytes.length, true);
      cd.setUint16(30, extra ? extra.byteLength : 0, true);
      cd.setUint16(32, 0, true);
      cd.setUint16(34, 0, true);
      cd.setUint16(36, 0, true);
      cd.setUint32(38, (0o100644 << 16) >>> 0, true);
      cd.setUint32(42, zip64 ? MAX32 : e.offset, true);
      await this._emit(new Uint8Array(cd.buffer));
      await this._emit(e.nameBytes);
      if (extra) await this._emit(new Uint8Array(extra.buffer));
    }
    const cdEnd = this.offset;
    const cdSize = cdEnd - cdStart;
    const count = this.entries.length;
    const zip64 = cdStart >= MAX32 || cdEnd >= MAX32 || count >= 0xffff;
    if (zip64) {
      const z = new DataView(new ArrayBuffer(56));
      z.setUint32(0, 0x06064b50, true);
      z.setBigUint64(4, 44n, true);
      z.setUint16(12, 45, true);
      z.setUint16(14, 45, true);
      z.setUint32(16, 0, true);
      z.setUint32(20, 0, true);
      z.setBigUint64(24, BigInt(count), true);
      z.setBigUint64(32, BigInt(count), true);
      z.setBigUint64(40, BigInt(cdSize), true);
      z.setBigUint64(48, BigInt(cdStart), true);
      const z64Offset = this.offset;
      await this._emit(new Uint8Array(z.buffer));
      const loc = new DataView(new ArrayBuffer(20));
      loc.setUint32(0, 0x07064b50, true);
      loc.setUint32(4, 0, true);
      loc.setBigUint64(8, BigInt(z64Offset), true);
      loc.setUint32(16, 1, true);
      await this._emit(new Uint8Array(loc.buffer));
    }
    const eocd = new DataView(new ArrayBuffer(22));
    eocd.setUint32(0, 0x06054b50, true);
    eocd.setUint16(8, Math.min(count, 0xffff), true);
    eocd.setUint16(10, Math.min(count, 0xffff), true);
    eocd.setUint32(12, Math.min(cdSize, MAX32), true);
    eocd.setUint32(16, Math.min(cdStart, MAX32), true);
    await this._emit(new Uint8Array(eocd.buffer));
  }
}
