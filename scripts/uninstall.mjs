#!/usr/bin/env node
// Uninstall Personal Brain.
//
//   node scripts/uninstall.mjs [--dir <path>] [--purge] [--dry-run]
//
//   Removes the SessionEnd hook from ~/.claude/settings.json and the `brain` command.
//   Code files are removed; data (brain.db, config.json, secrets.json) is KEPT unless --purge.
//   cleanupPeriodDays is left unchanged.
import { existsSync, readFileSync, rmSync, writeFileSync, cpSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const DIR = resolve(opt('--dir', join(homedir(), '.personal-brain')).replace(/^~(?=$|[\\/])/, homedir()));
const PURGE = argv.includes('--purge'), DRY = argv.includes('--dry-run');
const info = (m) => console.log(`  ${m}`);
// only touch hooks that point at THIS install dir (another install / the real one must survive)
const norm = (p) => String(p ?? '').split('\\').join('/').toLowerCase();
const ours = (cmd) => norm(cmd).includes(`${norm(DIR)}/hook-sessionend.mjs`);
if (DRY) info('(dry-run: không thay đổi gì)');

// hook
const settingsPath = join(homedir(), '.claude', 'settings.json');
if (existsSync(settingsPath)) {
  const s = JSON.parse(readFileSync(settingsPath, 'utf8'));
  const groups = s.hooks?.SessionEnd;
  if (groups) {
    const kept = groups.map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h) => !ours(h.command)) })).filter((g) => g.hooks.length);
    if (kept.length !== groups.length || kept.some((g, i) => g.hooks.length !== groups[i]?.hooks?.length)) {
      if (kept.length) s.hooks.SessionEnd = kept; else delete s.hooks.SessionEnd;
      if (!DRY) { cpSync(settingsPath, `${settingsPath}.${Date.now()}.bak`); writeFileSync(settingsPath, JSON.stringify(s, null, 2) + '\n'); }
      info('đã gỡ hook SessionEnd khỏi ~/.claude/settings.json');
    }
  }
}

// shim
for (const p of [join(process.env.LOCALAPPDATA ?? '', 'Microsoft', 'WindowsApps', 'brain.cmd'), join(homedir(), '.local', 'bin', 'brain')]) {
  if (p && existsSync(p) && readFileSync(p, 'utf8').includes(DIR)) { if (!DRY) rmSync(p); info(`đã xoá ${p}`); }
}

// files
if (!existsSync(DIR)) info(`${DIR} không tồn tại`);
else if (PURGE) { if (!DRY) rmSync(DIR, { recursive: true, force: true }); info(`đã xoá toàn bộ ${DIR} (kể cả dữ liệu)`); }
else {
  const manifest = join(DIR, '.installed-files.json');
  const files = existsSync(manifest) ? JSON.parse(readFileSync(manifest, 'utf8')) : [];
  if (!DRY) {
    for (const f of [...files, 'package.json', 'package-lock.json', '.installed-files.json', 'version.json']) rmSync(join(DIR, f), { force: true });
    rmSync(join(DIR, 'node_modules'), { recursive: true, force: true });
    for (const d of ['public', 'runs']) if (existsSync(join(DIR, d)) && !readdirSync(join(DIR, d)).length) rmSync(join(DIR, d), { recursive: true });
  }
  info(`đã xoá code trong ${DIR}; giữ lại dữ liệu (brain.db, config.json, secrets.json). Dùng --purge để xoá hết.`);
}
console.log('✓ Gỡ cài đặt xong');
