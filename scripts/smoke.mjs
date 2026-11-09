#!/usr/bin/env node
// Smoke test: start src/server.mjs on a spare port (dev data in src/), hit every read API, check the CSRF guard, stop.
//
//   node scripts/smoke.mjs [--port <n>] [--keep]
//
//   --port <n>  port to use (default 4399; never the installed dashboard's 4377)
//   --keep      leave the server running after the checks (Ctrl+C to stop)
import { spawn } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const i = argv.indexOf('--port');
const port = Number(i >= 0 ? argv[i + 1] : 4399);
const keep = argv.includes('--keep');
const base = `http://127.0.0.1:${port}`;

try { await fetch(`${base}/api/status`, { signal: AbortSignal.timeout(500) }); console.error(`✗ Cổng ${port} đang bận — dùng --port <n>`); process.exit(1); } catch {}

const srv = spawn(process.execPath, ['--no-warnings', join(root, 'src', 'server.mjs')], {
  env: { ...process.env, BRAIN_PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
srv.stdout.on('data', (d) => { log += d; });
srv.stderr.on('data', (d) => { log += d; });
const stop = () => { if (!srv.killed) srv.kill(); };
process.on('exit', stop);

let fails = 0;
const ok = (name, cond, extra = '') => { console.log(`${cond ? '✓' : '✗'} ${name}${extra ? ` — ${extra}` : ''}`); if (!cond) fails++; };
const getJson = async (p) => { const r = await fetch(base + p); return { status: r.status, body: await r.json().catch(() => null) }; };

// wait for the server (first ingest of a fresh dev DB can take ~1 min, but the server listens before ingesting)
let up = false;
for (let t = 0; t < 60 && !up; t++) {
  try { up = (await fetch(`${base}/api/status`)).ok; } catch { await new Promise((r) => setTimeout(r, 1000)); }
}
if (!up) { console.error(`✗ Server không lên sau 60 giây\n${log}`); process.exit(1); }

const html = await (await fetch(base + '/')).text();
ok('GET /', html.includes('<script>'));

const status = await getJson('/api/status');
ok('GET /api/status', status.status === 200 && 'ingesting' in (status.body ?? {}));

const usage = await getJson('/api/usage?days=30');
ok('GET /api/usage', usage.status === 200 && usage.body?.totals && Array.isArray(usage.body?.daily));

const projects = await getJson('/api/projects');
ok('GET /api/projects', projects.status === 200 && Array.isArray(projects.body), `${projects.body?.length ?? 0} project`);

const name = projects.body?.[0]?.project;
if (name) {
  const p = await getJson(`/api/project?name=${encodeURIComponent(name)}`);
  ok('GET /api/project', p.status === 200 && Array.isArray(p.body?.sessions), name);
  const a = await getJson(`/api/activity?name=${encodeURIComponent(name)}`);
  ok('GET /api/activity', a.status === 200 && Array.isArray(a.body));
} else console.log('- bỏ qua /api/project, /api/activity (DB chưa có project — chạy `npm run ingest`)');

const search = await getJson('/api/search?q=a');
ok('GET /api/search', search.status === 200 && Array.isArray(search.body?.sessions));

const settings = await getJson('/api/settings');
ok('GET /api/settings', settings.status === 200 && settings.body?.providers);
ok('settings không lộ API key', !JSON.stringify(settings.body ?? {}).match(/"(apiKey|key|dpapi)"\s*:/));

const csrf = await fetch(`${base}/api/refresh`, { method: 'POST' });
ok('POST thiếu x-brain → 403', csrf.status === 403);
const foreign = await fetch(`${base}/api/refresh`, { method: 'POST', headers: { 'x-brain': '1', origin: 'http://evil.example' } });
ok('POST Origin lạ → 403', foreign.status === 403);

const errors = log.split('\n').filter((l) => /error|lỗi|✗|^!/i.test(l));
ok('log server không có lỗi', !errors.length, errors.slice(0, 3).join(' | '));

console.log(fails ? `\n${fails} kiểm tra thất bại` : '\n✓ smoke OK');
if (keep && !fails) { console.log(`Server vẫn chạy ở ${base} (Ctrl+C để dừng)`); srv.stdout.pipe(process.stdout); srv.stderr.pipe(process.stderr); }
else { stop(); process.exit(fails ? 1 : 0); }
