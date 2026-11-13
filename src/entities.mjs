// Cheap entity graph (idea from Zero-Mem, arXiv 2607.29377): entities are pulled out with regexes — no NER, no LLM —
// and linked to the unit they appear in (a session or a memory file). Relatedness = co-occurrence in the same units,
// weighted by the entity's share of each unit (Zero-Mem Eq. 4) × idf, so ubiquitous entities don't dominate.

const FILE_EXT = 'mjs|cjs|js|jsx|ts|tsx|py|ipynb|md|json|jsonl|html?|css|scss|sql|ya?ml|toml|ini|xml|sh|ps1|bat|cmd|java|kt|go|rs|cs|rb|php|c|cpp|h|hpp|vue|svelte|'
  + 'xlsx|xlsm|xls|docx|pptx|pdf|csv|tsv|txt|log|db|cbl|cob|cpy|rpgle|sqlrpgle|clle|dds|jcl|properties|gradle|dockerfile';
const FILE_RE = new RegExp(String.raw`(?<![\w@.])(?:[\w.~-]+[\\/])*([\w-][\w.-]*\.(?:${FILE_EXT}))(?![\w-])`, 'gi');
const IS_FILE = new RegExp(String.raw`^[\w.~\\/-]*\.(?:${FILE_EXT})$`, 'i');
// JIRA-style keys; prefixes that are standards/versions, not tickets, are skipped
const TICKET_RE = /\b([A-Z][A-Z0-9]{1,9})-(\d{1,6})\b/g;
const NOT_TICKET = new Set(['UTF', 'SHA', 'ISO', 'GPT', 'AES', 'RSA', 'HTTP', 'TLS', 'SSL', 'ES', 'ECMA', 'WIN', 'IPV', 'MP', 'BGE', 'TOP', 'BM']);
const ISSUE_RE = /(?<![\w&#])#(\d{2,7})\b/g;
const CODE_RE = /`([^`\s]{3,60})`/g;

const base = (p) => p.replace(/\\/g, '/').split('/').pop();

// [{kind, key, name}] found in free text (one entry per occurrence).
export function extractEntities(text) {
  const t = String(text ?? '');
  const out = [];
  const add = (kind, name) => out.push({ kind, key: name.toLowerCase(), name });
  for (const m of t.matchAll(FILE_RE)) add('file', m[1]);
  for (const m of t.matchAll(TICKET_RE)) if (!NOT_TICKET.has(m[1])) add('ticket', `${m[1]}-${m[2]}`);
  for (const m of t.matchAll(ISSUE_RE)) add('ticket', `#${m[1]}`);
  for (const m of t.matchAll(CODE_RE)) {
    const c = m[1].replace(/\(\)$/, '').replace(/[.,:;]+$/, '');
    // files are already caught by FILE_RE; skip numbers, bare punctuation and long paths
    if (IS_FILE.test(c) || !/[a-z]/i.test(c) || /^\d/.test(c) || (c.match(/[\\/]/g) ?? []).length > 1) continue;
    add('code', c);
  }
  return out;
}

// Rebuild the derived `entities` table from sessions (title + prompts + edited files + skill/agent/command use)
// and memory files. Call inside a transaction.
export function rebuildEntities(db) {
  db.exec('DELETE FROM entities');
  const ins = db.prepare('INSERT INTO entities (unit, unit_kind, project, ts, kind, key, name, n) VALUES (?,?,?,?,?,?,?,?)');
  const flush = (unit, unitKind, project, ts, list) => {
    const m = new Map();
    for (const e of list) {
      const id = `${e.kind}\0${e.key}`;
      const x = m.get(id) ?? { ...e, n: 0 };
      x.n++; m.set(id, x);
    }
    // cap repeats: one prompt pasting a file name 30 times shouldn't outweigh everything else in the session
    for (const e of m.values()) ins.run(unit, unitKind, project, ts ?? 0, e.kind, e.key, e.name, Math.min(e.n, 5));
  };
  const prompts = db.prepare('SELECT text FROM prompts WHERE session_id = ?');
  const usage = db.prepare('SELECT kind, name FROM ext_usage WHERE session_id = ?');
  for (const s of db.prepare('SELECT id, project, title, started_at, files_edited FROM sessions').all()) {
    const list = extractEntities(s.title);
    for (const p of prompts.all(s.id)) list.push(...extractEntities(p.text));
    for (const f of JSON.parse(s.files_edited ?? '[]')) { const b = base(f); if (b) list.push({ kind: 'file', key: b.toLowerCase(), name: b }); }
    for (const u of usage.all(s.id)) list.push({ kind: u.kind, key: u.name.toLowerCase(), name: u.name });
    flush(s.id, 'session', s.project, s.started_at, list.map((e) => (e.kind === 'file' ? { ...e, key: base(e.key), name: base(e.name) } : e)));
  }
  for (const k of db.prepare('SELECT path, project, name, description, content, mtime FROM knowledge').all())
    flush(k.path, 'knowledge', k.project, k.mtime, extractEntities(`${k.name}\n${k.description}\n${k.content}`)
      .map((e) => (e.kind === 'file' ? { ...e, key: base(e.key), name: base(e.name) } : e)));
}

// What co-occurs with `term` (file name, ticket, skill/command name, code identifier).
// Returns { matched: [{kind,name,units}], related: [{kind,name,score,units}], units: [{unit,unit_kind,project,ts}], projects }
// or { candidates } when nothing matches exactly and the substring matches are too many to be useful.
export function related(db, term, { project = null, limit = 8 } = {}) {
  let t = String(term ?? '').trim().replace(/^[`/]+|[`]+$/g, '').replace(/\(\)$/, '');
  if (/[\\/]/.test(t) && IS_FILE.test(t)) t = base(t);
  const key = t.toLowerCase();
  if (!key) return { matched: [], related: [], units: [], projects: [] };
  const pf = project ? ' AND project = ?' : '';
  const pa = project ? [project] : [];
  const keyStats = (where, args) => db.prepare(`SELECT kind, key, MAX(name) name, COUNT(DISTINCT unit) units FROM entities
    WHERE ${where}${pf} GROUP BY kind, key ORDER BY units DESC LIMIT 40`).all(...args, ...pa);
  let matched = keyStats('key = ?', [key]);
  if (!matched.length) {
    matched = keyStats("key LIKE ? ESCAPE '\\'", [`%${key.replace(/[\\%_]/g, '\\$&')}%`]);
    if (matched.length > 5) return { candidates: matched.slice(0, 20) };
  }
  if (!matched.length) return { matched: [], related: [], units: [], projects: [] };

  const ids = new Set(matched.map((m) => `${m.kind}\0${m.key}`));
  const rows = db.prepare(`SELECT unit, unit_kind, project, ts, kind, key, name, n FROM entities WHERE unit IN (
    SELECT unit FROM entities WHERE (${matched.map(() => '(kind = ? AND key = ?)').join(' OR ')})${pf})`)
    .all(...matched.flatMap((m) => [m.kind, m.key]), ...pa);
  const total = new Map(), seeds = new Map();
  for (const r of rows) {
    total.set(r.unit, (total.get(r.unit) ?? 0) + r.n);
    if (ids.has(`${r.kind}\0${r.key}`)) seeds.set(r.unit, { unit: r.unit, unit_kind: r.unit_kind, project: r.project, ts: r.ts });
  }
  const N = db.prepare('SELECT COUNT(DISTINCT unit) n FROM entities').get().n || 1;
  const dfQ = db.prepare('SELECT COUNT(DISTINCT unit) n FROM entities WHERE kind = ? AND key = ?');
  const acc = new Map();
  for (const r of rows) {
    const id = `${r.kind}\0${r.key}`;
    if (ids.has(id)) continue;
    const a = acc.get(id) ?? { kind: r.kind, key: r.key, name: r.name, w: 0, units: new Set() };
    a.w += r.n / total.get(r.unit); a.units.add(r.unit); acc.set(id, a);
  }
  const rel = [...acc.values()].map((a) => {
    const df = dfQ.get(a.kind, a.key).n || 1;
    return { kind: a.kind, name: a.name, units: a.units.size, score: a.w * Math.log(1 + N / df) };
  }).filter((a) => a.units > 1 || seeds.size <= 2).sort((a, b) => b.score - a.score);
  // top `limit` per entity kind
  const per = new Map();
  const related = rel.filter((a) => { const c = per.get(a.kind) ?? 0; per.set(a.kind, c + 1); return c < limit; });
  const projects = new Map();
  for (const s of seeds.values()) projects.set(s.project, (projects.get(s.project) ?? 0) + 1);
  return {
    matched: matched.map(({ kind, name, units }) => ({ kind, name, units })),
    related,
    units: [...seeds.values()].sort((a, b) => b.ts - a.ts),
    projects: [...projects].sort((a, b) => b[1] - a[1]),
  };
}
