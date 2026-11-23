// Builds dist/cleancord-v<version>.zip (the folder to load in Chrome) and dist/SHA256SUMS.txt.
// Uses Cleancord's own ZIP writer (no dependencies). Output is reproducible: files are sorted and
// timestamps fixed (SOURCE_DATE_EPOCH if set, otherwise 2026-01-01).
import { readFileSync, readdirSync, statSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('..', import.meta.url));
const ext = join(repo, 'extension');
const { ZipWriter } = await import(new URL('../extension/src/export/zip.js', import.meta.url).href);
const { version } = JSON.parse(readFileSync(join(ext, 'manifest.json'), 'utf8'));
const date = new Date(process.env.SOURCE_DATE_EPOCH ? Number(process.env.SOURCE_DATE_EPOCH) * 1000 : Date.UTC(2026, 0, 1));
// ZIP stores local time; use a Date whose local fields equal the UTC ones so the output doesn't depend on the build machine's time zone.
const localDate = new Date(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds());

const walk = (dir) => readdirSync(dir).flatMap((f) => {
  const p = join(dir, f);
  return statSync(p).isDirectory() ? walk(p) : [p];
});
const files = walk(ext).map((p) => relative(ext, p).split(sep).join('/')).filter((p) => !p.split('/').some((s) => s.startsWith('.'))).sort();

// The folder inside the ZIP has no version in its name, so unzipping an update over the old one keeps the
// same path. Chrome ties unpacked extensions (and their saved data) to that path.
const folder = 'cleancord';
const parts = [];
const zip = new ZipWriter(async (b) => { parts.push(Buffer.from(b)); });
for (const f of files) {
  const data = readFileSync(join(ext, f));
  await zip.addFile(`${folder}/${f}`, new Uint8Array(data), { compress: !/\.(png|gif|jpe?g|webp)$/i.test(f), date: localDate });
}
await zip.finish();
const buf = Buffer.concat(parts);

mkdirSync(join(repo, 'dist'), { recursive: true });
const name = `cleancord-v${version}.zip`;
writeFileSync(join(repo, 'dist', name), buf);
const sum = createHash('sha256').update(buf).digest('hex');
writeFileSync(join(repo, 'dist', 'SHA256SUMS.txt'), `${sum}  ${name}\n`);
console.log(`✔ dist/${name} (${files.length} files, ${(buf.length / 1024).toFixed(0)} KB)\n  sha256 ${sum}`);
