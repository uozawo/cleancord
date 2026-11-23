// Random-access ZIP reader for Discord data packages (which can be several GB). Reads only the
// central directory up front, then individual entries on demand. Decompression uses the browser's
// built-in DecompressionStream. ZIP64 supported.

const dec = new TextDecoder();
const strictUtf8 = new TextDecoder('utf-8', { fatal: true });

async function readBytes(file, start, length) {
  return new Uint8Array(await file.slice(start, start + length).arrayBuffer());
}

export class ZipReader {
  static async open(file) {
    const z = new ZipReader(file);
    await z._readDirectory();
    return z;
  }

  constructor(file) {
    this.file = file;
    this.entries = new Map(); // name -> entry
  }

  async _readDirectory() {
    const size = this.file.size;
    const tailLen = Math.min(size, 65557);
    const tail = await readBytes(this.file, size - tailLen, tailLen);
    const dv = new DataView(tail.buffer);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('Not a ZIP file (or it is damaged)');
    let cdSize = dv.getUint32(eocd + 12, true);
    let cdOffset = dv.getUint32(eocd + 16, true);
    // ZIP64?
    const locPos = eocd - 20;
    if (locPos >= 0 && dv.getUint32(locPos, true) === 0x07064b50) {
      const z64Offset = Number(dv.getBigUint64(locPos + 8, true));
      const z = new DataView((await readBytes(this.file, z64Offset, 56)).buffer);
      if (z.getUint32(0, true) === 0x06064b50) {
        cdSize = Number(z.getBigUint64(40, true));
        cdOffset = Number(z.getBigUint64(48, true));
      }
    }
    const cd = await readBytes(this.file, cdOffset, cdSize);
    const c = new DataView(cd.buffer);
    let p = 0;
    // Walk the whole directory rather than trusting the entry count: some writers store it modulo 65536.
    while (p + 46 <= cd.length) {
      if (c.getUint32(p, true) !== 0x02014b50) break;
      const flags = c.getUint16(p + 8, true);
      const method = c.getUint16(p + 10, true);
      let csize = c.getUint32(p + 20, true);
      let usize = c.getUint32(p + 24, true);
      const nlen = c.getUint16(p + 28, true);
      const xlen = c.getUint16(p + 30, true);
      const klen = c.getUint16(p + 32, true);
      let offset = c.getUint32(p + 42, true);
      const nameBytes = cd.subarray(p + 46, p + 46 + nlen);
      // Names are UTF-8 when flagged; unflagged names are usually UTF-8 too (localized folders), else CP437.
      let name = (flags & 0x800) ? dec.decode(nameBytes) : decodeLegacy(nameBytes);
      name = name.replace(/\\/g, '/').replace(/^\.?\//, '');
      // ZIP64 extra field
      let x = p + 46 + nlen;
      const xend = x + xlen;
      while (x + 4 <= xend) {
        const id = c.getUint16(x, true);
        const len = c.getUint16(x + 2, true);
        if (id === 0x0001) {
          let q = x + 4;
          if (usize === 0xffffffff) { usize = Number(c.getBigUint64(q, true)); q += 8; }
          if (csize === 0xffffffff) { csize = Number(c.getBigUint64(q, true)); q += 8; }
          if (offset === 0xffffffff) { offset = Number(c.getBigUint64(q, true)); q += 8; }
        }
        x += 4 + len;
      }
      if (!name.endsWith('/')) this.entries.set(name, { name, method, csize, usize, offset });
      p += 46 + nlen + xlen + klen;
    }
  }

  names() { return [...this.entries.keys()]; }
  get(name) { return this.entries.get(name); }

  async stream(name) {
    const e = typeof name === 'string' ? this.entries.get(name) : name;
    if (!e) throw new Error(`Missing file in ZIP: ${name}`);
    const lh = new DataView((await readBytes(this.file, e.offset, 30)).buffer);
    if (lh.getUint32(0, true) !== 0x04034b50) throw new Error(`Bad ZIP entry: ${e.name}`);
    const start = e.offset + 30 + lh.getUint16(26, true) + lh.getUint16(28, true);
    const raw = this.file.slice(start, start + e.csize).stream();
    if (e.method === 0) return raw;
    if (e.method === 8) return raw.pipeThrough(new DecompressionStream('deflate-raw'));
    throw new Error(`Unsupported compression (method ${e.method}) for ${e.name}`);
  }

  async text(name) {
    return new Response(await this.stream(name)).text();
  }

  async blob(name, type = '') {
    const buf = await new Response(await this.stream(name)).arrayBuffer();
    return new Blob([buf], { type });
  }
}

const CP437 = 'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ';
function decodeCp437(bytes) {
  let s = '';
  for (const b of bytes) s += b < 128 ? String.fromCharCode(b) : CP437[b - 128];
  return s;
}
function decodeLegacy(bytes) {
  try { return strictUtf8.decode(bytes); } catch { return decodeCp437(bytes); }
}
