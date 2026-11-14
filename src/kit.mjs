// Starter kit: sample skills / subagents / slash commands shipped in kit/, copied into a project's .claude/ on demand.
//
//   brain kit                                   list the kit (and what is already in the target)
//   brain kit add <name…|all> [options]         copy into <dir>/.claude (default: current directory)
//   brain kit remove <name…|all> [options]      delete from the target — only copies identical to the kit (unless --force)
//
//   --dir <path>   project directory (default: current directory)
//   --user         target ~/.claude instead (available in every project)
//   --force        add: overwrite a different existing copy · remove: delete even if modified
//   --dry-run      show what would happen, change nothing
import { readdirSync, readFileSync, existsSync, statSync, mkdirSync, cpSync, rmSync } from 'node:fs';
import { join, resolve, dirname, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { HOME, loadConfig } from './core/lib.mjs';
import { parseFrontmatter } from './ingest/extensions.mjs';

export const KIT_DIR = join(HOME, 'kit');
const KINDS = [['skill', 'skills'], ['agent', 'agents'], ['command', 'commands']];

// [{ kind, name, description, src, rel }] — rel = path under .claude/ (skills are whole folders).
export function listKit() {
  const out = [];
  for (const [kind, dir] of KINDS) {
    const base = join(KIT_DIR, dir);
    if (!existsSync(base)) continue;
    for (const f of readdirSync(base).sort()) {
      const src = join(base, f);
      const isSkill = kind === 'skill';
      const md = isSkill ? join(src, 'SKILL.md') : src;
      if (isSkill ? !existsSync(md) : !f.endsWith('.md')) continue;
      const { fm } = parseFrontmatter(readFileSync(md, 'utf8'));
      const name = isSkill ? f : f.slice(0, -3);
      out.push({ kind, name, description: fm.description ?? '', argumentHint: fm['argument-hint'] ?? '', model: fm.model ?? '', src, rel: `${dir}/${f}` });
    }
  }
  return out;
}

const filesOf = (p) => statSync(p).isDirectory() ? readdirSync(p).flatMap((f) => filesOf(join(p, f))) : [p];
// Every kit file exists in the target with identical content (line endings ignored).
function sameAs(src, dest) {
  if (!existsSync(dest)) return false;
  const norm = (p) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
  return filesOf(src).every((f) => { const d = join(dest, relative(src, f)); return existsSync(d) && statSync(d).isFile() && norm(f) === norm(d); });
}

export function targetDir({ dir, user } = {}) {
  return user ? dirname(loadConfig().claudeProjectsDir) : join(resolve(dir ?? process.cwd()), '.claude');
}

function pick(names) {
  const kit = listKit();
  if (names.includes('all')) return { items: kit, unknown: [] };
  const items = [], unknown = [];
  for (const n of names) {
    const [k, name] = n.includes(':') ? n.split(':') : [null, n]; // "agent:code-reviewer" disambiguates
    const hit = kit.filter((x) => x.name === name && (!k || x.kind === k));
    hit.length ? items.push(...hit) : unknown.push(n);
  }
  return { items, unknown };
}

// status: added | updated | same | exists (different copy, not overwritten)
export function addKit(names, { target, force = false, dryRun = false } = {}) {
  const { items, unknown } = pick(names);
  const results = items.map((x) => {
    const dest = join(target, x.rel);
    const status = !existsSync(dest) ? 'added' : sameAs(x.src, dest) ? 'same' : force ? 'updated' : 'exists';
    if (!dryRun && (status === 'added' || status === 'updated')) {
      mkdirSync(dirname(dest), { recursive: true });
      cpSync(x.src, dest, { recursive: true, force: true });
    }
    return { kind: x.kind, name: x.name, status, dest };
  });
  return { results, unknown };
}

// status: removed | missing | modified (kept)
export function removeKit(names, { target, force = false, dryRun = false } = {}) {
  const { items, unknown } = pick(names);
  const results = items.map((x) => {
    const dest = join(target, x.rel);
    const status = !existsSync(dest) ? 'missing' : sameAs(x.src, dest) || force ? 'removed' : 'modified';
    if (!dryRun && status === 'removed') rmSync(dest, { recursive: true, force: true });
    return { kind: x.kind, name: x.name, status, dest };
  });
  return { results, unknown };
}

// ---------- CLI ----------
const ICON = { skill: '🧩', agent: '🤖', command: '⌘' };
const LABEL = { added: '✓ đã thêm', updated: '✓ đã ghi đè', same: '= đã có (giống hệt)', exists: '! đã có bản khác — giữ nguyên (dùng --force để ghi đè)',
  removed: '✓ đã xoá', missing: '- không có', modified: '! đã bị sửa — giữ nguyên (dùng --force để xoá)' };

function main(argv) {
  if (argv[0] === 'kit') argv = argv.slice(1);
  const flag = (f) => argv.includes(f);
  const di = argv.indexOf('--dir');
  const dir = di >= 0 ? argv[di + 1] : undefined;
  if (di >= 0 && !dir) { console.error('Thiếu đường dẫn sau --dir'); return 1; }
  const [cmd, ...rest] = argv.filter((a, i) => !a.startsWith('--') && !(di >= 0 && i === di + 1));
  const target = targetDir({ dir, user: flag('--user') });
  const opts = { target, force: flag('--force'), dryRun: flag('--dry-run') };

  if (!cmd || cmd === 'list') {
    console.log(`Bộ mẫu Personal Brain — đích: ${target}\n`);
    for (const x of listKit()) {
      const here = existsSync(join(target, x.rel)) ? (sameAs(x.src, join(target, x.rel)) ? ' [đã cài]' : ' [có bản khác]') : '';
      const how = x.kind === 'command' ? `/${x.name}${x.argumentHint ? ` ${x.argumentHint}` : ''}` : x.name;
      console.log(`${ICON[x.kind]} ${x.kind.padEnd(7)} ${how}${here}\n            ${x.description.slice(0, 150)}${x.description.length > 150 ? '…' : ''}`);
    }
    console.log('\nCài: brain kit add <tên…|all> [--dir <project>] [--user] [--force] [--dry-run]');
    console.log('Gỡ:  brain kit remove <tên…|all> [--dir <project>] [--user]');
    return 0;
  }
  if (cmd !== 'add' && cmd !== 'remove') { console.error(`Lệnh không hợp lệ: ${cmd} (dùng list | add | remove)`); return 1; }
  if (!rest.length) { console.error(`Thiếu tên — ví dụ: brain kit ${cmd} code-reviewer recap, hoặc: brain kit ${cmd} all`); return 1; }
  if (!flag('--user') && dir && !existsSync(resolve(dir))) { console.error(`Không tìm thấy thư mục: ${resolve(dir)}`); return 1; }

  const { results, unknown } = (cmd === 'add' ? addKit : removeKit)(rest, opts);
  console.log(`${opts.dryRun ? '(dry-run) ' : ''}${cmd === 'add' ? 'Cài vào' : 'Gỡ khỏi'}: ${target}`);
  const DRY = { added: '→ sẽ thêm', updated: '→ sẽ ghi đè', removed: '→ sẽ xoá' };
  for (const r of results) console.log(`  ${ICON[r.kind]} ${r.kind.padEnd(7)} ${r.name.padEnd(20)} ${(opts.dryRun && DRY[r.status]) || LABEL[r.status]}`);
  for (const u of unknown) console.log(`  ✗ không có trong bộ mẫu: ${u}`);
  if (cmd === 'add' && !opts.dryRun && results.some((r) => r.status === 'added' || r.status === 'updated'))
    console.log('\nMở session Claude Code mới trong project để nạp skill/agent/command vừa cài. "brain-*" cần MCP server personal-brain.');
  return unknown.length ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main(process.argv.slice(2));
