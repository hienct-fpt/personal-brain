#!/usr/bin/env node
// Install / upgrade Personal Brain from this repository.
//
//   node scripts/install.mjs [options]        (or: install.cmd [options] on Windows)
//
//   --dir <path>        install directory (default: ~/.personal-brain)
//   --retention <days>  set Claude Code "cleanupPeriodDays" to at least this value (default 365, 0 = don't touch)
//   --no-hook           don't register the SessionEnd hook in ~/.claude/settings.json
//   --no-shim           don't put a `brain` command on PATH
//   --no-mcp            don't register the read-only MCP server "personal-brain" (needs the `claude` CLI)
//   --no-ingest         don't run the first ingest after installing
//   --dry-run           print what would happen, change nothing
//
// Upgrades are safe: only code files are replaced. config.json, secrets.json, brain.db and logs are never touched.
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, copyFileSync } from 'node:fs';
import { join, dirname, relative, resolve } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(REPO, 'src');
const WIN = process.platform === 'win32';
const RUNTIME_FILES = new Set(['config.json', 'secrets.json', 'brain.db', 'brain.db-wal', 'brain.db-shm', 'ingest-hook.log', 'server.log', 'version.json', '.installed-files.json']);

// ---------- args ----------
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
if (flag('--help') || flag('-h')) { console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 15).map((l) => l.replace(/^\/\/ ?/, '')).join('\n')); process.exit(0); }
const DIR = resolve(opt('--dir', join(homedir(), '.personal-brain')).replace(/^~(?=$|[\\/])/, homedir()));
const RETENTION = Number(opt('--retention', '365'));
const DRY = flag('--dry-run');

const step = (m) => console.log(`\n▶ ${m}`);
const info = (m) => console.log(`  ${m}`);
const fail = (m) => { console.error(`\n✗ ${m}`); process.exit(1); };
const fwd = (p) => p.replace(/\\/g, '/');

// ---------- 1. prerequisites ----------
step('Kiểm tra môi trường');
const [maj, min] = process.versions.node.split('.').map(Number);
if (maj < 22 || (maj === 22 && min < 5)) fail(`Cần Node.js >= 22.5 (đang dùng ${process.versions.node}). Tải tại https://nodejs.org`);
if (spawnSync(process.execPath, ['--no-warnings', '-e', "require('node:sqlite')"]).status !== 0) fail('Node.js này không có module node:sqlite');
info(`Node.js ${process.versions.node} ✓`);
const npm = WIN ? 'npm.cmd' : 'npm';
const npmCheck = spawnSync(npm, ['--version'], { encoding: 'utf8', shell: WIN });
if (npmCheck.status !== 0) fail('Không tìm thấy npm');
info(`npm ${npmCheck.stdout.trim()} ✓`);
info(`Thư mục cài: ${DIR}${existsSync(join(DIR, 'server.mjs')) ? '  (đã có — sẽ nâng cấp, giữ nguyên dữ liệu)' : ''}`);
if (DRY) info('(dry-run: không thay đổi gì)');

// ---------- 2. copy code ----------
step('Chép mã nguồn');
const walk = (d) => readdirSync(d).flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? walk(p) : [p]; });
const files = walk(SRC).map((p) => fwd(relative(SRC, p)))
  .filter((f) => !RUNTIME_FILES.has(f) && !f.startsWith('runs/') && !f.endsWith('.log') && !f.startsWith('node_modules/'));
const manifestPath = join(DIR, '.installed-files.json');
const previous = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : [];
if (!DRY) {
  mkdirSync(DIR, { recursive: true });
  for (const f of files) { mkdirSync(dirname(join(DIR, f)), { recursive: true }); copyFileSync(join(SRC, f), join(DIR, f)); }
  for (const f of ['package.json', 'package-lock.json']) copyFileSync(join(REPO, f), join(DIR, f));
  for (const f of previous) if (!files.includes(f) && !RUNTIME_FILES.has(f)) { rmSync(join(DIR, f), { force: true }); info(`xoá file cũ: ${f}`); }
  writeFileSync(manifestPath, JSON.stringify(files, null, 2));
}
info(`${files.length} file → ${DIR}`);

// ---------- 3. dependencies ----------
step('Cài dependency (npm ci)');
if (!DRY) {
  const r = spawnSync(npm, ['ci', '--omit=dev', '--no-audit', '--no-fund', '--loglevel=error'], { cwd: DIR, stdio: 'inherit', shell: WIN });
  if (r.status !== 0) fail('npm ci thất bại');
}
info('✓');

// ---------- 4. config + version ----------
step('Cấu hình');
if (existsSync(join(DIR, 'config.json'))) info('config.json đã có — giữ nguyên');
else { if (!DRY) copyFileSync(join(SRC, 'config.example.json'), join(DIR, 'config.json')); info('tạo config.json từ config.example.json (sửa workspaceRoot / projectDepth cho phù hợp)'); }
const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'));
let commit = null;
try { commit = execFileSync('git', ['-C', REPO, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch {}
let dirty = false;
try { dirty = !!execFileSync('git', ['-C', REPO, 'status', '--porcelain', '--', 'src', 'package.json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch {}
const version = { version: pkg.version, commit: commit ? commit + (dirty ? '-dirty' : '') : null, installedAt: new Date().toISOString(), source: REPO };
if (!DRY) writeFileSync(join(DIR, 'version.json'), JSON.stringify(version, null, 2) + '\n');
info(`phiên bản ${version.version}${version.commit ? ` (${version.commit})` : ''}`);

// ---------- 5. Claude Code settings: SessionEnd hook + transcript retention ----------
const settingsPath = join(homedir(), '.claude', 'settings.json');
const hookCmd = `node --no-warnings "${fwd(join(DIR, 'hook-sessionend.mjs'))}"`;
if (!flag('--no-hook') || RETENTION > 0) {
  step('Claude Code settings (~/.claude/settings.json)');
  let s = {};
  if (existsSync(settingsPath)) {
    try { s = JSON.parse(readFileSync(settingsPath, 'utf8')); }
    catch (e) { fail(`Không đọc được ${settingsPath} (JSON lỗi?): ${e.message}`); }
  }
  const before = JSON.stringify(s);
  if (!flag('--no-hook')) {
    s.hooks ??= {};
    // one Personal Brain hook per machine: replace any previous one (same or other install dir), keep everyone else's
    const isBrain = (h) => String(h.command ?? '').includes('hook-sessionend.mjs');
    for (const g of s.hooks.SessionEnd ?? []) for (const h of g.hooks ?? []) if (isBrain(h) && h.command !== hookCmd) info(`thay hook cũ: ${h.command}`);
    const groups = (s.hooks.SessionEnd ?? []).map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h) => !isBrain(h)) }))
      .filter((g) => g.hooks.length);
    groups.push({ hooks: [{ type: 'command', command: hookCmd, timeout: 10 }] });
    s.hooks.SessionEnd = groups;
    info(`hook SessionEnd → ${hookCmd}`);
  }
  if (RETENTION > 0) {
    const cur = s.cleanupPeriodDays ?? 30;
    if (cur < RETENTION) { s.cleanupPeriodDays = RETENTION; info(`cleanupPeriodDays: ${cur} → ${RETENTION}`); }
    else info(`cleanupPeriodDays = ${cur} (giữ nguyên)`);
  }
  if (JSON.stringify(s) === before) info('không thay đổi');
  else if (!DRY) {
    mkdirSync(dirname(settingsPath), { recursive: true });
    if (existsSync(settingsPath)) { const bak = `${settingsPath}.${Date.now()}.bak`; cpSync(settingsPath, bak); info(`backup: ${bak}`); }
    writeFileSync(settingsPath, JSON.stringify(s, null, 2) + '\n');
  }
}

// ---------- 5b. MCP server (user scope): Claude Code can query brain.db from any project ----------
if (!flag('--no-mcp')) {
  step('MCP server personal-brain (claude mcp, scope user)');
  const mcpPath = fwd(join(DIR, 'mcp.mjs'));
  const claude = (...a) => spawnSync('claude', a, { encoding: 'utf8', shell: WIN, timeout: 60000 });
  if (claude('--version').status !== 0) info(`Không tìm thấy lệnh \`claude\` — bỏ qua. Đăng ký tay: claude mcp add --scope user personal-brain -- node --no-warnings "${mcpPath}"`);
  else if (DRY) info(`sẽ đăng ký → node ${mcpPath}`);
  else {
    claude('mcp', 'remove', 'personal-brain', '--scope', 'user'); // re-register: the install dir may have changed
    const r = claude('mcp', 'add', '--scope', 'user', 'personal-brain', '--', 'node', '--no-warnings', WIN ? `"${mcpPath}"` : mcpPath);
    info(r.status === 0 ? `đã đăng ký → node ${mcpPath} (tool: brain_search, brain_project, brain_recent, brain_profile)` : `⚠ đăng ký lỗi: ${(r.stderr || r.stdout).trim()}`);
  }
}

// ---------- 6. `brain` command on PATH ----------
if (!flag('--no-shim')) {
  step('Lệnh `brain`');
  if (WIN) {
    const apps = join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'Microsoft', 'WindowsApps');
    const onPath = (process.env.PATH ?? '').toLowerCase().split(';').some((p) => resolve(p || '.').toLowerCase() === apps.toLowerCase());
    if (existsSync(apps) && onPath) {
      if (!DRY) writeFileSync(join(apps, 'brain.cmd'), `@echo off\r\ncall "${join(DIR, 'brain.cmd')}" %*\r\n`);
      info(`${join(apps, 'brain.cmd')} → gõ \`brain\` ở bất kỳ terminal nào`);
    } else info(`Không tìm thấy thư mục WindowsApps trên PATH — chạy trực tiếp: "${join(DIR, 'brain.cmd')}"`);
  } else {
    const bin = join(homedir(), '.local', 'bin');
    if (!DRY) {
      mkdirSync(bin, { recursive: true });
      writeFileSync(join(bin, 'brain'), `#!/bin/sh\nD="${DIR}"\ncase "$1" in\n  ingest) exec node --no-warnings "$D/ingest.mjs" "$2";;\n  summarize) exec node --no-warnings "$D/summarize.mjs" "$2";;\n  version) exec cat "$D/version.json";;\n  kit) exec node --no-warnings "$D/kit.mjs" "$@";;\n  start|stop|restart|status|autostart) exec node --no-warnings "$D/service.mjs" "$@";;\n  *) exec node --no-warnings "$D/server.mjs" --open;;\nesac\n`, { mode: 0o755 });
    }
    info(`${join(bin, 'brain')} (cần ~/.local/bin trên PATH)`);
  }
}

// ---------- 7. first ingest ----------
if (!flag('--no-ingest') && !DRY) {
  step('Đọc transcript Claude Code lần đầu (có thể mất ~30 giây)');
  const r = spawnSync(process.execPath, ['--no-warnings', join(DIR, 'ingest.mjs')], { cwd: DIR, stdio: 'inherit' });
  if (r.status !== 0) info('⚠ ingest lỗi — có thể chạy lại bằng `brain ingest`');
}

// ---------- 8. running server? ----------
let running = null;
try {
  const port = JSON.parse(readFileSync(join(DIR, 'config.json'), 'utf8')).port ?? 4377;
  const r = await fetch(`http://127.0.0.1:${port}/api/status`, { signal: AbortSignal.timeout(1000) });
  if (r.ok) running = await r.json();
} catch {}
// A background server has no window to Ctrl+C → restart it ourselves.
if (running?.background && !DRY) {
  step('Khởi động lại server nền');
  spawnSync(process.execPath, ['--no-warnings', join(DIR, 'service.mjs'), 'restart'], { cwd: DIR, stdio: 'inherit' });
  running = null;
}

console.log(`\n✓ Cài đặt xong — Personal Brain ${version.version}${version.commit ? ` (${version.commit})` : ''}`);
if (running) console.log('  ⚠ Server đang chạy bản cũ — gõ `brain restart` để dùng bản mới.');
console.log('  Chạy dashboard: brain start (chạy nền) hoặc brain (trong cửa sổ này)  →  http://localhost:4377');
console.log('  Tự chạy khi đăng nhập Windows: brain autostart on');
console.log('  Tóm tắt AI: vào ⚙ Cài đặt để nhập API key (Claude, OpenAI, Gemini, Azure OpenAI, OpenAI-compatible).');
