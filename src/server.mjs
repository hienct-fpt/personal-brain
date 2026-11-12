// Personal Brain dashboard server (zero deps). Usage: node --no-warnings server.mjs
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { openDb, loadConfig, saveConfig, localDay, HOME } from './lib.mjs';
import { getApiKey, setApiKey, keyHint } from './secrets.mjs';
import { PROVIDERS, ProviderError, listModels, providerReady } from './providers.mjs';
import { ingest } from './ingest.mjs';
import { search as ftsSearch, ensureSearchIndex, extensionsOverview, profile } from './query.mjs';
import { listKit } from './kit.mjs';
import { summarizeProject, NoApiKeyError, EFFORTS, aiConfig, activeProvider } from './summarize.mjs';

const cfg = loadConfig();
const db = openDb();
db.exec('BEGIN'); ensureSearchIndex(db); db.exec('COMMIT');
const port = Number(process.env.BRAIN_PORT ?? cfg.port);
// Commit of the code this process loaded vs. what is installed now (differs after an upgrade until restart).
const readCommit = () => { try { return JSON.parse(readFileSync(join(HOME, 'version.json'), 'utf8')).commit ?? null; } catch { return null; } };
const VERSION = readCommit();
const state = { ingesting: false, lastIngest: null, lastResult: null, summarizing: new Set() };

async function runIngest() {
  if (state.ingesting) return;
  state.ingesting = true;
  try { state.lastResult = await ingest({ log: (m) => console.log(new Date().toLocaleTimeString(), m) }); state.lastIngest = Date.now(); }
  catch (e) { console.error('ingest failed', e); }
  finally { state.ingesting = false; }
}

const all = (sql, ...a) => db.prepare(sql).all(...a);
const get = (sql, ...a) => db.prepare(sql).get(...a);
const sinceMs = (days) => (days > 0 ? Date.now() - days * 86400e3 : 0);
const sinceDay = (days) => (days > 0 ? localDay(sinceMs(days)) : '0000');

function usage(days) {
  const d = sinceDay(days);
  const totals = get(`SELECT COALESCE(SUM(cost_usd),0) cost, COALESCE(SUM(input),0) input, COALESCE(SUM(output),0) output,
    COALESCE(SUM(cache_read),0) cache_read, COALESCE(SUM(cache_write),0) cache_write, COUNT(*) calls
    FROM usage WHERE day >= ?`, d);
  const sess = get(`SELECT COUNT(*) n, COALESCE(SUM(n_prompts),0) prompts, SUM(cost_source='estimated') est,
    COALESCE(SUM(lines_added),0) added, COALESCE(SUM(lines_removed),0) removed, COUNT(DISTINCT project) projects,
    COALESCE(SUM(tool_errors),0) tool_errors, COALESCE(SUM(subagents),0) subagents
    FROM sessions WHERE ended_at >= ?`, sinceMs(days));
  return {
    totals, sessions: sess,
    daily: all(`SELECT day, model, SUM(cost_usd) cost, SUM(input+output+cache_read+cache_write) tokens, SUM(output) output
      FROM usage WHERE day >= ? GROUP BY day, model ORDER BY day`, d),
    byModel: all(`SELECT model, SUM(cost_usd) cost, SUM(input) input, SUM(output) output, SUM(cache_read) cache_read,
      SUM(cache_write) cache_write, COUNT(*) calls, COUNT(DISTINCT session_id) sessions FROM usage WHERE day >= ?
      GROUP BY model ORDER BY cost DESC`, d),
    byProject: all(`SELECT project, SUM(cost_usd) cost, SUM(input+output+cache_read+cache_write) tokens,
      COUNT(DISTINCT session_id) sessions FROM usage WHERE day >= ? GROUP BY project ORDER BY cost DESC`, d),
    topSessions: all(`SELECT id, project, title, started_at, ended_at, n_prompts, cost_usd, cost_source
      FROM sessions WHERE ended_at >= ? ORDER BY cost_usd DESC LIMIT 12`, sinceMs(days)),
    byHour: all(`SELECT CAST(strftime('%H', ts/1000, 'unixepoch', 'localtime') AS INTEGER) hour, SUM(cost_usd) cost, COUNT(*) calls
      FROM usage WHERE day >= ? GROUP BY hour`, d),
  };
}

// Daily activity = prompts typed per project-day (transcript).
const ACTIVITY_SQL = `
  SELECT project, date(ts/1000, 'unixepoch', 'localtime') day, COUNT(*) prompts FROM prompts GROUP BY 1, 2`;

function activity(name, days = 182) {
  const from = localDay(sinceMs(days));
  const where = name ? 'WHERE a.project = ? AND a.day >= ?' : 'WHERE a.day >= ?';
  const args = name ? [name, from] : [from];
  const rows = all(`SELECT a.day, SUM(a.prompts) prompts, COUNT(*) projects, GROUP_CONCAT(a.project, '|') names
    FROM (${ACTIVITY_SQL}) a ${where} GROUP BY a.day ORDER BY a.day`, ...args);
  const cost = new Map(all(`SELECT day, SUM(cost_usd) c FROM usage WHERE day >= ? ${name ? 'AND project = ?' : ''} GROUP BY day`,
    ...(name ? [from, name] : [from])).map((r) => [r.day, r.c]));
  return rows.map((r) => ({ ...r, cost: cost.get(r.day) ?? 0, names: name ? undefined : [...new Set(r.names.split('|'))] }));
}

function statusOf(last) {
  const d = last ? (Date.now() - last) / 864e5 : Infinity;
  return d <= 7 ? 'active' : d <= 21 ? 'slowing' : d <= 60 ? 'paused' : 'archived';
}

function projects() {
  const rows = all(`
    WITH names AS (SELECT project FROM sessions UNION SELECT project FROM knowledge)
    SELECT n.project,
      (SELECT COUNT(*) FROM sessions s WHERE s.project = n.project) sessions,
      (SELECT COALESCE(SUM(n_prompts),0) FROM sessions s WHERE s.project = n.project) prompts,
      (SELECT COALESCE(SUM(cost_usd),0) FROM sessions s WHERE s.project = n.project) cost,
      (SELECT MAX(ended_at) FROM sessions s WHERE s.project = n.project) last_session,
      (SELECT MIN(started_at) FROM sessions s WHERE s.project = n.project) first_session,
      (SELECT COUNT(*) FROM knowledge k WHERE k.project = n.project) knowledge,
      (SELECT title FROM sessions s WHERE s.project = n.project ORDER BY ended_at DESC LIMIT 1) last_title,
      (SELECT generated_at FROM summaries m WHERE m.project = n.project) summary_at,
      (SELECT content FROM summaries m WHERE m.project = n.project) summary
    FROM names n WHERE n.project NOT LIKE '(%'`);
  const from = localDay(sinceMs(28));
  const act = new Map();
  for (const r of all(`SELECT project, day, prompts FROM (${ACTIVITY_SQL}) WHERE day >= ?`, from)) {
    if (!act.has(r.project)) act.set(r.project, {});
    act.get(r.project)[r.day] = r.prompts;
  }
  const cost30 = new Map(all('SELECT project, SUM(cost_usd) c FROM usage WHERE day >= ? GROUP BY project', localDay(sinceMs(30))).map((r) => [r.project, r.c]));
  for (const r of rows) {
    r.last_active = r.last_session ?? null;
    r.first_active = r.first_session ?? null;
    r.status = statusOf(r.last_active);
    r.group = r.project.includes('/') ? r.project.split('/')[0] : null;
    const a = act.get(r.project) ?? {};
    r.spark = Array.from({ length: 28 }, (_, i) => a[localDay(Date.now() - (27 - i) * 864e5)] ?? 0);
    r.active_days_28 = r.spark.filter(Boolean).length;
    r.cost_30 = cost30.get(r.project) ?? 0;
    const sum = r.summary ? JSON.parse(r.summary) : null;
    r.headline = sum?.headline ?? null;
    r.current = sum?.current?.slice(0, 2) ?? [];
    r.open_count = sum?.open?.length ?? 0;
    delete r.summary;
  }
  return rows.sort((a, b) => (b.last_active ?? 0) - (a.last_active ?? 0));
}

function project(name) {
  const sessions = all(`SELECT id, title, started_at, ended_at, n_prompts, n_turns, cost_usd, cost_source,
    lines_added, lines_removed, tools, files_edited, tool_errors, subagents FROM sessions WHERE project = ? ORDER BY started_at DESC`, name);
  const fileCount = new Map();
  const toolCount = {};
  for (const s of sessions) {
    for (const f of JSON.parse(s.files_edited ?? '[]')) fileCount.set(f, (fileCount.get(f) ?? 0) + 1);
    for (const [t, n] of Object.entries(JSON.parse(s.tools ?? '{}'))) toolCount[t] = (toolCount[t] ?? 0) + n;
    delete s.files_edited; delete s.tools;
  }
  const summary = get('SELECT generated_at, model, content FROM summaries WHERE project = ?', name);
  const meta = projects().find((p) => p.project === name) ?? {};
  return {
    project: name, sessions, status: meta.status, group: meta.group, first_active: meta.first_active, last_active: meta.last_active,
    activity: activity(name, 182),
    summary: summary ? { ...summary, content: JSON.parse(summary.content) } : null,
    summarizing: state.summarizing.has(name),
    files: [...fileCount].sort((a, b) => b[1] - a[1]).slice(0, 25).map(([path, sessions]) => ({ path, sessions })),
    tools: Object.entries(toolCount).sort((a, b) => b[1] - a[1]).slice(0, 12),
    prompts: all('SELECT session_id, ts, text FROM prompts WHERE project = ? ORDER BY ts DESC LIMIT 40', name),
    knowledge: all('SELECT type, name, description, content, mtime FROM knowledge WHERE project = ? ORDER BY mtime DESC', name),
    extensions: extensionsOverview(db, { project: name }).items.filter((x) => x.uses).map(({ copies, ...x }) => x),
    localExtensions: all(`SELECT kind, name, MAX(description) description, COUNT(*) copies FROM extensions WHERE project = ?
      GROUP BY kind, name ORDER BY kind, name`, name),
    daily: all('SELECT day, SUM(cost_usd) cost FROM usage WHERE project = ? GROUP BY day ORDER BY day', name),
    byModel: all('SELECT model, SUM(cost_usd) cost FROM usage WHERE project = ? GROUP BY model ORDER BY cost DESC', name),
  };
}

// Starter kit (src/kit) + where each item is already installed (same kind + name in a user/project .claude/).
function kit() {
  const where = all("SELECT kind, name, scope, project FROM extensions WHERE scope IN ('user', 'project')");
  return listKit().map(({ src, ...x }) => ({ ...x,
    installed: [...new Set(where.filter((w) => w.kind === x.kind && w.name === x.name).map((w) => w.project ?? '~/.claude'))] }));
}

// FTS5 ranked search (accent-insensitive, prefix match) grouped for the search view.
function search(q) {
  const hits = (kind, limit) => ftsSearch(db, q, { kinds: [kind], limit });
  return {
    sessions: hits('session', 20).map((h) => ({ id: h.ref, project: h.project, title: h.title, started_at: h.ts })),
    knowledge: hits('knowledge', 20).map((h) => ({ project: h.project, name: h.title,
      description: get('SELECT description FROM knowledge WHERE path = ?', h.ref)?.description ?? '' })),
    extensions: hits('extension', 15).map((h) => ({ project: h.project, title: h.title, snippet: h.snippet, path: h.ref })),
    summaries: hits('summary', 10).map((h) => ({ project: h.project, ts: h.ts, snippet: h.snippet })),
    prompts: hits('prompt', 40).map((h) => ({ project: h.project, ts: h.ts, text: h.raw })),
  };
}

// Optimization tips: rule-based checks over usage / sessions / prompts in the window. Thresholds live here.
const TIP_RULES = {
  minCost: 5,              // ignore model-mix advice below this total spend
  opusShare: 0.8,          // warn when Opus ≥ 80% of cost (high ≥ 90%)
  subagents: 20,           // warn when ≥ 20 subagents in the window
  toolErrMin: 20,          // project with ≥ 20 tool errors…
  toolErrPerSession: 5,    // …or ≥ 5 errors/session (and ≥ 10 total)
  cacheLow: 0.8,           // cache hit below 80%…
  cacheMinCost: 2,         // …on a project costing ≥ $2
  repeatMin: 3,            // same prompt typed ≥ 3 times
  longPrompts: 40,         // session with ≥ 40 prompts…
  longCost: 30,            // …and ≥ $30
};
const normPrompt = (t) => t.toLowerCase().replace(/\s+/g, ' ').trim();
// Long repeated texts are scripted templates (e.g. our own summary prompt), not something the user types.
const isNoisePrompt = (t) => t.length < 6 || t.length > 300 || t.startsWith('/') || t.startsWith('<') || t.startsWith('this session is being continued');

function insights(days) {
  const d = sinceDay(days), since = sinceMs(days), R = TIP_RULES;
  const tips = [];
  const pct = (v) => Math.round(v * 100);

  // 1. Model mix: Opus share of cost, with saving estimate from observed cost-per-unit of Sonnet vs Opus.
  const byModel = all('SELECT model, COALESCE(SUM(cost_usd),0) cost, COALESCE(SUM(units),0) units FROM usage WHERE day >= ? GROUP BY model', d);
  const total = byModel.reduce((a, m) => a + m.cost, 0);
  const sum = (k, f) => byModel.filter((m) => m.model.includes(k)).reduce((a, m) => a + m[f], 0);
  const opus = sum('opus', 'cost');
  if (total >= R.minCost && opus / total >= R.opusShare) {
    const ratio = sum('sonnet', 'units') > 0 && sum('opus', 'units') > 0
      ? (sum('sonnet', 'cost') / sum('sonnet', 'units')) / (opus / sum('opus', 'units')) : null;
    const saving = ratio != null && ratio < 1 ? opus * 0.5 * (1 - ratio) : null;
    tips.push({
      id: 'opus', level: opus / total >= 0.9 ? 'high' : 'medium',
      title: `Opus chiếm ${pct(opus / total)}% chi phí`,
      detail: `${'$' + opus.toFixed(0)} / ${'$' + total.toFixed(0)} là Opus.` + (saving != null
        ? ` Nếu chuyển một nửa khối lượng Opus sang Sonnet, ước tiết kiệm ≈ $${saving.toFixed(0)} (theo giá thực tế quan sát được: Sonnet ≈ ${pct(ratio)}% giá Opus/token).` : ''),
      items: all(`SELECT project, SUM(cost_usd) cost FROM usage WHERE day >= ? AND model LIKE '%opus%'
        GROUP BY project ORDER BY cost DESC LIMIT 5`, d).map((r) => ({ label: r.project, project: r.project, cost: r.cost })),
      actions: [
        'Dùng `/model opusplan`: Opus lập kế hoạch, Sonnet viết code.',
        'Thêm `model: sonnet` vào frontmatter các slash command / skill chuyên code (vd. `.claude/commands/*.md`).',
        'Việc lặt vặt (đổi tên, sửa format, chạy lệnh) → `/model sonnet` hoặc `haiku`.',
      ],
    });
  }

  // 2. Subagents: fan-out multiplies context cost.
  const subs = get('SELECT COALESCE(SUM(subagents),0) n, COUNT(*) s FROM sessions WHERE ended_at >= ? AND subagents > 0', since);
  if (subs.n >= R.subagents) {
    tips.push({
      id: 'subagents', level: subs.n >= R.subagents * 3 ? 'high' : 'medium',
      title: `${subs.n} subagent trong ${subs.s} session`,
      detail: 'Mỗi subagent tự đọc lại ngữ cảnh và chạy theo model của session chính (thường là Opus) nếu không chỉ định model.',
      items: all(`SELECT project, title, subagents, cost_usd cost FROM sessions WHERE ended_at >= ? AND subagents > 0
        ORDER BY subagents DESC LIMIT 6`, since).map((r) => ({ label: r.title ?? '(không tiêu đề)', project: r.project, cost: r.cost, note: `${r.subagents} subagent` })),
      actions: [
        'Gán `model: sonnet` hoặc `haiku` trong `.claude/agents/*.md` cho agent tìm kiếm / đọc code.',
        'Tự làm các tra cứu ngắn (Grep/Read) thay vì giao subagent; chỉ fan-out khi việc thật sự độc lập.',
        'Workflow nhiều agent: giới hạn số agent, giao phạm vi hẹp và rõ.',
      ],
    });
  }

  // 3. Tool errors per project.
  const errs = all(`SELECT project, SUM(tool_errors) errs, COUNT(*) sessions FROM sessions WHERE ended_at >= ?
    GROUP BY project HAVING errs >= ? OR (errs >= 10 AND 1.0 * errs / sessions >= ?) ORDER BY errs DESC LIMIT 6`,
  since, R.toolErrMin, R.toolErrPerSession);
  if (errs.length) {
    const n = errs.reduce((a, r) => a + r.errs, 0);
    tips.push({
      id: 'tool_errors', level: errs.some((r) => r.errs / r.sessions >= R.toolErrPerSession * 2) ? 'high' : 'medium',
      title: `${n} lần tool lỗi ở ${errs.length} project`,
      detail: 'Mỗi lần tool lỗi tốn thêm một lượt gọi (gửi lại toàn bộ ngữ cảnh) để thử lại.',
      items: errs.map((r) => ({ label: r.project, project: r.project, note: `${r.errs} lỗi / ${r.sessions} session` })),
      actions: [
        'Mở project → “Tool hay dùng” để biết tool nào lỗi nhiều (Bash, Edit…).',
        'Ghi lệnh build/test đúng cho Windows và đường dẫn đặc biệt vào `CLAUDE.md` của project.',
        'Lỗi do bị từ chối quyền → thêm allowlist (`/fewer-permission-prompts` hoặc `.claude/settings.json`).',
      ],
    });
  }

  // 4. Low cache hit per project.
  const cache = all(`SELECT project, SUM(cost_usd) cost, 1.0 * SUM(cache_read) / NULLIF(SUM(input + cache_read + cache_write), 0) hit
    FROM usage WHERE day >= ? GROUP BY project HAVING cost >= ? AND hit < ? ORDER BY cost DESC LIMIT 6`, d, R.cacheMinCost, R.cacheLow);
  if (cache.length) {
    tips.push({
      id: 'cache', level: cache.some((r) => r.hit < 0.5) ? 'high' : 'medium',
      title: `Cache hit thấp ở ${cache.length} project`,
      detail: `Token đọc từ cache rẻ hơn nhiều so với token input thường. Mục tiêu: ≥ ${pct(R.cacheLow)}%.`,
      items: cache.map((r) => ({ label: r.project, project: r.project, cost: r.cost, note: `cache ${pct(r.hit ?? 0)}%` })),
      actions: [
        'Cache hết hạn khi nghỉ lâu giữa các lượt — gom câu hỏi lại, tránh để session treo rồi quay lại.',
        'Tránh đổi model / sửa `CLAUDE.md` / bật-tắt MCP giữa session (làm mất cache prefix).',
        'Nhiều session rất ngắn → mỗi session phải ghi cache từ đầu; cân nhắc gộp việc liên quan.',
      ],
    });
  }

  // 5. Repeated prompts → candidates for slash commands / skills.
  const groups = new Map();
  for (const p of all('SELECT project, text FROM prompts WHERE ts >= ?', since)) {
    const k = normPrompt(p.text ?? '');
    if (isNoisePrompt(k)) continue;
    const g = groups.get(k) ?? { text: p.text.trim().slice(0, 160), n: 0, projects: new Set() };
    g.n++; g.projects.add(p.project); groups.set(k, g);
  }
  const reps = [...groups.values()].filter((g) => g.n >= R.repeatMin).sort((a, b) => b.n - a.n).slice(0, 8);
  if (reps.length) {
    tips.push({
      id: 'repeat', level: 'info',
      title: `${reps.length} prompt bạn gõ lặp lại`,
      detail: `Các câu gõ ≥ ${R.repeatMin} lần — ứng viên để biến thành slash command / skill / hook.`,
      items: reps.map((g) => ({ label: g.text, project: g.projects.size === 1 ? [...g.projects][0] : null,
        note: `${g.n} lần${g.projects.size > 1 ? ` · ${g.projects.size} project` : ''}` })),
      actions: [
        'Tạo `.claude/commands/<tên>.md` chứa quy trình đầy đủ (kèm `model: sonnet` nếu là việc đơn giản).',
        'Việc lặp lại sau mỗi lần sửa (restart server, deploy…) → cân nhắc hook hoặc script npm.',
      ],
    });
  }

  // 6. Long, expensive sessions: every turn re-sends the whole context.
  const long = all(`SELECT project, title, n_prompts, cost_usd cost FROM sessions WHERE ended_at >= ? AND n_prompts >= ? AND cost_usd >= ?
    ORDER BY cost_usd DESC LIMIT 6`, since, R.longPrompts, R.longCost);
  if (long.length) {
    tips.push({
      id: 'long', level: 'medium',
      title: `${long.length} session dài và tốn kém`,
      detail: `Session ≥ ${R.longPrompts} prompt và ≥ $${R.longCost}: ngữ cảnh càng dài, mỗi lượt càng đắt.`,
      items: long.map((r) => ({ label: r.title ?? '(không tiêu đề)', project: r.project, cost: r.cost, note: `${r.n_prompts} prompt` })),
      actions: [
        'Chuyển sang việc khác → `/clear`; cần giữ ý chính → `/compact`.',
        'Kết thúc giữa chừng → viết handoff ngắn rồi mở session mới.',
      ],
    });
  }

  const order = { high: 0, medium: 1, info: 2 };
  return { days, total, rules: R, tips: tips.sort((a, b) => order[a.level] - order[b.level]) };
}

function settings() {
  const c = loadConfig();
  const ai = aiConfig(c);
  const providers = Object.fromEntries(Object.entries(PROVIDERS).map(([id, meta]) => {
    const key = getApiKey(id), st = ai.providers[id] ?? {};
    return [id, { ...meta, hasKey: !!key, keyHint: keyHint(key), settings: st, ready: providerReady(id, key, st) }];
  }));
  return { active: activeProvider(c).id, ready: activeProvider(c).ready, providers, efforts: EFFORTS,
    language: ai.language };
}

// Merge non-secret provider settings (model, endpoint, baseUrl…) from the request.
function applyProviderSettings(c, id, incoming = {}) {
  const ai = aiConfig(c);
  const cur = { ...(ai.providers[id] ?? {}) };
  const allowed = ['model', ...PROVIDERS[id].fields.map((f) => f.name), ...(PROVIDERS[id].effort ? ['effort'] : [])];
  for (const k of allowed) if (typeof incoming[k] === 'string') cur[k] = incoming[k].trim().slice(0, 300);
  if (cur.effort && !EFFORTS.includes(cur.effort)) delete cur.effort;
  for (const f of PROVIDERS[id].fields) if (!cur[f.name] && f.default) cur[f.name] = f.default;
  ai.providers[id] = cur;
  return cur;
}

const errText = (e) => (e instanceof ProviderError ? e.message : `Lỗi: ${e.message}`);

async function readJson(req) {
  let body = '';
  for await (const chunk of req) { body += chunk; if (body.length > 1e5) throw new Error('body too large'); }
  return body ? JSON.parse(body) : {};
}

// Mutating requests must come from our own page: custom header (forces CORS preflight, which we never answer)
// + Origin, when present, must be this server.
function trusted(req, port) {
  if (req.headers['x-brain'] !== '1') return false;
  const o = req.headers.origin;
  return !o || o === `http://localhost:${port}` || o === `http://127.0.0.1:${port}`;
}

const send = (res, code, body, type = 'application/json; charset=utf-8') => {
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  if (req.method !== 'GET' && !trusted(req, port)) return send(res, 403, { error: 'forbidden' });
  try {
    if (p === '/' || p === '/index.html') return send(res, 200, readFileSync(join(HOME, 'public', 'index.html'), 'utf8'), 'text/html; charset=utf-8');
    if (p === '/api/status') return send(res, 200, { app: 'personal-brain', pid: process.pid, version: VERSION, installed: readCommit(),
      background: process.env.BRAIN_BG === '1', ingesting: state.ingesting, lastIngest: state.lastIngest, lastResult: state.lastResult, summarizing: [...state.summarizing], hasKey: activeProvider().ready, provider: activeProvider().id });
    if (p === '/api/settings' && req.method === 'GET') return send(res, 200, settings());
    // body: { provider?, apiKey?, clearKey?, settings?: {model, effort, endpoint, baseUrl, apiVersion}, activate?, language? }
    if (p === '/api/settings' && req.method === 'POST') {
      const b = await readJson(req);
      const c = loadConfig();
      const ai = aiConfig(c);
      const id = b.provider;
      if (id !== undefined && !PROVIDERS[id]) return send(res, 400, { error: 'Provider không hợp lệ' });
      if (id) {
        const st = applyProviderSettings(c, id, b.settings);
        if (b.clearKey) setApiKey(id, null);
        const newKey = typeof b.apiKey === 'string' ? b.apiKey.trim() : '';
        if (newKey || (b.verify && PROVIDERS[id].keyOptional)) {
          try { await listModels(id, newKey || getApiKey(id), st); } // verify before saving
          catch (e) { return send(res, 400, { error: errText(e) }); }
          if (newKey) setApiKey(id, newKey);
        }
        if (b.activate) ai.active = id;
      }
      if (typeof b.language === 'string' && b.language.trim()) ai.language = b.language.trim().slice(0, 40);
      delete c.summary;
      saveConfig(c);
      return send(res, 200, settings());
    }
    // List models with the saved key (also a connectivity / key check). body: { provider, settings? }
    if (p === '/api/settings/models' && req.method === 'POST') {
      const b = await readJson(req);
      if (!PROVIDERS[b.provider]) return send(res, 400, { error: 'Provider không hợp lệ' });
      const st = { ...(aiConfig(loadConfig()).providers[b.provider] ?? {}), ...(b.settings ?? {}) };
      const key = getApiKey(b.provider);
      if (!key && !PROVIDERS[b.provider].keyOptional) return send(res, 400, { error: 'Chưa có API key' });
      try { return send(res, 200, { models: await listModels(b.provider, key, st) }); }
      catch (e) { return send(res, 400, { error: errText(e) }); }
    }
    if (p === '/api/usage') return send(res, 200, usage(Number(url.searchParams.get('days') ?? 30)));
    if (p === '/api/insights') return send(res, 200, insights(Number(url.searchParams.get('days') ?? 30)));
    if (p === '/api/projects') return send(res, 200, projects());
    if (p === '/api/activity') return send(res, 200, activity(url.searchParams.get('name'), Number(url.searchParams.get('days') ?? 182)));
    if (p === '/api/project') return send(res, 200, project(url.searchParams.get('name') ?? ''));
    if (p === '/api/kit') return send(res, 200, kit());
    if (p === '/api/profile') return send(res, 200, profile(db).map(({ path, ...k }) => k));
    if (p === '/api/extensions') return send(res, 200, extensionsOverview(db, { since: sinceMs(Number(url.searchParams.get('days') ?? 0)) }));
    if (p === '/api/extension') {
      const e = get('SELECT path, kind, name, scope, project, description, outline, meta, content, mtime FROM extensions WHERE path = ?', url.searchParams.get('path') ?? '');
      return e ? send(res, 200, { ...e, meta: JSON.parse(e.meta || '{}') }) : send(res, 404, { error: 'Không tìm thấy' });
    }
    if (p === '/api/search') return send(res, 200, search(url.searchParams.get('q') ?? ''));
    if (p === '/api/refresh' && req.method === 'POST') { await runIngest(); return send(res, 200, { ok: true, ...state.lastResult }); }
    if (p === '/api/summarize' && req.method === 'POST') {
      const name = url.searchParams.get('name') ?? '';
      if (!get('SELECT 1 FROM sessions WHERE project = ? UNION SELECT 1 FROM knowledge WHERE project = ?', name, name))
        return send(res, 404, { error: 'Không có dữ liệu cho project này' });
      if (!activeProvider().ready) return send(res, 403, { error: 'Chưa cấu hình AI provider (API key / model) — vào ⚙ Cài đặt.', code: 'no_key' });
      if (state.summarizing.has(name)) return send(res, 409, { error: 'Đang tóm tắt…' });
      state.summarizing.add(name);
      try { return send(res, 200, { ok: true, content: await summarizeProject(name) }); }
      catch (e) {
        if (e instanceof NoApiKeyError) return send(res, 403, { error: e.message, code: 'no_key' });
        if (e instanceof ProviderError) return send(res, e.status === 401 ? 401 : e.status === 429 ? 429 : 502, { error: `${PROVIDERS[activeProvider().id].label}: ${e.message}` });
        throw e;
      }
      finally { state.summarizing.delete(name); }
    }
    send(res, 404, { error: 'not found' });
  } catch (e) {
    console.error(e);
    send(res, 500, { error: e.message });
  }
});

const appUrl = `http://localhost:${port}`;
function openBrowser() {
  if (!process.argv.includes('--open')) return;
  const [cmd, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', appUrl]]
    : process.platform === 'darwin' ? ['open', [appUrl]] : ['xdg-open', [appUrl]];
  spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') { // already running → just open the existing dashboard
    console.log(`Personal Brain đã chạy ở ${appUrl}`);
    openBrowser();
    setTimeout(() => process.exit(0), 500);
  } else { console.error(e); process.exit(1); }
});
server.listen(port, '127.0.0.1', () => {
  console.log(process.env.BRAIN_BG === '1'
    ? `${new Date().toISOString()} Personal Brain${VERSION ? ` ${VERSION}` : ''} → ${appUrl} (nền, pid ${process.pid})`
    : `Personal Brain → ${appUrl}  (Ctrl+C để dừng)`);
  openBrowser();
  runIngest();
  setInterval(runIngest, (cfg.refreshMinutes ?? 10) * 60e3).unref();
});
