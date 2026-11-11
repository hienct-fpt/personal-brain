// Read-side queries shared by the dashboard server and the MCP server: full-text search (FTS5), project brief, recent work.
import { localDay } from './lib.mjs';

// unicode61 + remove_diacritics folds "quyết" → "quyet" but treats "đ" as its own letter; fold it ourselves (1:1 chars).
export const fold = (s) => String(s ?? '').replace(/đ/g, 'd').replace(/Đ/g, 'D');

// Full rebuild of search_fts from sessions, prompts, knowledge, summaries. Small data → a few hundred ms at most.
export function rebuildSearchIndex(db) {
  db.exec('DELETE FROM search_fts');
  const ins = db.prepare('INSERT INTO search_fts (kind, ref, project, ts, title, raw, text) VALUES (?,?,?,?,?,?,?)');
  const add = (kind, ref, project, ts, title, raw) => ins.run(kind, ref, project, ts ?? 0, title ?? '', raw ?? '', fold(`${title ?? ''}\n${raw ?? ''}`));
  for (const s of db.prepare('SELECT id, project, title, started_at FROM sessions WHERE title IS NOT NULL').all())
    add('session', s.id, s.project, s.started_at, s.title, '');
  for (const p of db.prepare('SELECT session_id, project, ts, text FROM prompts').all())
    add('prompt', p.session_id, p.project, p.ts, '', p.text);
  for (const k of db.prepare('SELECT path, project, name, description, content, mtime FROM knowledge').all())
    add('knowledge', k.path, k.project, k.mtime, k.name, `${k.description}\n${k.content}`);
  for (const m of db.prepare('SELECT project, generated_at, content FROM summaries').all())
    add('summary', m.project, m.project, m.generated_at, m.project, summaryText(m.content));
  // skills/agents/commands: name + description + outline only (full bodies would drown the user's own history)
  for (const e of db.prepare('SELECT path, kind, name, scope, project, description, outline, mtime FROM extensions').all())
    add('extension', e.path, e.project ?? `(${e.scope})`, e.mtime, `${e.kind} ${e.name}`, `${e.description}
${e.outline}`);
}

// DB from before the index existed (or never ingested since): build it once.
export function ensureSearchIndex(db) {
  if (!db.prepare('SELECT 1 FROM search_fts LIMIT 1').get() && db.prepare('SELECT 1 FROM sessions LIMIT 1').get()) rebuildSearchIndex(db);
}

function summaryText(json) {
  try {
    const c = JSON.parse(json);
    return [c.headline, ...(c.current ?? []), ...(c.done ?? []).map((d) => `${d.when}: ${d.text}`),
      ...(c.decisions ?? []), ...(c.knowledge ?? []), ...(c.open ?? [])].filter(Boolean).join('\n');
  } catch { return ''; }
}

const tokensOf = (q) => (fold(q).toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []).slice(0, 12);

// Excerpt of `text` around the first query token, matched accent-insensitively.
export function snippet(text, q, width = 220) {
  const t = String(text ?? '');
  if (t.length <= width) return t;
  const folded = [...t].map((c) => fold(c).normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().padEnd(c.length).slice(0, c.length)).join('');
  const toks = tokensOf(q).map((x) => x.normalize('NFD').replace(/\p{M}/gu, ''));
  const at = Math.min(...toks.map((x) => folded.indexOf(x)).filter((i) => i >= 0), Infinity);
  const start = at === Infinity ? 0 : Math.max(0, at - Math.floor(width / 3));
  return (start > 0 ? '…' : '') + t.slice(start, start + width).trim() + (start + width < t.length ? '…' : '');
}

// Ranked hits: [{kind, ref, project, ts, title, raw, snippet}]. All words must match (prefix); falls back to any word.
export function search(db, q, { project = null, kinds = null, limit = 30 } = {}) {
  const toks = tokensOf(q);
  if (!toks.length) return [];
  const where = ['search_fts MATCH ?'];
  const args = [];
  if (project) { where.push('project = ?'); args.push(project); }
  if (kinds?.length) { where.push(`kind IN (${kinds.map(() => '?').join(',')})`); args.push(...kinds); }
  const run = (expr) => db.prepare(`SELECT kind, ref, project, ts, title, raw FROM search_fts WHERE ${where.join(' AND ')}
    ORDER BY bm25(search_fts) LIMIT ?`).all(expr, ...args, limit);
  const terms = toks.map((t) => `"${t}"*`);
  let rows = run(terms.join(' '));
  if (!rows.length && terms.length > 1) rows = run(terms.join(' OR '));
  return rows.map((r) => ({ ...r, snippet: snippet(r.raw || r.title, q) }));
}

// Exact project name, else a unique case-insensitive substring match. Returns { name } or { candidates }.
export function resolveProject(db, name) {
  const names = db.prepare('SELECT project FROM sessions UNION SELECT project FROM knowledge UNION SELECT project FROM summaries').all().map((r) => r.project);
  if (names.includes(name)) return { name };
  const n = String(name ?? '').toLowerCase();
  const hits = names.filter((p) => p.toLowerCase() === n);
  if (hits.length === 1) return { name: hits[0] };
  const like = names.filter((p) => p.toLowerCase().includes(n));
  return like.length === 1 ? { name: like[0] } : { candidates: like.length ? like : names };
}

// Everything worth knowing about one project, for an agent: summary, knowledge, recent sessions, hot files.
export function projectBrief(db, name) {
  const sessions = db.prepare(`SELECT id, cwd, title, started_at, ended_at, n_prompts, cost_usd, files_edited FROM sessions
    WHERE project = ? ORDER BY started_at DESC`).all(name);
  const files = new Map();
  const rel = (f, cwd) => { const a = f.replace(/\\/g, '/'), c = String(cwd ?? '').replace(/\\/g, '/') + '/';
    return c.length > 1 && a.toLowerCase().startsWith(c.toLowerCase()) ? a.slice(c.length) : a; };
  for (const s of sessions) for (const f of JSON.parse(s.files_edited ?? '[]')) { const k = rel(f, s.cwd); files.set(k, (files.get(k) ?? 0) + 1); }
  const sum = db.prepare('SELECT generated_at, content FROM summaries WHERE project = ?').get(name);
  return {
    project: name,
    sessions: sessions.length,
    first: sessions.at(-1)?.started_at ?? null,
    last: sessions[0]?.ended_at ?? null,
    cost: sessions.reduce((a, s) => a + (s.cost_usd ?? 0), 0),
    summary: sum ? { generated_at: sum.generated_at, ...JSON.parse(sum.content) } : null,
    knowledge: db.prepare('SELECT name, description, content, mtime FROM knowledge WHERE project = ? ORDER BY mtime DESC').all(name),
    recent: sessions.slice(0, 10).map(({ files_edited, cwd, ...s }) => s),
    files: [...files].sort((a, b) => b[1] - a[1]).slice(0, 10),
    prompts: db.prepare('SELECT ts, text FROM prompts WHERE project = ? ORDER BY ts DESC LIMIT 10').all(name),
  };
}

// Sessions that ended in the last `days` days, newest first, with their local day.
export function recent(db, days = 7, project = null) {
  const since = Date.now() - days * 864e5;
  return db.prepare(`SELECT project, title, started_at, ended_at, n_prompts, cost_usd FROM sessions
    WHERE ended_at >= ? ${project ? 'AND project = ?' : ''} ORDER BY ended_at DESC LIMIT 200`)
    .all(...(project ? [since, project] : [since])).map((s) => ({ ...s, day: localDay(s.ended_at) }));
}

// Skills / subagents / slash commands: on-disk inventory merged with transcript usage.
// Copies with the same name (nested repos, user + synced…) collapse into one item; a skill and a command with
// the same name are one item too (a skill is invoked as /name). Usage with a plugin prefix ("plugin:name")
// also matches the bare name. Usage with no file on disk = built-in (/clear, general-purpose agent…).
export function extensionsOverview(db, { since = 0, project = null } = {}) {
  const fam = (k) => (k === 'agent' ? 'agent' : 'sc');
  const groups = new Map();
  const make = (key, name, extra) => { const g = { key, name, kinds: [], description: '', outline: '', meta: {}, path: null,
    copies: [], uses: 0, sessions: new Set(), last: null, projects: new Map(), byKind: {}, ...extra }; groups.set(key, g); return g; };
  for (const e of db.prepare('SELECT path, kind, name, scope, project, description, outline, meta FROM extensions ORDER BY mtime DESC').all()) {
    const key = `${fam(e.kind)}:${e.name.toLowerCase()}`;
    const g = groups.get(key) ?? make(key, e.name, { description: e.description, outline: e.outline, meta: JSON.parse(e.meta || '{}'), path: e.path });
    if (!g.kinds.includes(e.kind)) g.kinds.push(e.kind);
    if (!g.description && e.description) g.description = e.description;
    g.copies.push({ scope: e.scope, project: e.project, path: e.path });
  }
  const rows = db.prepare(`SELECT session_id, project, ts, kind, name FROM ext_usage WHERE ts >= ? ${project ? 'AND project = ?' : ''}`)
    .all(...(project ? [since, project] : [since]));
  for (const u of rows) {
    const n = u.name.toLowerCase(), f = fam(u.kind);
    const g = groups.get(`${f}:${n}`) ?? groups.get(`${f}:${n.slice(n.indexOf(':') + 1)}`) ?? make(`${f}:${n}`, u.name, { builtin: true });
    if (g.builtin && !g.kinds.includes(u.kind)) g.kinds.push(u.kind);
    g.uses++; g.sessions.add(u.session_id); g.last = Math.max(g.last ?? 0, u.ts);
    g.projects.set(u.project, (g.projects.get(u.project) ?? 0) + 1);
    g.byKind[u.kind] = (g.byKind[u.kind] ?? 0) + 1;
  }
  const items = [...groups.values()].map((g) => ({ ...g, builtin: !!g.builtin, sessions: g.sessions.size,
    projects: [...g.projects].sort((a, b) => b[1] - a[1]) }))
    .sort((a, b) => b.uses - a.uses || a.name.localeCompare(b.name));
  return { items, events: rows.length };
}
