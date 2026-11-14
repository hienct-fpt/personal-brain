#!/usr/bin/env node
// Smoke test: start src/server.mjs on a spare port (dev data in src/), hit every read API, check the CSRF guard, stop.
//
//   node scripts/smoke.mjs [--port <n>] [--keep]
//
//   --port <n>  port to use (default 4399; never the installed dashboard's 4377)
//   --keep      leave the server running after the checks (Ctrl+C to stop)
import { spawn, spawnSync } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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
let exited = null;
srv.on('exit', (code, sig) => { exited = `${code ?? ''}${sig ? ` ${sig}` : ''}`; });
// The server ingests synchronously on start, blocking its event loop; a keep-alive socket it closes meanwhile can
// reset the next request that reuses it (ECONNRESET). That is a client-side race, not a server failure: retry once
// while the server is still alive. Anything else (or a second failure) aborts with the server log.
const getJson = async (p, retried = false) => {
  try { const r = await fetch(base + p); return { status: r.status, body: await r.json().catch(() => null) }; }
  catch (e) {
    const code = e.cause?.code ?? e.message;
    if (!retried && exited == null && code === 'ECONNRESET') { console.log(`- GET ${p} → ECONNRESET (server vẫn chạy), thử lại`); return getJson(p, true); }
    console.error(`✗ GET ${p} → ${code}${exited != null ? ` (server đã thoát: ${exited})` : ''}
--- log server ---
${log.slice(-4000)}`); process.exit(1);
  }
};

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
ok('GET /api/usage', usage.status === 200 && usage.body?.totals && Array.isArray(usage.body?.daily) && Array.isArray(usage.body?.bySource));

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

// GitHub Copilot parsers against tiny synthetic fixtures (CLI events.jsonl + VS Code chat mutation log).
{
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { listCopilotSessions, parseCopilotCli, parseCopilotVscode } = await import('../src/ingest/copilot.mjs');
  const tmp = mkdtempSync(join(tmpdir(), 'pb-copilot-'));
  const cliDir = join(tmp, 'copilot', 'session-state', 's1');
  mkdirSync(cliDir, { recursive: true });
  const ev = (type, data, min) => JSON.stringify({ type, data, id: `${type}${min}`, timestamp: new Date(Date.UTC(2026, 0, 1, 0, min)).toISOString() });
  writeFileSync(join(cliDir, 'events.jsonl'), [
    ev('session.start', { context: { cwd: 'C:\\work\\demo' } }, 0),
    ev('user.message', { content: 'sửa lỗi token=abcdef123456' }, 1),
    ev('session.usage_record', { usage: { model: 'claude-sonnet-5.5', inputTokens: 1000, outputTokens: 50, cacheReadTokens: 900, cacheWriteTokens: 90,
      apiCallId: 'm1', copilotUsage: { totalNanoAiu: 2e9 } } }, 2),
    ev('assistant.message', {}, 2),
    ev('tool.execution_start', { toolName: 'edit', arguments: { path: 'C:\\work\\demo\\a.js' } }, 3),
    ev('tool.execution_complete', { success: false }, 3),
    ev('session.shutdown', { accountingSnapshot: { codeChanges: { linesAdded: 7, linesRemoved: 2 } } }, 4),
  ].join('\n'));
  const user = join(tmp, 'Code', 'User');
  const ws = join(user, 'workspaceStorage', 'h1');
  mkdirSync(join(ws, 'chatSessions'), { recursive: true });
  writeFileSync(join(ws, 'workspace.json'), JSON.stringify({ folder: pathToFileURL(join(tmp, 'demo-vs')).href }));
  writeFileSync(join(ws, 'chatSessions', 'c1.jsonl'), [
    { kind: 0, v: { creationDate: 1767225600000, requests: [] } },
    { kind: 2, k: ['requests'], v: [{ requestId: 'r1', timestamp: 1767225660000, modelId: 'copilot/gpt-5', message: { text: 'xin chào' }, response: [] }] },
    { kind: 2, k: ['requests', 0, 'response'], v: [{ kind: 'toolInvocationSerialized', toolId: 'copilot_readFile', isComplete: true }] },
    { kind: 2, k: ['requests', 0, 'response'], i: 0, v: [{ kind: 'textEditGroup', uri: { fsPath: '/x/b.ts' } }] },
    { kind: 1, k: ['requests', 0, 'promptTokens'], v: 500 },
    { kind: 1, k: ['requests', 0, 'copilotCredits'], v: 3 },
    { kind: 1, k: ['customTitle'], v: 'Chào' },
  ].map((x) => JSON.stringify(x)).join('\n'));
  const cfg = { copilotDir: join(tmp, 'copilot'), vscodeUserDirs: [user], costUnits: { input: 1, output: 5, cacheRead: 0.1, cacheWrite5m: 1.25, cacheWrite1h: 2 } };
  const list = listCopilotSessions(cfg);
  ok('Copilot: liệt kê CLI + VS Code', list.length === 2 && list.some((x) => x.id === 'copilot-cli:s1') && list.some((x) => x.id === 'vscode:c1'), list.map((x) => x.id).join(','));
  const cli = await parseCopilotCli(list.find((x) => x.kind === 'cli'), cfg);
  const m = [...cli.msgs.values()][0];
  ok('Copilot CLI: prompt đã redact, token, chi phí, file, dòng code', cli.cwd === 'C:\\work\\demo' && cli.prompts[0]?.text.includes('***') && !cli.prompts[0].text.includes('abcdef')
    && m?.input === 10 && m.cache_read === 900 && Math.abs(m.cost - 0.02) < 1e-9 && m.model === 'copilot/claude-sonnet-5.5'
    && cli.files.has('C:/work/demo/a.js') && cli.toolErrors === 1 && cli.lines?.added === 7, JSON.stringify(m));
  const vs = parseCopilotVscode(list.find((x) => x.kind === 'vscode'), cfg);
  const v = [...vs.msgs.values()][0];
  ok('Copilot VS Code: replay mutation log', vs.customTitle === 'Chào' && vs.prompts[0]?.text === 'xin chào' && vs.files.has('/x/b.ts')
    && !vs.tools.copilot_readFile && v?.input === 500 && Math.abs(v.cost - 0.03) < 1e-9 && vs.cwd === join(tmp, 'demo-vs'), JSON.stringify({ t: vs.tools, cwd: vs.cwd }));
  rmSync(tmp, { recursive: true, force: true });
}

const search = await getJson('/api/search?q=a');
ok('GET /api/search', search.status === 200 && Array.isArray(search.body?.sessions) && Array.isArray(search.body?.summaries));
const plain = await getJson('/api/search?q=dinh'), accented = await getJson('/api/search?q=%C4%91%E1%BB%8Bnh');
const sig = (b) => JSON.stringify(['sessions', 'prompts', 'knowledge', 'summaries'].map((k) => b?.[k]?.length));
ok('search không phân biệt dấu (dinh = định)', plain.status === 200 && sig(plain.body) === sig(accented.body), sig(plain.body));
ok('search ký tự đặc biệt không lỗi', (await getJson('/api/search?q=%22%20OR%20*%20(')).status === 200);
const prof = await getJson('/api/profile');
ok('GET /api/profile chỉ user/feedback, không lộ path', prof.status === 200 && Array.isArray(prof.body)
  && prof.body.every((k) => ['user', 'feedback'].includes(k.type) && !('path' in k)), prof.body?.length);

// MCP server over stdio: handshake, tool list, one call per tool, unknown method.
{
  const reqs = [
    { id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }, { method: 'notifications/initialized' },
    { id: 2, method: 'tools/list' },
    { id: 3, method: 'tools/call', params: { name: 'brain_search', arguments: { query: 'test', limit: 3 } } },
    { id: 4, method: 'tools/call', params: { name: 'brain_project', arguments: { name: name ?? 'x' } } },
    { id: 5, method: 'tools/call', params: { name: 'brain_recent', arguments: { days: 30 } } },
    { id: 6, method: 'nope' },
    { id: 7, method: 'tools/call', params: { name: 'brain_profile', arguments: {} } },
    // time window in the far future → nothing; reversed window / bad date → tool error (not a protocol error)
    { id: 8, method: 'tools/call', params: { name: 'brain_search', arguments: { query: 'a', since: '2999-01-01' } } },
    { id: 9, method: 'tools/call', params: { name: 'brain_search', arguments: { query: 'a', since: '2026-02-30' } } },
    { id: 10, method: 'tools/call', params: { name: 'brain_search', arguments: { query: 'a', since: '2026-05-02', until: '2026-05-01' } } },
    { id: 11, method: 'tools/call', params: { name: 'brain_search', arguments: { query: 'a', days: 30, until: '2999-12-31' } } },
    // time cue inside the query → window applied and cue removed from the keywords
    { id: 12, method: 'tools/call', params: { name: 'brain_search', arguments: { query: 'a tháng 1/2999' } } },
    { id: 13, method: 'tools/call', params: { name: 'brain_related', arguments: { entity: 'README.md' } } },
    { id: 14, method: 'tools/call', params: { name: 'brain_related', arguments: { entity: 'zzz-khong-co.xyz' } } },
  ].map((m) => JSON.stringify({ jsonrpc: '2.0', ...m })).join('\n') + '\n';
  const r = spawnSync(process.execPath, ['--no-warnings', join(root, 'src', 'mcp.mjs')], { input: reqs, encoding: 'utf8', timeout: 20000 });
  const res = new Map(r.stdout.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)).map((o) => [o.id, o]));
  const text = (i) => res.get(i)?.result?.content?.[0]?.text ?? '';
  ok('MCP initialize', res.get(1)?.result?.serverInfo?.name === 'personal-brain', r.stderr.trim().slice(0, 200));
  ok('MCP tools/list = 5 tool chỉ đọc', res.get(2)?.result?.tools?.length === 5 && res.get(2).result.tools.every((t) => t.annotations?.readOnlyHint));
  ok('MCP gọi đủ 5 tool', [3, 4, 5, 7, 11, 13, 14].every((i) => typeof res.get(i)?.result?.content?.[0]?.text === 'string' && !res.get(i).result.isError));
  ok('MCP brain_search since tương lai → không có kết quả', text(8).startsWith('Không tìm thấy') && text(8).includes('2999-01-01'), text(8).slice(0, 120));
  ok('MCP brain_search ngày sai / since > until → isError', res.get(9)?.result?.isError && res.get(10)?.result?.isError, `${text(9)} | ${text(10)}`);
  ok('MCP brain_search tự hiểu "tháng 1/2999"', text(12).includes('2999-01-01 → 2999-01-31') && text(12).includes('Không tìm thấy gì cho "a"'), text(12).slice(0, 160));
  ok('MCP brain_related trả kết quả / báo không thấy', text(13).length > 0 && text(14).startsWith('Không thấy'), `${text(13).slice(0, 80)} | ${text(14).slice(0, 80)}`);
  ok('MCP method lạ → -32601', res.get(6)?.error?.code === -32601);
  ok('MCP stdout chỉ có JSON-RPC', res.size === 14);
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
