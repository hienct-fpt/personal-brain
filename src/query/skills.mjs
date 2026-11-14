// Skill health (P1) and new-skill candidates (P2), derived from the `extensions`, `ext_usage`, `sessions` and `prompts` tables.
// Pure functions over the DB — shared by the HTTP API; nothing here writes.
import { statSync } from 'node:fs';

export const SKILL_RULES = {
  repeatMin: 3,         // a prompt (cluster) typed ≥ 3 times is a skill candidate
  similarity: 0.6,      // Jaccard threshold to merge two prompts into one cluster
  coveredBy: 0.5,       // share of a candidate's words found in a skill's name+description → "already covered"
  overlap: 0.5,         // Jaccard between two skill descriptions → "trigger collision"
  descMin: 40,          // description shorter than this is too vague to trigger reliably
  descMax: 600,         // …longer than this wastes context on every session
  bodyMax: 20000,       // SKILL.md bigger than this (bytes, ≈ 500 lines) should be split into reference files
  maxPrompts: 20000,
};

export const normPrompt = (t) => t.toLowerCase().replace(/\s+/g, ' ').trim();
// Long repeated texts are scripted templates (e.g. our own summary prompt), not something the user types.
export const isNoisePrompt = (t) => t.length < 6 || t.length > 300 || t.startsWith('/') || t.startsWith('<') || t.startsWith('this session is being continued');

const STOP = new Set(['the', 'and', 'for', 'with', 'this', 'that', 'use', 'when', 'you', 'are', 'from', 'not', 'cho', 'của', 'và', 'các', 'một', 'những', 'khi', 'với', 'này', 'được', 'trong', 'hãy']);
const words = (t) => new Set((String(t).toLowerCase().match(/[\p{L}\p{N}_]{3,}/gu) ?? []).filter((w) => !STOP.has(w)));
const jaccard = (a, b) => { if (!a.size || !b.size) return 0; let i = 0; for (const x of a) if (b.has(x)) i++; return i / (a.size + b.size - i); };
const shareIn = (a, b) => { if (!a.size) return 0; let i = 0; for (const x of a) if (b.has(x)) i++; return i / a.size; };
const bare = (n) => n.toLowerCase().slice(n.indexOf(':') + 1); // "plugin:name" → "name"
const TRIGGER = /\b(use when|use this|when (the )?user|trigger|triggers on|whenever|if the user)\b|dùng khi|khi (người dùng|user)|kích hoạt/i;

// Installed skills, merged by name (copies in user / synced / plugin / project collapse into one).
function installedSkills(db) {
  const m = new Map();
  for (const e of db.prepare("SELECT path, name, scope, project, description, outline, meta, size FROM extensions WHERE kind = 'skill' ORDER BY mtime DESC").all()) {
    const k = e.name.toLowerCase();
    const meta = JSON.parse(e.meta || '{}');
    const s = m.get(k) ?? { name: e.name, path: e.path, description: e.description ?? '', size: e.size ?? 0, scopes: new Set(), projects: new Set(),
      hidden: meta['disable-model-invocation'] === 'true', copies: [] };
    s.scopes.add(e.scope); if (e.project) s.projects.add(e.project);
    s.copies.push({ path: e.path, scope: e.scope, project: e.project });
    if (!s.description && e.description) s.description = e.description;
    m.set(k, s);
  }
  return [...m.values()];
}

export function skillHealth(db, { since = 0, rules = SKILL_RULES } = {}) {
  const R = rules;
  const skills = installedSkills(db);
  const sessionsAll = db.prepare('SELECT COUNT(*) n FROM sessions WHERE ended_at >= ?').get(since).n;
  const byProject = new Map(db.prepare('SELECT project, COUNT(*) n FROM sessions WHERE ended_at >= ? GROUP BY project').all(since).map((r) => [r.project, r.n]));

  const use = new Map(); // bare name → { uses, sessions:Set, last, usesAll, lastAll }
  for (const u of db.prepare("SELECT session_id, ts, name FROM ext_usage WHERE kind = 'skill'").all()) {
    const k = bare(u.name);
    const g = use.get(k) ?? { uses: 0, sessions: new Set(), last: null, usesAll: 0 };
    g.usesAll++; g.last = Math.max(g.last ?? 0, u.ts);
    if (u.ts >= since) { g.uses++; g.sessions.add(u.session_id); }
    use.set(k, g);
  }

  const dw = skills.map((s) => words(s.description));
  const out = skills.map((s, i) => {
    const u = use.get(s.name.toLowerCase());
    const descLen = s.description.length;
    // Name + description are listed in every session where the skill is visible → ~4 chars/token.
    const tokens = s.hidden ? 0 : Math.ceil((s.name.length + descLen) / 4);
    const seen = s.scopes.size === 1 && s.scopes.has('project') ? [...s.projects].reduce((a, p) => a + (byProject.get(p) ?? 0), 0) : sessionsAll;
    const issues = [];
    if (!descLen) issues.push({ id: 'no_description', text: 'Thiếu description — Claude không biết khi nào nên gọi skill này.' });
    else {
      if (descLen < R.descMin) issues.push({ id: 'short_description', text: `Description chỉ ${descLen} ký tự — quá mơ hồ để kích hoạt đúng.` });
      if (descLen > R.descMax) issues.push({ id: 'long_description', text: `Description ${descLen} ký tự (> ${R.descMax}) — tốn context ở mọi session, rút gọn lại.` });
      if (!TRIGGER.test(s.description)) issues.push({ id: 'no_trigger', text: 'Description không nói "dùng khi nào" (use when / dùng khi …) — dễ không được kích hoạt.' });
    }
    if (s.size > R.bodyMax) issues.push({ id: 'big_body', text: `SKILL.md ${Math.round(s.size / 1024)} KB — tách phần chi tiết sang file tham chiếu để chỉ nạp khi cần.` });
    const twins = skills.filter((o, j) => j !== i && jaccard(dw[i], dw[j]) >= R.overlap).map((o) => o.name);
    if (twins.length) issues.push({ id: 'overlap', text: `Description giống ${twins.slice(0, 3).join(', ')} — dễ kích hoạt nhầm, gộp hoặc phân biệt rõ.` });
    const dead = !(u?.uses > 0);
    return {
      name: s.name, path: s.path, copies: s.copies, scopes: [...s.scopes], projects: [...s.projects],
      uses: u?.uses ?? 0, sessions: u?.sessions.size ?? 0, last: u?.last ?? null, neverUsed: !u?.usesAll,
      descChars: descLen, tokens, seenSessions: seen, ctxTokens: tokens * seen, hidden: s.hidden,
      dead, issues,
      verdict: dead ? (u?.usesAll ? 'dead' : 'unused') : issues.length ? 'fix' : 'ok',
    };
  }).sort((a, b) => (a.verdict === 'ok') - (b.verdict === 'ok') || b.ctxTokens - a.ctxTokens);

  const deadOnes = out.filter((s) => s.dead && !s.hidden);
  return {
    sessions: sessionsAll,
    summary: {
      installed: out.length,
      dead: deadOnes.length,
      wastedTokens: deadOnes.reduce((a, s) => a + s.ctxTokens, 0),
      withIssues: out.filter((s) => s.issues.length).length,
      ctxTokensPerSession: out.reduce((a, s) => a + s.tokens, 0),
    },
    skills: out,
  };
}

// Repeated prompts clustered by word overlap → skill candidates. A cluster whose words are mostly found in an installed
// skill's name+description is marked `coveredBy` (the user keeps typing by hand what a skill already does).
export function skillCandidates(db, { since = 0, rules = SKILL_RULES } = {}) {
  const R = rules;
  const clusters = [];
  const exact = new Map();
  for (const p of db.prepare('SELECT project, text, ts FROM prompts WHERE ts >= ? ORDER BY ts DESC LIMIT ?').all(since, R.maxPrompts)) {
    const k = normPrompt(p.text ?? '');
    if (isNoisePrompt(k)) continue;
    const e = exact.get(k) ?? { text: p.text.trim().slice(0, 300), n: 0, projects: new Map(), last: p.ts, w: words(k) };
    e.n++; e.projects.set(p.project, (e.projects.get(p.project) ?? 0) + 1); exact.set(k, e);
  }
  for (const e of [...exact.values()].sort((a, b) => b.n - a.n)) {
    const c = clusters.find((x) => e.w.size >= 2 && jaccard(x.w, e.w) >= R.similarity);
    if (c) { c.n += e.n; c.examples.push(e.text); for (const [p, n] of e.projects) c.projects.set(p, (c.projects.get(p) ?? 0) + n); c.last = Math.max(c.last, e.last); }
    else clusters.push({ text: e.text, n: e.n, w: e.w, examples: [e.text], projects: new Map(e.projects), last: e.last });
  }
  const skills = installedSkills(db).map((s) => ({ name: s.name, w: words(`${s.name.replace(/-/g, ' ')} ${s.description}`) }));
  const items = clusters.filter((c) => c.n >= R.repeatMin).sort((a, b) => b.n - a.n).slice(0, 12).map((c) => {
    // ≥ 3 keywords: a 2-word prompt ("restart server") matches almost any long description by chance.
    const cover = c.w.size < 3 ? null : skills.map((s) => ({ name: s.name, share: shareIn(c.w, s.w) })).sort((a, b) => b.share - a.share)[0];
    const projects = [...c.projects].sort((a, b) => b[1] - a[1]);
    return { text: c.text, n: c.n, examples: c.examples.slice(0, 6), projects: projects.map(([p]) => p), last: c.last,
      coveredBy: cover && cover.share >= R.coveredBy ? cover.name : null };
  });
  // Where a project-scoped skill would live: the newest session cwd of the (single) project that exists on disk.
  for (const it of items) {
    it.dir = null;
    if (it.projects.length !== 1) continue;
    for (const r of db.prepare('SELECT DISTINCT cwd FROM sessions WHERE project = ? AND cwd IS NOT NULL ORDER BY started_at DESC LIMIT 3').all(it.projects[0])) {
      try { if (statSync(r.cwd).isDirectory()) { it.dir = r.cwd; break; } } catch {}
    }
  }
  return items;
}
