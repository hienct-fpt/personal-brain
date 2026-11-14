// Summarize one project with the active AI provider (Claude, OpenAI, Gemini, Azure, OpenAI-compatible) → summaries table.
// Requires the provider's API key registered in the dashboard (⚙ Cài đặt) — see secrets.mjs / providers.mjs.
// Usage: node --no-warnings summarize.mjs "<project>"
import { pathToFileURL } from 'node:url';
import { openDb, loadConfig, localDay } from '../core/lib.mjs';
import { rebuildSearchIndex } from '../query/query.mjs';
import { getApiKey } from '../core/secrets.mjs';
import { PROVIDERS, generateJson, providerReady } from './providers.mjs';

// config.ai (migrates the v0.5 `summary` block on first read)
export function aiConfig(cfg) {
  if (!cfg.ai) {
    const s = cfg.summary ?? {};
    cfg.ai = { active: 'anthropic', language: s.language ?? 'Tiếng Việt', maxSessions: s.maxSessions ?? 40,
      providers: { anthropic: { model: s.model ?? 'claude-opus-5-5', effort: s.effort ?? 'medium' } } };
  }
  cfg.ai.providers ??= {};
  return cfg.ai;
}

const clip = (s, n) => (s && s.length > n ? s.slice(0, n) + '…' : s ?? '');

export function buildContext(db, project, cfg) {
  const max = aiConfig(cfg).maxSessions ?? 40;
  const sessions = db.prepare(`SELECT id, title, started_at, ended_at, n_prompts, cost_usd, files_edited
    FROM sessions WHERE project = ? ORDER BY started_at DESC LIMIT ?`).all(project, max);
  const out = [`# Project: ${project}`, `Hôm nay: ${localDay(Date.now())}`, '', '## Sessions (mới nhất trước)'];
  for (const s of sessions) {
    out.push(`### ${localDay(s.started_at)} → ${localDay(s.ended_at)} · ${s.title ?? '(no title)'} · ${s.n_prompts} prompt`);
    const ps = db.prepare('SELECT text FROM prompts WHERE session_id = ? ORDER BY ts').all(s.id);
    for (const p of ps.slice(0, 6)) out.push(`- ${clip(p.text.replace(/\s+/g, ' '), 300)}`);
    if (ps.length > 6) out.push(`- … (+${ps.length - 6} prompt) · cuối: ${clip(ps.at(-1).text.replace(/\s+/g, ' '), 200)}`);
    const files = JSON.parse(s.files_edited ?? '[]');
    if (files.length) out.push(`  Files sửa: ${files.slice(0, 12).map((f) => f.split('/').slice(-2).join('/')).join(', ')}`);
  }
  const know = db.prepare('SELECT type, name, description, content FROM knowledge WHERE project = ? ORDER BY mtime DESC LIMIT 25').all(project);
  if (know.length) {
    out.push('', '## Memory/knowledge đã lưu');
    for (const k of know) out.push(`### ${k.type ? `[${k.type}] ` : ''}${k.name} — ${k.description}`, clip(k.content, 1200));
  }
  return out.join('\n');
}

export const EFFORTS = ['low', 'medium', 'high'];

const SYSTEM = (lang) => `Bạn là trợ lý tổng hợp "personal brain" cho một kỹ sư/PM. Người dùng gửi lịch sử làm việc với Claude Code
của MỘT project (session, prompt, file đã sửa, memory đã lưu). Hãy tóm tắt bằng ${lang}: ngắn, cụ thể, nêu tên file/feature/khách hàng khi có.
Chỉ dùng thông tin có trong dữ liệu, không suy diễn thêm.
- headline: 1 câu — project là gì, đang ở giai đoạn nào
- current: việc đang làm / đang dở gần nhất (tối đa 5)
- done: việc đã hoàn thành, mới nhất trước, when = YYYY-MM-DD (tối đa 10)
- decisions: quyết định/quy ước đã chốt (tối đa 8)
- knowledge: kiến thức kỹ thuật/nghiệp vụ quan trọng: kiến trúc, công nghệ, thuật ngữ, cạm bẫy (tối đa 10)
- open: việc còn mở / rủi ro / câu hỏi chưa trả lời (tối đa 5)`;

const strList = { type: 'array', items: { type: 'string' } };
const SCHEMA = {
  type: 'object',
  properties: {
    headline: { type: 'string' },
    current: strList,
    done: { type: 'array', items: { type: 'object', properties: { when: { type: 'string' }, text: { type: 'string' } }, required: ['when', 'text'], additionalProperties: false } },
    decisions: strList,
    knowledge: strList,
    open: strList,
  },
  required: ['headline', 'current', 'done', 'decisions', 'knowledge', 'open'],
  additionalProperties: false,
};

export class NoApiKeyError extends Error {}

export function activeProvider(cfg = loadConfig()) {
  const ai = aiConfig(cfg);
  const id = PROVIDERS[ai.active] ? ai.active : 'anthropic';
  const settings = ai.providers[id] ?? {};
  const key = getApiKey(id);
  return { id, settings, key, ready: providerReady(id, key, settings) };
}

// Normalize whatever the model returned into the expected shape (non-Claude models may drift from the schema).
function normalize(o) {
  const arr = (v) => (Array.isArray(v) ? v.map((x) => (typeof x === 'string' ? x : x?.text ?? JSON.stringify(x))) : []);
  return {
    headline: typeof o?.headline === 'string' ? o.headline : '',
    current: arr(o?.current), decisions: arr(o?.decisions), knowledge: arr(o?.knowledge), open: arr(o?.open),
    done: Array.isArray(o?.done) ? o.done.map((x) => (typeof x === 'string' ? { when: '', text: x } : { when: String(x?.when ?? ''), text: String(x?.text ?? '') })) : [],
  };
}

export async function summarizeProject(project) {
  const cfg = loadConfig();
  const p = activeProvider(cfg);
  if (!p.ready) throw new NoApiKeyError(`Chưa cấu hình đủ ${PROVIDERS[p.id].label} (API key / model) — vào ⚙ Cài đặt.`);
  const db = openDb();
  try {
    const r = await generateJson(p.id, { key: p.key, settings: p.settings, system: SYSTEM(aiConfig(cfg).language),
      user: buildContext(db, project, cfg), schema: SCHEMA });
    const content = normalize(r.data);
    content._usage = { ...r.usage, provider: r.provider };
    db.prepare('INSERT OR REPLACE INTO summaries VALUES (?,?,?,?)').run(project, Date.now(), r.model, JSON.stringify(content));
    db.exec('BEGIN');
    try { rebuildSearchIndex(db); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; }
    return content;
  } finally { db.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const p = process.argv[2];
  if (!p) { console.error('Usage: summarize.mjs "<project>"'); process.exit(1); }
  console.log(JSON.stringify(await summarizeProject(p), null, 2));
}
