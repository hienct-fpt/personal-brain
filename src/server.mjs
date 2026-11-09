// Personal Brain dashboard server (zero deps). Usage: node --no-warnings server.mjs
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { openDb, loadConfig, saveConfig, localDay, HOME } from './lib.mjs';
import { getApiKey, setApiKey, keyHint } from './secrets.mjs';
import { PROVIDERS, ProviderError, listModels, providerReady } from './providers.mjs';
import { ingest } from './ingest.mjs';
import { summarizeProject, NoApiKeyError, EFFORTS, aiConfig, activeProvider } from './summarize.mjs';

const cfg = loadConfig();
const db = openDb();
const port = Number(process.env.BRAIN_PORT ?? cfg.port);
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
  const savings = get('SELECT COALESCE(SUM(tokens_saved),0) tokens, COALESCE(SUM(cost_usd),0) cost, COALESCE(SUM(events),0) events FROM savings WHERE day >= ?', d);
  return {
    totals, sessions: sess, savings,
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
    savingsDaily: all('SELECT day, SUM(tokens_saved) tokens, SUM(cost_usd) cost FROM savings WHERE day >= ? GROUP BY day ORDER BY day', d),
  };
}

// Daily activity = prompts typed (transcript) merged with EMT prompt events (max per project-day, they overlap).
const ACTIVITY_SQL = `
  SELECT project, day, MAX(p) prompts FROM (
    SELECT project, date(ts/1000, 'unixepoch', 'localtime') day, COUNT(*) p FROM prompts GROUP BY 1, 2
    UNION ALL SELECT project, day, prompts FROM emt_daily) GROUP BY project, day`;

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
    WITH names AS (SELECT project FROM sessions UNION SELECT project FROM emt UNION SELECT project FROM knowledge)
    SELECT n.project,
      (SELECT COUNT(*) FROM sessions s WHERE s.project = n.project) sessions,
      (SELECT COALESCE(SUM(n_prompts),0) FROM sessions s WHERE s.project = n.project) prompts,
      (SELECT COALESCE(SUM(cost_usd),0) FROM sessions s WHERE s.project = n.project) cost,
      (SELECT MAX(ended_at) FROM sessions s WHERE s.project = n.project) last_session,
      (SELECT MIN(started_at) FROM sessions s WHERE s.project = n.project) first_session,
      (SELECT MAX(last_ts) FROM emt e WHERE e.project = n.project) last_emt,
      (SELECT MIN(day) FROM emt_daily e WHERE e.project = n.project) first_emt_day,
      (SELECT COALESCE(SUM(sessions),0) FROM emt e WHERE e.project = n.project) emt_sessions,
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
    r.last_active = Math.max(r.last_session ?? 0, r.last_emt ?? 0) || null;
    r.first_active = Math.min(r.first_session ?? Infinity, r.first_emt_day ? Date.parse(r.first_emt_day) : Infinity);
    if (!Number.isFinite(r.first_active)) r.first_active = null;
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
    knowledge: all('SELECT name, description, content, mtime FROM knowledge WHERE project = ? ORDER BY mtime DESC', name),
    daily: all('SELECT day, SUM(cost_usd) cost FROM usage WHERE project = ? GROUP BY day ORDER BY day', name),
    byModel: all('SELECT model, SUM(cost_usd) cost FROM usage WHERE project = ? GROUP BY model ORDER BY cost DESC', name),
    emt: get(`SELECT COALESCE(SUM(sessions),0) sessions, COALESCE(SUM(observations),0) observations, COALESCE(SUM(prompts),0) prompts,
      COALESCE(SUM(tool_failures),0) tool_failures, COALESCE(SUM(subagents),0) subagents, MAX(last_ts) last FROM emt WHERE project = ?`, name),
    savings: get('SELECT COALESCE(SUM(tokens_saved),0) tokens, COALESCE(SUM(cost_usd),0) cost FROM savings WHERE project = ?', name),
  };
}

function search(q) {
  const like = `%${q}%`;
  return {
    sessions: all('SELECT id, project, title, started_at FROM sessions WHERE title LIKE ? ORDER BY started_at DESC LIMIT 20', like),
    prompts: all('SELECT project, ts, text FROM prompts WHERE text LIKE ? ORDER BY ts DESC LIMIT 40', like),
    knowledge: all('SELECT project, name, description FROM knowledge WHERE name LIKE ? OR description LIKE ? OR content LIKE ? LIMIT 20', like, like, like),
  };
}

function settings() {
  const c = loadConfig();
  const ai = aiConfig(c);
  const providers = Object.fromEntries(Object.entries(PROVIDERS).map(([id, meta]) => {
    const key = getApiKey(id), st = ai.providers[id] ?? {};
    return [id, { ...meta, hasKey: !!key, keyHint: keyHint(key), settings: st, ready: providerReady(id, key, st) }];
  }));
  return { active: activeProvider(c).id, ready: activeProvider(c).ready, providers, efforts: EFFORTS,
    language: ai.language, importEmt: c.importEmt !== false };
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
    if (p === '/api/status') return send(res, 200, { ingesting: state.ingesting, lastIngest: state.lastIngest, lastResult: state.lastResult, summarizing: [...state.summarizing], hasKey: activeProvider().ready, provider: activeProvider().id });
    if (p === '/api/settings' && req.method === 'GET') return send(res, 200, settings());
    // body: { provider?, apiKey?, clearKey?, settings?: {model, effort, endpoint, baseUrl, apiVersion}, activate?, language?, importEmt? }
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
      if (typeof b.importEmt === 'boolean') c.importEmt = b.importEmt;
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
    if (p === '/api/projects') return send(res, 200, projects());
    if (p === '/api/activity') return send(res, 200, activity(url.searchParams.get('name'), Number(url.searchParams.get('days') ?? 182)));
    if (p === '/api/project') return send(res, 200, project(url.searchParams.get('name') ?? ''));
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
  console.log(`Personal Brain → ${appUrl}  (Ctrl+C để dừng)`);
  openBrowser();
  runIngest();
  setInterval(runIngest, (cfg.refreshMinutes ?? 10) * 60e3).unref();
});
