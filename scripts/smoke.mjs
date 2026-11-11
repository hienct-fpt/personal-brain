#!/usr/bin/env node
// Smoke test: start src/server.mjs on a spare port (dev data in src/), hit every read API, check the CSRF guard, stop.
//
//   node scripts/smoke.mjs [--port <n>] [--keep]
//
//   --port <n>  port to use (default 4399; never the installed dashboard's 4377)
//   --keep      leave the server running after the checks (Ctrl+C to stop)
import { spawn, spawnSync } from 'node:child_process';
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
ok('status có app/pid/background', status.body?.app === 'personal-brain' && status.body?.pid === srv.pid && status.body?.background === false);

const usage = await getJson('/api/usage?days=30');
ok('GET /api/usage', usage.status === 200 && usage.body?.totals && Array.isArray(usage.body?.daily));

const ins = await getJson('/api/insights?days=30');
ok('GET /api/insights', ins.status === 200 && Array.isArray(ins.body?.tips) && ins.body.tips.every((t) => t.id && t.title && Array.isArray(t.items) && t.actions?.length),
  `${ins.body?.tips?.length ?? 0} gợi ý`);
const insAll = await getJson('/api/insights?days=0');
ok('GET /api/insights?days=0', insAll.status === 200 && Array.isArray(insAll.body?.tips));

const projects = await getJson('/api/projects');
ok('GET /api/projects', projects.status === 200 && Array.isArray(projects.body), `${projects.body?.length ?? 0} project`);

const name = projects.body?.[0]?.project;
if (name) {
  const p = await getJson(`/api/project?name=${encodeURIComponent(name)}`);
  ok('GET /api/project', p.status === 200 && Array.isArray(p.body?.sessions), name);
  const a = await getJson(`/api/activity?name=${encodeURIComponent(name)}`);
  ok('GET /api/activity', a.status === 200 && Array.isArray(a.body));
} else console.log('- bỏ qua /api/project, /api/activity (DB chưa có project — chạy `npm run ingest`)');

const ext = await getJson('/api/extensions?days=0');
ok('GET /api/extensions', ext.status === 200 && Array.isArray(ext.body?.items) && ext.body.items.every((x) => x.name && Array.isArray(x.kinds) && Array.isArray(x.copies)),
  `${ext.body?.items?.filter((x) => !x.builtin).length ?? 0} mục trên máy, ${ext.body?.events ?? 0} lượt dùng`);
const firstExt = ext.body?.items?.find((x) => x.path);
if (firstExt) {
  const one = await getJson(`/api/extension?path=${encodeURIComponent(firstExt.path)}`);
  ok('GET /api/extension', one.status === 200 && typeof one.body?.content === 'string', firstExt.name);
}
ok('GET /api/extension path lạ → 404', (await getJson('/api/extension?path=C%3A%2Fwindows%2Fwin.ini')).status === 404);

const kitApi = await getJson('/api/kit');
ok('GET /api/kit', kitApi.status === 200 && kitApi.body?.length >= 9 && kitApi.body.every((x) => x.name && x.kind && x.description && !('src' in x)), `${kitApi.body?.length ?? 0} mẫu`);

// brain kit CLI against a throwaway project dir: add all → files exist; re-add → same; modified copy survives remove.
{
  const { mkdtempSync, existsSync, appendFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const tmp = mkdtempSync(join(tmpdir(), 'pb-kit-'));
  const kit = (...a) => spawnSync(process.execPath, ['--no-warnings', join(root, 'src', 'kit.mjs'), ...a, '--dir', tmp], { encoding: 'utf8' });
  const dry = kit('add', 'all', '--dry-run');
  ok('brain kit --dry-run không ghi gì', dry.status === 0 && dry.stdout.includes('sẽ thêm') && !dry.stdout.includes('đã thêm') && !existsSync(join(tmp, '.claude')));
  const add = kit('add', 'all');
  const dot = join(tmp, '.claude');
  ok('brain kit add all', add.status === 0 && existsSync(join(dot, 'skills', 'brain-recall', 'SKILL.md')) && existsSync(join(dot, 'agents', 'code-reviewer.md')) && existsSync(join(dot, 'commands', 'recap.md')), add.stderr.trim());
  ok('brain kit add lần 2 → giống hệt', !kit('add', 'all').stdout.includes('đã thêm'));
  appendFileSync(join(dot, 'commands', 'recap.md'), '\nmine\n');
  const rm = kit('remove', 'all');
  ok('brain kit remove giữ file đã sửa', rm.status === 0 && existsSync(join(dot, 'commands', 'recap.md')) && !existsSync(join(dot, 'agents', 'code-reviewer.md')));
  ok('brain kit tên lạ → exit 1', kit('add', 'khong-co').status === 1);
  rmSync(tmp, { recursive: true, force: true });
}

const search = await getJson('/api/search?q=a');
ok('GET /api/search', search.status === 200 && Array.isArray(search.body?.sessions) && Array.isArray(search.body?.summaries));
const plain = await getJson('/api/search?q=dinh'), accented = await getJson('/api/search?q=%C4%91%E1%BB%8Bnh');
const sig = (b) => JSON.stringify(['sessions', 'prompts', 'knowledge', 'summaries'].map((k) => b?.[k]?.length));
ok('search không phân biệt dấu (dinh = định)', plain.status === 200 && sig(plain.body) === sig(accented.body), sig(plain.body));
ok('search ký tự đặc biệt không lỗi', (await getJson('/api/search?q=%22%20OR%20*%20(')).status === 200);

// MCP server over stdio: handshake, tool list, one call per tool, unknown method.
{
  const reqs = [
    { id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }, { method: 'notifications/initialized' },
    { id: 2, method: 'tools/list' },
    { id: 3, method: 'tools/call', params: { name: 'brain_search', arguments: { query: 'test', limit: 3 } } },
    { id: 4, method: 'tools/call', params: { name: 'brain_project', arguments: { name: name ?? 'x' } } },
    { id: 5, method: 'tools/call', params: { name: 'brain_recent', arguments: { days: 30 } } },
    { id: 6, method: 'nope' },
  ].map((m) => JSON.stringify({ jsonrpc: '2.0', ...m })).join('\n') + '\n';
  const r = spawnSync(process.execPath, ['--no-warnings', join(root, 'src', 'mcp.mjs')], { input: reqs, encoding: 'utf8', timeout: 20000 });
  const res = new Map(r.stdout.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)).map((o) => [o.id, o]));
  ok('MCP initialize', res.get(1)?.result?.serverInfo?.name === 'personal-brain', r.stderr.trim().slice(0, 200));
  ok('MCP tools/list = 3 tool chỉ đọc', res.get(2)?.result?.tools?.length === 3 && res.get(2).result.tools.every((t) => t.annotations?.readOnlyHint));
  ok('MCP gọi đủ 3 tool', [3, 4, 5].every((i) => typeof res.get(i)?.result?.content?.[0]?.text === 'string' && !res.get(i).result.isError));
  ok('MCP method lạ → -32601', res.get(6)?.error?.code === -32601);
  ok('MCP stdout chỉ có JSON-RPC', res.size === 6);
}

const settings = await getJson('/api/settings');
ok('GET /api/settings', settings.status === 200 && settings.body?.providers);
ok('settings không lộ API key', !JSON.stringify(settings.body ?? {}).match(/"(apiKey|key|dpapi)"\s*:/));

const csrf = await fetch(`${base}/api/refresh`, { method: 'POST' });
ok('POST thiếu x-brain → 403', csrf.status === 403);
const foreign = await fetch(`${base}/api/refresh`, { method: 'POST', headers: { 'x-brain': '1', origin: 'http://evil.example' } });
ok('POST Origin lạ → 403', foreign.status === 403);

const errors = log.split('\n').filter((l) => /error|lỗi|✗|^!/i.test(l));
ok('log server không có lỗi', !errors.length, errors.slice(0, 3).join(' | '));

// service.mjs (brain start/stop/status) against this port: stop our server, start it in the background, stop again.
if (!keep) {
  const svc = (...a) => spawnSync(process.execPath, ['--no-warnings', join(root, 'src', 'service.mjs'), ...a],
    { env: { ...process.env, BRAIN_PORT: String(port) }, encoding: 'utf8', timeout: 30000 });
  const alive = async () => { try { return (await fetch(`${base}/api/status`, { signal: AbortSignal.timeout(1000) })).ok; } catch { return false; } };
  ok('service status → đang chạy', svc('status').stdout.includes('Đang chạy'));
  const st = svc('stop');
  ok('service stop', st.status === 0 && !(await alive()), st.stderr.trim());
  const sa = svc('start');
  const bg = await getJson('/api/status').catch(() => ({}));
  ok('service start → chạy nền', sa.status === 0 && bg.body?.background === true, (sa.stderr || '').trim());
  const sb = svc('stop');
  ok('service stop (nền)', sb.status === 0 && !(await alive()), sb.stderr.trim());
  if (await alive()) svc('stop'); // never leave a background server behind on a failed check
}

console.log(fails ? `\n${fails} kiểm tra thất bại` : '\n✓ smoke OK');
if (keep && !fails) { console.log(`Server vẫn chạy ở ${base} (Ctrl+C để dừng)`); srv.stdout.pipe(process.stdout); srv.stderr.pipe(process.stderr); }
else { stop(); process.exit(fails ? 1 : 0); }
