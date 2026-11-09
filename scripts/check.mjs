// Syntax-check all source files and the dashboard script (no test framework needed).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const walk = (d) => readdirSync(d).flatMap((f) => { const p = join(d, f); return f === 'node_modules' ? [] : statSync(p).isDirectory() ? walk(p) : [p]; });
let bad = 0;
for (const f of walk(root).filter((p) => p.endsWith('.mjs'))) {
  const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
  if (r.status) { bad++; console.error(`✗ ${f}\n${r.stderr}`); }
}
const html = readFileSync(join(root, 'src', 'public', 'index.html'), 'utf8');
try { new Function(html.slice(html.indexOf('<script>') + 8, html.lastIndexOf('</script>'))); } catch (e) { bad++; console.error(`✗ index.html script: ${e.message}`); }
for (const f of ['src/config.example.json', 'package.json']) { try { JSON.parse(readFileSync(join(root, f), 'utf8')); } catch (e) { bad++; console.error(`✗ ${f}: ${e.message}`); } }
console.log(bad ? `${bad} lỗi` : '✓ check OK');
process.exit(bad ? 1 : 0);
