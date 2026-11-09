#!/usr/bin/env node
// Run the dashboard server in the background.
//
//   node service.mjs start [--no-wait]   start hidden, log to server.log (no-op if already running)
//   node service.mjs stop                stop the server listening on the configured port
//   node service.mjs restart             stop + start (use after upgrading)
//   node service.mjs status              running? which version? autostart?
//   node service.mjs autostart on|off    start at Windows logon (HKCU\…\Run, no admin needed)
//
// Port = BRAIN_PORT env or config.json "port". The server reports its own pid in /api/status.
import { spawn, spawnSync } from 'node:child_process';
import { openSync, readFileSync, statSync, truncateSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, HOME } from './lib.mjs';

const WIN = process.platform === 'win32';
const port = Number(process.env.BRAIN_PORT ?? loadConfig().port);
const appUrl = `http://localhost:${port}`;
const LOG = join(HOME, 'server.log');
const SERVER = join(HOME, 'server.mjs');
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const RUN_NAME = 'PersonalBrain';

const log = (m) => console.log(m);
const fail = (m) => { console.error(`✗ ${m}`); process.exit(1); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// null = nothing listening; { foreign: true } = some other program on the port;
// { busy: true } = connected but no answer in time (server blocked, e.g. first ingest) → still running.
async function probe() {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/status`, { signal: AbortSignal.timeout(5000) });
    const j = await r.json();
    return j.app === 'personal-brain' || 'ingesting' in j ? j : { foreign: true }; // 'ingesting' = servers before v0.6.2
  } catch (e) {
    return e?.name === 'TimeoutError' || e?.name === 'AbortError' ? { busy: true } : null;
  }
}

function installedCommit() {
  try { return JSON.parse(readFileSync(join(HOME, 'version.json'), 'utf8')).commit ?? null; } catch { return null; }
}

// Servers before v0.6.2 don't report their pid: find node.exe running this install's server.mjs.
function legacyPid() {
  if (!WIN) return null;
  const ps = "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | ? { $_.CommandLine -like ('*' + $env:BRAIN_SRV + '*') } | % ProcessId";
  const r = spawnSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8', env: { ...process.env, BRAIN_SRV: SERVER }, windowsHide: true });
  const pids = (r.stdout ?? '').split(/\s+/).filter(Boolean).map(Number);
  return pids.length === 1 ? pids[0] : null;
}

async function waitFor(cond, ms = 10000) {
  for (let t = 0; t < ms; t += 250) { if (await cond()) return true; await sleep(250); }
  return false;
}

async function start({ wait = true } = {}) {
  const s = await probe();
  if (s?.foreign) fail(`Cổng ${port} đang bị chương trình khác dùng — đổi "port" trong config.json`);
  if (s) return log(`● Đã chạy rồi${s.pid ? ` (pid ${s.pid})` : s.busy ? ' (đang bận)' : ''} — ${appUrl}`);
  try { if (statSync(LOG).size > 5e6) truncateSync(LOG, 0); } catch {}
  const fd = openSync(LOG, 'a');
  const child = spawn(process.execPath, ['--no-warnings', SERVER], {
    cwd: HOME, detached: true, windowsHide: true, stdio: ['ignore', fd, fd], env: { ...process.env, BRAIN_BG: '1' },
  });
  child.unref();
  if (!wait) return log(`Đang khởi động nền — ${appUrl}`);
  let exited = false;
  child.on('exit', () => { exited = true; });
  const up = await waitFor(async () => exited || !!(await probe()));
  const s2 = await probe();
  if (!up || !s2) fail(`Server không lên — xem log: ${LOG}`);
  log(`✓ Đang chạy nền (pid ${s2.pid}) — ${appUrl}\n  log: ${LOG}`);
}

async function stop() {
  const s = await probe();
  if (!s) return log('○ Server không chạy');
  if (s.foreign) fail(`Cổng ${port} là chương trình khác, không phải Personal Brain — không tắt`);
  const pid = s.pid ?? legacyPid();
  if (!pid) fail('Không xác định được tiến trình server — tắt cửa sổ server bằng Ctrl+C');
  try { process.kill(pid); } catch (e) { fail(`Không tắt được pid ${pid}: ${e.message}`); }
  if (!(await waitFor(async () => !(await probe())))) fail('Server chưa tắt sau 10 giây');
  log(`✓ Đã tắt server (pid ${pid})`);
}

function autostartOn() {
  return WIN && spawnSync('reg', ['query', RUN_KEY, '/v', RUN_NAME], { windowsHide: true }).status === 0;
}

function autostart(mode) {
  if (!WIN) fail('Tự chạy khi đăng nhập hiện chỉ hỗ trợ Windows');
  if (mode === 'on') {
    const cmd = `"${process.execPath}" --no-warnings "${join(HOME, 'service.mjs')}" start --no-wait`;
    const r = spawnSync('reg', ['add', RUN_KEY, '/v', RUN_NAME, '/t', 'REG_SZ', '/d', cmd, '/f'], { encoding: 'utf8', windowsHide: true });
    if (r.status !== 0) fail(`Không ghi được registry: ${r.stderr || r.stdout}`);
    log('✓ Đã bật tự chạy khi đăng nhập Windows (có thể thấy cửa sổ đen loé lên ~1 giây)');
  } else if (mode === 'off') {
    if (autostartOn()) spawnSync('reg', ['delete', RUN_KEY, '/v', RUN_NAME, '/f'], { windowsHide: true });
    log('✓ Đã tắt tự chạy khi đăng nhập');
  } else log(`Tự chạy khi đăng nhập: ${autostartOn() ? 'bật' : 'tắt'}  (brain autostart on|off)`);
}

async function status() {
  const s = await probe(), inst = installedCommit();
  if (!s) log(`○ Không chạy — gõ \`brain start\``);
  else if (s.foreign) log(`✗ Cổng ${port} đang bị chương trình khác dùng`);
  else if (s.busy) log(`● Đang chạy nhưng đang bận (thường là đang đọc transcript) — thử lại sau · ${appUrl}`);
  else {
    log(`● Đang chạy ${s.background ? 'nền' : 'trong cửa sổ terminal'}${s.pid ? ` · pid ${s.pid}` : ''} · ${appUrl}`);
    log(`  bản đang chạy: ${s.version ?? (s.app ? 'dev' : '(cũ, không rõ)')} · bản đã cài: ${inst ?? '?'}`);
    if (inst && s.version !== inst) log('  ⚠ Server đang chạy bản cũ — gõ `brain restart`');
  }
  if (WIN) log(`  tự chạy khi đăng nhập: ${autostartOn() ? 'bật' : 'tắt'}`);
}

const [cmd, arg] = process.argv.slice(2);
if (cmd === 'start') await start({ wait: arg !== '--no-wait' });
else if (cmd === 'stop') await stop();
else if (cmd === 'restart') { await stop(); await start(); }
else if (cmd === 'status') await status();
else if (cmd === 'autostart') autostart(arg);
else fail('Dùng: start | stop | restart | status | autostart on|off');
