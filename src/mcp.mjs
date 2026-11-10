// Read-only MCP server (stdio, JSON-RPC, zero deps): lets Claude Code look things up in brain.db.
//   claude mcp add --scope user personal-brain -- node --no-warnings <install dir>/mcp.mjs
// stdout is the protocol channel — log only to stderr.
import { createInterface } from 'node:readline';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { openDb, loadConfig, projectOf, localDay, HOME } from './lib.mjs';
import { search, ensureSearchIndex, resolveProject, projectBrief, recent } from './query.mjs';

const cfg = loadConfig();
const db = openDb();
db.exec('BEGIN'); ensureSearchIndex(db); db.exec('COMMIT');
const VERSION = (() => { try { return JSON.parse(readFileSync(join(HOME, 'version.json'), 'utf8')).version; } catch { return 'dev'; } })();
// Project of the Claude Code session that launched us (default for brain_project).
const HERE = projectOf(process.env.CLAUDE_PROJECT_DIR ?? process.cwd(), cfg);

const clip = (s, n) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n) + '…' : t; };
const money = (x) => `$${(x ?? 0).toFixed(2)}`;
const KIND = { session: 'Session', prompt: 'Prompt', knowledge: 'Knowledge', summary: 'Tóm tắt AI' };

const TOOLS = [
  {
    name: 'brain_search',
    description: 'Tìm trong lịch sử làm việc với Claude Code của người dùng (tiêu đề session, prompt đã gõ, knowledge/memory, tóm tắt AI theo project). '
      + 'Dùng khi người dùng hỏi "lần trước…", "tôi đã từng…", "đã quyết định gì về…", hoặc khi cần ngữ cảnh từ các session trước. '
      + 'Không phân biệt dấu tiếng Việt, khớp đầu từ, xếp theo độ liên quan.',
    inputSchema: { type: 'object', properties: {
      query: { type: 'string', description: 'Từ khoá (tiếng Việt có/không dấu hoặc tiếng Anh)' },
      project: { type: 'string', description: 'Chỉ tìm trong project này (tuỳ chọn)' },
      kinds: { type: 'array', items: { enum: ['session', 'prompt', 'knowledge', 'summary'] }, description: 'Lọc loại kết quả (tuỳ chọn)' },
      limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Số kết quả tối đa (mặc định 15)' },
    }, required: ['query'] },
  },
  {
    name: 'brain_project',
    description: 'Tổng hợp về một project: tóm tắt AI (đang làm, đã làm, quyết định, việc còn mở), knowledge, session gần đây, file hay sửa. '
      + `Bỏ trống name = project hiện tại (${HERE}). Tên không khớp thì trả danh sách project.`,
    inputSchema: { type: 'object', properties: { name: { type: 'string', description: 'Tên project (khớp gần đúng được)' } } },
  },
  {
    name: 'brain_recent',
    description: 'Các session Claude Code gần đây, nhóm theo ngày: "tuần này tôi làm gì", "hôm qua làm gì".',
    inputSchema: { type: 'object', properties: {
      days: { type: 'integer', minimum: 1, maximum: 365, description: 'Số ngày gần nhất (mặc định 7)' },
      project: { type: 'string', description: 'Chỉ project này (tuỳ chọn)' },
    } },
  },
].map((t) => ({ ...t, annotations: { readOnlyHint: true, openWorldHint: false } }));

function brainSearch({ query, project, kinds, limit = 15 }) {
  if (!String(query ?? '').trim()) throw new Error('Thiếu query');
  const proj = project ? resolveProject(db, project).name ?? project : null;
  const hits = search(db, query, { project: proj, kinds, limit: Math.min(Number(limit) || 15, 50) });
  if (!hits.length) return `Không tìm thấy gì cho "${query}"${proj ? ` trong ${proj}` : ''}.`;
  return hits.map((h) => `- [${KIND[h.kind]}] ${h.project} · ${h.ts ? localDay(h.ts) : '?'}${h.title && h.kind !== 'summary' ? ` · ${clip(h.title, 100)}` : ''}`
    + (h.kind === 'session' ? '' : `\n  ${clip(h.snippet, 400)}`)).join('\n');
}

function brainProject({ name } = {}) {
  const r = resolveProject(db, name || HERE);
  if (!r.name) return `Không có project "${name || HERE}". Các project: ${r.candidates.slice(0, 60).join(', ')}`;
  const b = projectBrief(db, r.name);
  const out = [`# ${b.project}`, `${b.sessions} session · ${b.first ? localDay(b.first) : '?'} → ${b.last ? localDay(b.last) : '?'} · ${money(b.cost)}`];
  const list = (title, xs) => { if (xs?.length) out.push(`\n## ${title}`, ...xs.map((x) => `- ${x}`)); };
  if (b.summary) {
    out.push(`\n## Tóm tắt AI (${localDay(b.summary.generated_at)})`, b.summary.headline ?? '');
    list('Đang làm', b.summary.current);
    list('Đã làm', b.summary.done?.map((d) => `${d.when}: ${d.text}`));
    list('Quyết định', b.summary.decisions);
    list('Knowledge (tóm tắt)', b.summary.knowledge);
    list('Còn mở', b.summary.open);
  } else out.push('\n(Chưa có tóm tắt AI — chạy `brain summarize "<project>"` hoặc bấm tóm tắt trên dashboard.)');
  list('Knowledge (memory)', b.knowledge.map((k) => `**${k.name}** — ${k.description}\n  ${clip(k.content, 600)}`));
  list('Session gần đây', b.recent.map((s) => `${localDay(s.started_at)} · ${clip(s.title, 100)} (${s.n_prompts} prompt)`));
  list('File hay sửa', b.files.map(([f, n]) => `${f} (${n} session)`));
  list('Prompt gần nhất', b.prompts.map((p) => `${localDay(p.ts)}: ${clip(p.text, 200)}`));
  return out.join('\n');
}

function brainRecent({ days = 7, project } = {}) {
  const proj = project ? resolveProject(db, project).name ?? project : null;
  const rows = recent(db, Math.min(Number(days) || 7, 365), proj);
  if (!rows.length) return `Không có session nào trong ${days} ngày qua${proj ? ` ở ${proj}` : ''}.`;
  const byDay = new Map();
  for (const s of rows) { if (!byDay.has(s.day)) byDay.set(s.day, []); byDay.get(s.day).push(s); }
  return [...byDay].map(([d, ss]) => `## ${d}\n` + ss.map((s) => `- ${s.project} · ${clip(s.title, 100)} (${s.n_prompts} prompt, ${money(s.cost_usd)})`).join('\n')).join('\n\n');
}

const HANDLERS = { brain_search: brainSearch, brain_project: brainProject, brain_recent: brainRecent };

function handle(msg) {
  const { method, params } = msg;
  if (method === 'initialize') return {
    protocolVersion: params?.protocolVersion ?? '2025-06-18',
    capabilities: { tools: {} },
    serverInfo: { name: 'personal-brain', version: VERSION },
    instructions: 'Bộ nhớ cá nhân: lịch sử các session Claude Code trước đây của người dùng (prompt, knowledge, tóm tắt AI theo project). '
      + 'Tra ở đây khi người dùng nhắc tới việc đã làm trước đó hoặc khi cần ngữ cảnh/quyết định cũ của project. Chỉ đọc.',
  };
  if (method === 'ping') return {};
  if (method === 'tools/list') return { tools: TOOLS };
  if (method === 'tools/call') {
    const fn = HANDLERS[params?.name];
    if (!fn) throw Object.assign(new Error(`Không có tool ${params?.name}`), { code: -32602 });
    try { return { content: [{ type: 'text', text: fn(params.arguments ?? {}) }] }; }
    catch (e) { return { content: [{ type: 'text', text: `Lỗi: ${e.message}` }], isError: true }; }
  }
  throw Object.assign(new Error(`Method not found: ${method}`), { code: -32601 });
}

const reply = (o) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...o }) + '\n');
createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return reply({ id: null, error: { code: -32700, message: 'Parse error' } }); }
  if (msg.id === undefined || msg.id === null) return; // notification
  try { reply({ id: msg.id, result: handle(msg) }); }
  catch (e) { reply({ id: msg.id, error: { code: e.code ?? -32603, message: e.message } }); }
}).on('close', () => { db.close(); process.exit(0); });
