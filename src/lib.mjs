// Shared helpers: paths, config, DB schema, redaction, project naming.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

// App directory = install directory. Code, config.json, secrets.json and brain.db all live here.
export const HOME = dirname(fileURLToPath(import.meta.url));
export const DB_PATH = join(HOME, 'brain.db');
export const RUNS_DIR = join(HOME, 'runs'); // legacy: cwd of old `claude -p` runs → excluded from ingest

const DEFAULTS = {
  port: 4377,
  workspaceRoot: '~/workspace',
  claudeProjectsDir: '~/.claude/projects',
  projectDepth: { '*': 1 },
  aliases: [],
  exclude: ['(personal-brain)'],
  costUnits: { input: 1, output: 5, cacheRead: 0.1, cacheWrite5m: 1.25, cacheWrite1h: 2 },
  refreshMinutes: 10,
};
const PATH_KEYS = ['workspaceRoot', 'claudeProjectsDir'];
export const expandHome = (p) => (typeof p === 'string' && /^~(?=$|[\\/])/.test(p) ? homedir() + p.slice(1) : p);

// config.json (written by the installer from config.example.json) over built-in defaults; "~" expands to the user's home.
export function loadConfig() {
  const file = join(HOME, 'config.json');
  const user = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  const cfg = { ...DEFAULTS, ...user };
  for (const k of PATH_KEYS) cfg[k] = expandHome(cfg[k]);
  return cfg;
}

export function saveConfig(cfg) {
  writeFileSync(join(HOME, 'config.json'), JSON.stringify(cfg, null, 2) + '\n');
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS ingest_state (
  session_id TEXT PRIMARY KEY, signature TEXT NOT NULL, ingested_at INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY, project TEXT NOT NULL, cwd TEXT, title TEXT,
  started_at INTEGER, ended_at INTEGER, n_prompts INTEGER, n_turns INTEGER,
  cost_usd REAL, cost_source TEXT,            -- reported | estimated | none
  lines_added INTEGER, lines_removed INTEGER,
  tools TEXT, files_edited TEXT);            -- JSON
CREATE INDEX IF NOT EXISTS ix_sessions_project ON sessions(project, started_at);

CREATE TABLE IF NOT EXISTS prompts (
  session_id TEXT, ts INTEGER, project TEXT, text TEXT);
CREATE INDEX IF NOT EXISTS ix_prompts_project ON prompts(project, ts);

-- 1 row per API message (deduped by message id)
CREATE TABLE IF NOT EXISTS usage (
  msg_id TEXT PRIMARY KEY, session_id TEXT, project TEXT, ts INTEGER, day TEXT, model TEXT,
  input INTEGER, output INTEGER, cache_read INTEGER, cache_write INTEGER,
  units REAL, cost_usd REAL);
CREATE INDEX IF NOT EXISTS ix_usage_day ON usage(day);
CREATE INDEX IF NOT EXISTS ix_usage_session ON usage(session_id);

-- per-session per-model totals reported by Claude Code (cost-state)
CREATE TABLE IF NOT EXISTS model_cost (
  session_id TEXT, model TEXT, cost_usd REAL, input INTEGER, output INTEGER,
  cache_read INTEGER, cache_write INTEGER, PRIMARY KEY (session_id, model));

CREATE TABLE IF NOT EXISTS knowledge (
  path TEXT PRIMARY KEY, project TEXT, name TEXT, description TEXT, content TEXT, mtime INTEGER);

-- skills / agents / slash commands found on disk (user, synced, plugin, per-project .claude/); rebuilt every ingest
CREATE TABLE IF NOT EXISTS extensions (
  path TEXT PRIMARY KEY, kind TEXT, name TEXT, scope TEXT, project TEXT,
  description TEXT, outline TEXT, meta TEXT, content TEXT, size INTEGER, mtime INTEGER);

-- 1 row per skill call / subagent launch / slash command found in transcripts
CREATE TABLE IF NOT EXISTS ext_usage (
  session_id TEXT, project TEXT, ts INTEGER, kind TEXT, name TEXT);
CREATE INDEX IF NOT EXISTS ix_ext_usage_session ON ext_usage(session_id);
CREATE INDEX IF NOT EXISTS ix_ext_usage_name ON ext_usage(kind, name);

CREATE TABLE IF NOT EXISTS summaries (
  project TEXT PRIMARY KEY, generated_at INTEGER, model TEXT, content TEXT);

-- derived full-text index over sessions/prompts/knowledge/summaries (rebuilt by query.mjs rebuildSearchIndex)
CREATE VIRTUAL TABLE IF NOT EXISTS search_fts USING fts5(
  kind UNINDEXED, ref UNINDEXED, project UNINDEXED, ts UNINDEXED, title UNINDEXED, raw UNINDEXED, text,
  tokenize = 'unicode61 remove_diacritics 2');
`;

export function openDb() {
  mkdirSync(HOME, { recursive: true });
  const db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
  db.exec(SCHEMA);
  // migrations
  const cols = new Set(db.prepare('PRAGMA table_info(sessions)').all().map((c) => c.name));
  if (!cols.has('tool_errors')) db.exec('ALTER TABLE sessions ADD COLUMN tool_errors INTEGER');
  if (!cols.has('subagents')) db.exec('ALTER TABLE sessions ADD COLUMN subagents INTEGER');
  return db;
}

const SECRET_RE = /((?:api[_-]?key|token|password|passwd|secret|bearer)\s*[:=]?\s*["']?)[^\s"']{6,}/gi;
const KEY_RE = /\b(sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/g;
export function redact(text) {
  return String(text ?? '').replace(SECRET_RE, '$1***').replace(KEY_RE, '***');
}

const norm = (p) => String(p ?? '').replace(/\\/g, '/').replace(/\/+$/, '');

export function projectOf(cwd, cfg) {
  const p = norm(cwd);
  if (!p) return '(unknown)';
  if (p.toLowerCase().startsWith(norm(RUNS_DIR).toLowerCase())) return '(personal-brain)';
  for (const a of cfg.aliases ?? []) if (new RegExp(a.match, 'i').test(p)) return a.project;
  const root = norm(cfg.workspaceRoot);
  if (p.toLowerCase() === root.toLowerCase()) return '(workspace)';
  if (!p.toLowerCase().startsWith(root.toLowerCase() + '/')) return '(other) ' + p.split('/').slice(-1)[0];
  const segs = p.slice(root.length + 1).split('/');
  const depth = cfg.projectDepth?.[segs[0]] ?? cfg.projectDepth?.['*'] ?? 1;
  return segs.slice(0, depth).join('/');
}

export function isExcluded(project, cfg) {
  return (cfg.exclude ?? []).some((x) => project.startsWith(x));
}

export function localDay(ms) {
  const d = new Date(ms);
  const z = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`;
}
