// Ingest Claude Code transcripts into brain.db (incremental).
// Usage: node --no-warnings ingest.mjs [--full]
import { createReadStream, readdirSync, statSync, existsSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openDb, loadConfig, projectOf, isExcluded, redact, localDay, MEMORY_TYPES } from './lib.mjs';
import { rebuildSearchIndex } from './query.mjs';
import { ingestExtensions, usageOfToolUse } from './extensions.mjs';

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
// Bump to force a one-time full re-ingest when parseSession starts extracting new data from old transcripts.
const INGEST_VERSION = 1; // 1 = skill/agent/command usage (ext_usage)
const SKIP_PROMPT = /^(<local-command|<system-reminder|<task-notification|Caveat:|\[Request interrupted|<bash-|<user-memory)/;

function listSessions(projectsDir) {
  const out = [];
  for (const dir of readdirSync(projectsDir, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const d = join(projectsDir, dir.name);
    for (const f of readdirSync(d)) {
      if (!f.endsWith('.jsonl')) continue;
      const id = f.slice(0, -6);
      const files = [join(d, f)];
      const sub = join(d, id, 'subagents');
      if (existsSync(sub)) for (const s of readdirSync(sub)) if (s.endsWith('.jsonl')) files.push(join(sub, s));
      const signature = files.map((p) => { const st = statSync(p); return `${st.mtimeMs}:${st.size}`; }).join('|');
      out.push({ id, dir: dir.name, files, signature });
    }
  }
  return out;
}

async function* lines(file) {
  const rl = createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line || line.startsWith('{"type":"api-request')) continue;
    try { yield JSON.parse(line); } catch { /* partial line */ }
  }
}

function promptText(m) {
  if (m.isMeta || m.toolUseResult) return null;
  let c = m.message?.content;
  if (Array.isArray(c)) {
    if (c.some((b) => b.type === 'tool_result')) return null;
    c = c.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  }
  if (typeof c !== 'string' || !c.trim()) return null;
  const cmd = c.match(/<command-name>([^<]*)<\/command-name>[\s\S]*?(?:<command-args>([^<]*)<\/command-args>)?/);
  if (cmd) return `${cmd[1]} ${cmd[2] ?? ''}`.trim();
  if (SKIP_PROMPT.test(c.trim())) return null;
  return redact(c.trim()).slice(0, 1500);
}

async function parseSession(s, cfg) {
  const units = cfg.costUnits;
  const r = { cwd: null, title: null, customTitle: null, start: Infinity, end: 0, prompts: [], msgs: new Map(),
    tools: {}, ext: [], files: new Set(), costState: null, turns: 0, toolErrors: 0, subagents: s.files.length - 1 };
  for (const [i, file] of s.files.entries()) {
    const isMain = i === 0;
    for await (const m of lines(file)) {
      const ts = m.timestamp ? Date.parse(m.timestamp) : NaN;
      if (!Number.isNaN(ts)) { r.start = Math.min(r.start, ts); r.end = Math.max(r.end, ts); }
      if (!r.cwd && m.cwd) r.cwd = m.cwd;
      switch (m.type) {
        case 'ai-title': r.title = m.aiTitle; break;
        case 'custom-title': r.customTitle = m.customTitle; break;
        case 'cost-state': if (isMain) r.costState = m; break;
        case 'user': {
          const c = m.message?.content;
          if (Array.isArray(c)) for (const b of c) if (b.type === 'tool_result' && b.is_error) r.toolErrors++;
          if (!isMain || m.isSidechain) break;
          const raw = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b) => b.type === 'text').map((b) => b.text).join('\n') : '';
          const cmd = raw.match(/<command-name>\/?([^<\s]+)<\/command-name>/);
          if (cmd && !m.isMeta) r.ext.push({ ts, kind: 'command', name: cmd[1] });
          const t = promptText(m);
          if (t) r.prompts.push({ ts, text: t });
          break;
        }
        case 'assistant': {
          const msg = m.message ?? {};
          if (isMain && !m.isSidechain) r.turns++;
          for (const b of Array.isArray(msg.content) ? msg.content : []) {
            if (b.type !== 'tool_use') continue;
            r.tools[b.name] = (r.tools[b.name] ?? 0) + 1;
            const x = usageOfToolUse(b);
            if (x) r.ext.push({ ts, ...x });
            const fp = b.input?.file_path ?? b.input?.notebook_path;
            if (EDIT_TOOLS.has(b.name) && fp) r.files.add(String(fp).replace(/\\/g, '/'));
          }
          const u = msg.usage;
          if (!u || !msg.model || msg.model === '<synthetic>') break;
          const cw1h = u.cache_creation?.ephemeral_1h_input_tokens ?? 0;
          const cwAll = u.cache_creation_input_tokens ?? 0;
          const row = {
            id: msg.id ?? m.uuid, ts, model: msg.model,
            input: u.input_tokens ?? 0, output: u.output_tokens ?? 0,
            cache_read: u.cache_read_input_tokens ?? 0, cache_write: cwAll,
          };
          row.units = row.input * units.input + row.output * units.output + row.cache_read * units.cacheRead
            + cw1h * units.cacheWrite1h + (cwAll - cw1h) * units.cacheWrite5m;
          r.msgs.set(row.id, row); // streamed blocks repeat the same id → keep last
          break;
        }
      }
    }
  }
  return r;
}

function writeSession(db, s, r, cfg) {
  const project = projectOf(r.cwd, cfg);
  for (const t of ['sessions', 'prompts', 'usage', 'model_cost', 'ext_usage']) {
    db.prepare(`DELETE FROM ${t} WHERE ${t === 'sessions' ? 'id' : 'session_id'} = ?`).run(s.id);
  }
  if (isExcluded(project, cfg) || r.start === Infinity) return project;

  const msgs = [...r.msgs.values()];
  const reported = r.costState?.modelUsage ?? null;
  // Distribute each model's reported cost across its messages by token-units.
  if (reported) {
    for (const [model, mu] of Object.entries(reported)) {
      db.prepare('INSERT INTO model_cost VALUES (?,?,?,?,?,?,?)').run(s.id, model, mu.costUSD ?? 0,
        mu.inputTokens ?? 0, mu.outputTokens ?? 0, mu.cacheReadInputTokens ?? 0, mu.cacheCreationInputTokens ?? 0);
      const mine = msgs.filter((x) => x.model === model);
      const tot = mine.reduce((a, x) => a + x.units, 0);
      if (mine.length && tot > 0) for (const x of mine) x.cost = (mu.costUSD ?? 0) * (x.units / tot);
      else if ((mu.costUSD ?? 0) > 0) msgs.push({ // model used only internally (e.g. haiku helper)
        id: `${s.id}:${model}`, ts: r.end, model, input: mu.inputTokens ?? 0, output: mu.outputTokens ?? 0,
        cache_read: mu.cacheReadInputTokens ?? 0, cache_write: mu.cacheCreationInputTokens ?? 0, units: 0, cost: mu.costUSD });
    }
  }
  const ins = db.prepare('INSERT OR REPLACE INTO usage VALUES (?,?,?,?,?,?,?,?,?,?,?,?)');
  for (const x of msgs) {
    const ts = Number.isNaN(x.ts) ? r.end : x.ts;
    ins.run(x.id, s.id, project, ts, localDay(ts), x.model, x.input, x.output, x.cache_read, x.cache_write, x.units, x.cost ?? null);
  }
  const insP = db.prepare('INSERT INTO prompts VALUES (?,?,?,?)');
  for (const p of r.prompts) insP.run(s.id, Number.isNaN(p.ts) ? r.start : p.ts, project, p.text);
  const insX = db.prepare('INSERT INTO ext_usage VALUES (?,?,?,?,?)');
  for (const x of r.ext) insX.run(s.id, project, Number.isNaN(x.ts) ? r.start : x.ts, x.kind, x.name);

  db.prepare(`INSERT INTO sessions (id, project, cwd, title, started_at, ended_at, n_prompts, n_turns, cost_usd, cost_source,
    lines_added, lines_removed, tools, files_edited, tool_errors, subagents) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    s.id, project, r.cwd, r.customTitle ?? r.title ?? r.prompts[0]?.text.slice(0, 80) ?? null,
    r.start, r.end, r.prompts.length, r.turns,
    reported ? r.costState.totalCostUSD : null, reported ? 'reported' : 'none',
    r.costState?.totalLinesAdded ?? null, r.costState?.totalLinesRemoved ?? null,
    JSON.stringify(r.tools), JSON.stringify([...r.files]), r.toolErrors, r.subagents);
  return project;
}

// Sessions without cost-state: estimate with per-model $/unit learned from reported sessions.
function estimateMissingCosts(db) {
  const rates = new Map(db.prepare(`SELECT u.model, SUM(u.cost_usd)/SUM(u.units) rate FROM usage u
    JOIN sessions s ON s.id = u.session_id WHERE s.cost_source = 'reported' AND u.units > 0 GROUP BY u.model`).all().map((r) => [r.model, r.rate]));
  const fallback = Math.max(0, ...rates.values());
  const upd = db.prepare('UPDATE usage SET cost_usd = units * ? WHERE msg_id = ?');
  for (const u of db.prepare('SELECT msg_id, model FROM usage WHERE cost_usd IS NULL').all()) {
    upd.run(rates.get(u.model) ?? fallback, u.msg_id);
  }
  db.exec(`UPDATE sessions SET cost_usd = (SELECT COALESCE(SUM(cost_usd),0) FROM usage WHERE session_id = sessions.id),
    cost_source = 'estimated' WHERE cost_source = 'none'`);
}

// Claude Code auto-memory files (~/.claude/projects/<dir>/memory/*.md) = curated project knowledge.
function ingestKnowledge(db, cfg, dirCwd) {
  db.exec('DELETE FROM knowledge');
  const ins = db.prepare('INSERT OR REPLACE INTO knowledge (path, project, name, description, content, mtime, type) VALUES (?,?,?,?,?,?,?)');
  for (const dir of readdirSync(cfg.claudeProjectsDir)) {
    const md = join(cfg.claudeProjectsDir, dir, 'memory');
    if (!existsSync(md)) continue;
    const project = projectOf(dirCwd.get(dir), cfg);
    if (isExcluded(project, cfg)) continue;
    for (const f of readdirSync(md)) {
      if (!f.endsWith('.md') || f === 'MEMORY.md') continue;
      const p = join(md, f);
      const text = readFileSync(p, 'utf8');
      const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
      // keys may be top-level or nested (e.g. `metadata:\n  type: user`)
      const get = (k) => fm?.[1].match(new RegExp(`^\\s*${k}:\\s*(.*?)\\s*$`, 'm'))?.[1]?.replace(/^["']|["']$/g, '');
      const type = get('type')?.toLowerCase();
      ins.run(p, project, get('name') ?? basename(f, '.md'), get('description') ?? '',
        redact(fm ? text.slice(fm[0].length) : text).slice(0, 4000), statSync(p).mtimeMs,
        MEMORY_TYPES.includes(type) ? type : null);
    }
  }
}

// Real paths we can match transcript-dir names against: session cwds, workspace tree (depth 4).
function candidateCwds(cfg, db) {
  const out = new Set(db.prepare('SELECT DISTINCT cwd FROM sessions WHERE cwd IS NOT NULL').all().map((r) => r.cwd));
  const walk = (p, depth) => {
    out.add(p);
    if (depth === 0) return;
    try { for (const e of readdirSync(p, { withFileTypes: true }))
      if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules') walk(join(p, e.name), depth - 1); } catch {}
  };
  walk(cfg.workspaceRoot.replace(/\//g, '\\'), 4);
  return [...out];
}

export async function ingest({ full = false, log = console.log } = {}) {
  const cfg = loadConfig();
  const db = openDb();
  const ver = db.prepare('PRAGMA user_version').get().user_version;
  if (full || ver < INGEST_VERSION) db.exec('DELETE FROM ingest_state');
  const t0 = Date.now();
  const sessions = listSessions(cfg.claudeProjectsDir);
  const state = new Map(db.prepare('SELECT session_id, signature FROM ingest_state').all().map((r) => [r.session_id, r.signature]));
  const dirCwd = new Map();
  let changed = 0;
  for (const s of sessions) {
    if (state.get(s.id) === s.signature) continue;
    const r = await parseSession(s, cfg);
    db.exec('BEGIN');
    try {
      writeSession(db, s, r, cfg);
      db.prepare('INSERT OR REPLACE INTO ingest_state VALUES (?,?,?)').run(s.id, s.signature, Date.now());
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); log(`! ${s.id}: ${e.message}`); continue; }
    changed++;
  }
  // map transcript dir → cwd (for knowledge files). Dir name = cwd with every non-alnum char → '-'.
  const byId = new Map(db.prepare('SELECT id, cwd FROM sessions').all().map((r) => [r.id, r.cwd]));
  for (const s of sessions) if (!dirCwd.has(s.dir) && byId.get(s.id)) dirCwd.set(s.dir, byId.get(s.id));
  const enc = (p) => p.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase();
  const known = new Map(candidateCwds(cfg, db).map((p) => [enc(p), p]));
  for (const dir of readdirSync(cfg.claudeProjectsDir)) {
    if (!dirCwd.has(dir) && known.has(dir.toLowerCase())) dirCwd.set(dir, known.get(dir.toLowerCase()));
  }

  db.exec('BEGIN');
  estimateMissingCosts(db);
  ingestKnowledge(db, cfg, dirCwd);
  ingestExtensions(db, cfg, [...known.values()]);
  rebuildSearchIndex(db);
  db.exec('COMMIT');
  if (ver < INGEST_VERSION) db.exec(`PRAGMA user_version = ${INGEST_VERSION}`);
  const n = db.prepare('SELECT COUNT(*) n FROM sessions').get().n;
  db.close();
  log(`ingest: ${changed} session thay đổi / ${sessions.length} transcript, ${n} session trong DB, ${Date.now() - t0} ms`);
  return { changed, total: n };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await ingest({ full: process.argv.includes('--full') });
}
