// Inventory of Claude Code extensions on disk: skills (skills/<name>/SKILL.md), subagents (agents/**/*.md)
// and slash commands (commands/**/*.md) from the user dir, claude.ai-synced skills, installed plugins and every
// project's .claude/ folder. Each entry gets a deterministic summary: frontmatter description + heading outline.
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, dirname, relative, resolve } from 'node:path';
import { projectOf, isExcluded, redact } from '../core/lib.mjs';

const META_KEYS = ['model', 'tools', 'allowed-tools', 'argument-hint', 'disable-model-invocation', 'user-invocable'];

// Minimal YAML frontmatter reader: `key: value`, quoted values, `>`/`|` blocks and `- item` lists.
export function parseFrontmatter(text) {
  text = String(text).replace(/^﻿/, '').replace(/\r\n/g, '\n');
  const m = text.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m) return { fm: {}, body: text };
  const fm = {};
  let key = null;
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([A-Za-z][\w-]*):\s*(.*)$/);
    if (kv) { key = kv[1]; const v = kv[2].trim(); fm[key] = /^[>|][+-]?$/.test(v) ? '' : v.replace(/^(['"])(.*)\1$/, '$2'); continue; }
    const t = line.trim();
    if (!key || !t || !/^\s/.test(line)) continue;
    fm[key] = t.startsWith('- ') ? (fm[key] ? `${fm[key]}, ` : '') + t.slice(2) : (fm[key] ? `${fm[key]} ` : '') + t;
  }
  return { fm, body: text.slice(m[0].length) };
}

// Headings (outside code fences) = what the file covers; first prose line = fallback description.
function outlineOf(body) {
  const heads = [];
  let prose = '', fence = false;
  for (const line of body.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) { fence = !fence; continue; }
    if (fence) continue;
    const h = line.match(/^#{1,3}\s+(.+?)\s*#*$/);
    if (h) heads.push(h[1].replace(/[*`]/g, ''));
    else if (!prose && line.trim() && !/^[|<>!-]/.test(line.trim())) prose = line.trim();
  }
  return { outline: heads.slice(0, 12).join(' · '), prose: prose.slice(0, 300) };
}

// Skills are often symlinks/junctions into a shared repo → follow links (Dirent.isDirectory() is false for them).
const isDir = (e, p) => e.isDirectory() || (e.isSymbolicLink() && (() => { try { return statSync(join(p, e.name)).isDirectory(); } catch { return false; } })());
const isFile = (e, p) => e.isFile() || (e.isSymbolicLink() && (() => { try { return statSync(join(p, e.name)).isFile(); } catch { return false; } })());
const subdirs = (p) => { try { return readdirSync(p, { withFileTypes: true }).filter((e) => isDir(e, p)).map((e) => e.name); } catch { return []; } };
function mdFiles(root) {
  const out = [];
  const walk = (p, depth) => {
    let ents; try { ents = readdirSync(p, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (isDir(e, p)) { if (depth < 3 && !e.name.startsWith('.')) walk(join(p, e.name), depth + 1); }
      else if (isFile(e, p) && e.name.endsWith('.md') && !/^readme\.md$/i.test(e.name)) out.push(join(p, e.name));
    }
  };
  walk(root, 0);
  return out;
}

function entry(kind, file, fallbackName, src) {
  const text = readFileSync(file, 'utf8');
  const { fm, body } = parseFrontmatter(text);
  const { outline, prose } = outlineOf(body);
  const meta = Object.fromEntries(META_KEYS.filter((k) => fm[k]).map((k) => [k, fm[k]]));
  if (src.plugin) meta.plugin = src.plugin;
  return {
    path: file, kind, name: (kind === 'command' ? fallbackName : fm.name || fallbackName), scope: src.scope, project: src.project ?? null,
    description: redact(fm.description || prose).slice(0, 1000), outline: redact(outline), meta: JSON.stringify(meta),
    content: redact(body.trim()).slice(0, 6000), size: text.length, mtime: statSync(file).mtimeMs,
  };
}

// One `.claude`-shaped folder (or plugin root): skills/, agents/, commands/.
function scanRoot(root, src, out) {
  const sk = join(root, 'skills');
  for (const d of subdirs(sk).filter((x) => x !== 'synced')) {
    const f = join(sk, d, 'SKILL.md');
    if (existsSync(f)) out.push(entry('skill', f, d, src));
  }
  for (const kind of ['agent', 'command']) {
    const base = join(root, `${kind}s`);
    for (const f of mdFiles(base)) out.push(entry(kind, f, relative(base, f).slice(0, -3).replace(/[\\/]/g, ':'), src));
  }
}

// Installed plugins: installed_plugins.json → { plugins: { "name@marketplace": [{ installPath }] } } (v2) or a single object.
function pluginRoots(claudeDir) {
  try {
    const j = JSON.parse(readFileSync(join(claudeDir, 'plugins', 'installed_plugins.json'), 'utf8'));
    return Object.entries(j.plugins ?? {}).flatMap(([id, v]) => [v].flat().filter((x) => x?.installPath).map((x) => ({ id: id.split('@')[0], path: x.installPath })));
  } catch { return []; }
}

export function scanExtensions(cfg, cwds) {
  const claudeDir = dirname(cfg.claudeProjectsDir);
  const out = [];
  const guard = (fn) => { try { fn(); } catch (e) { console.error('extensions:', e.message); } };
  guard(() => scanRoot(claudeDir, { scope: 'user' }, out));
  // claude.ai-synced skills: skills/synced/<bucket>/<skill>/SKILL.md
  for (const b of subdirs(join(claudeDir, 'skills', 'synced'))) guard(() => {
    const root = join(claudeDir, 'skills', 'synced', b);
    for (const d of subdirs(root)) { const f = join(root, d, 'SKILL.md'); if (existsSync(f)) out.push(entry('skill', f, d, { scope: 'synced' })); }
  });
  for (const p of pluginRoots(claudeDir)) guard(() => scanRoot(p.path, { scope: 'plugin', plugin: p.id }, out));
  const seen = new Set([resolve(claudeDir).toLowerCase()]);
  for (const cwd of cwds) {
    const root = resolve(cwd, '.claude');
    if (seen.has(root.toLowerCase()) || !existsSync(root)) continue;
    seen.add(root.toLowerCase());
    const project = projectOf(cwd, cfg);
    if (isExcluded(project, cfg)) continue;
    guard(() => scanRoot(root, { scope: 'project', project }, out));
  }
  return out;
}

export function ingestExtensions(db, cfg, cwds) {
  db.exec('DELETE FROM extensions');
  const ins = db.prepare('INSERT OR REPLACE INTO extensions VALUES (?,?,?,?,?,?,?,?,?,?,?)');
  for (const e of scanExtensions(cfg, cwds))
    ins.run(e.path, e.kind, e.name, e.scope, e.project, e.description, e.outline, e.meta, e.content, e.size, e.mtime);
}

// Extension usage carried by one transcript tool_use block: Skill → skill, Agent/Task → subagent type.
export function usageOfToolUse(b) {
  if (b.name === 'Skill' && b.input?.skill) return { kind: 'skill', name: String(b.input.skill) };
  if ((b.name === 'Agent' || b.name === 'Task') && b.input) return { kind: 'agent', name: String(b.input.subagent_type || 'general-purpose') };
  return null;
}
