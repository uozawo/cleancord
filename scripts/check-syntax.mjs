// Parses every extension script and validates manifest.json. Run with `npm run lint`.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as acorn from 'acorn';

const root = fileURLToPath(new URL('../extension/', import.meta.url));
const classicScripts = new Set(['background.js', 'content.js']);
let failed = 0;

const walk = (dir) => readdirSync(dir).flatMap((f) => {
  const p = join(dir, f);
  return statSync(p).isDirectory() ? walk(p) : [p];
});

for (const file of walk(root).filter((f) => f.endsWith('.js'))) {
  const rel = relative(root, file);
  try {
    acorn.parse(readFileSync(file, 'utf8'), { ecmaVersion: 'latest', sourceType: classicScripts.has(rel) ? 'script' : 'module' });
  } catch (e) {
    failed++;
    console.error(`✖ ${rel}: ${e.message}`);
  }
}

const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
const csp = manifest.content_security_policy?.extension_pages || '';
const checks = [
  [manifest.manifest_version === 3, 'manifest_version is 3'],
  [/^\d+\.\d+\.\d+$/.test(manifest.version), 'version is x.y.z'],
  [(manifest.description || '').length <= 132, 'description is at most 132 characters'],
  [/script-src 'self'(;|$)/.test(csp), "CSP keeps script-src 'self'"],
  [!/unsafe-eval/.test(csp), 'CSP has no unsafe-eval'],
  [/connect-src 'self' https:\/\/discord\.com https:\/\/\*\.discord\.com https:\/\/cdn\.discordapp\.com https:\/\/media\.discordapp\.net https:\/\/\*\.discordapp\.net;/.test(csp), 'CSP connect-src only allows Discord'],
  [!(manifest.host_permissions || []).some((h) => !/discord(app)?\.(com|net)\//.test(h)), 'host permissions are Discord-only'],
];
for (const [ok, label] of checks) {
  if (!ok) { failed++; console.error(`✖ manifest: ${label}`); }
}
if (failed) process.exit(1);
console.log('✔ syntax and manifest checks passed');
