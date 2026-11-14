// Read-only MCP server (stdio, JSON-RPC, zero deps): lets Claude Code look things up in brain.db.
//   claude mcp add --scope user personal-brain -- node --no-warnings <install dir>/mcp.mjs
// stdout is the protocol channel — log only to stderr.
import { createInterface } from 'node:readline';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { openDb, loadConfig, projectOf, localDay, HOME } from './core/lib.mjs';
import { search, ensureSearchIndex, resolveProject, projectBrief, recent, profile, promptNeighbors, timeHint } from './query/query.mjs';
import { related } from './query/entities.mjs';

const cfg = loadConfig();
const db = openDb();
db.exec('BEGIN'); ensureSearchIndex(db); db.exec('COMMIT');
const VERSION = (() => { try { return JSON.parse(readFileSync(join(HOME, 'version.json'), 'utf8')).version; } catch { return 'dev'; } })();
// Project of the Claude Code session that launched us (default for brain_project).
const HERE = projectOf(process.env.CLAUDE_PROJECT_DIR ?? process.cwd(), cfg);

const clip = (s, n) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n) + '…' : t; };
const money = (x) => `$${(x ?? 0).toFixed(2)}`;
const KIND = { session: 'Session', prompt: 'Prompt', knowledge: 'Knowledge', summary: 'Tóm tắt AI', extension: 'Skill/agent/command' };
const TYPE = { user: 'về người dùng', feedback: 'góp ý/cách làm', project: 'project', reference: 'tham chiếu' };
const typeTag = (t) => (t ? ` (${TYPE[t] ?? t})` : '');

// 'YYYY-MM-DD' (local day) → epoch ms at the start (or the end) of that day.
function parseDay(s, end = false) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s).trim());
  const d = m && new Date(+m[1], +m[2] - 1, +m[3]);
  if (!d || d.getMonth() !== +m[2] - 1 || d.getDate() !== +m[3]) throw new Error(`Ngày không hợp lệ: "${s}" (dạng YYYY-MM-DD)`);
  if (end) d.setHours(23, 59, 59, 999);
  return d.getTime();
}

const TOOLS = [
  {
    name: 'brain_search',
    description: 'Tìm trong lịch sử làm việc với Claude Code của người dùng (tiêu đề session, prompt đã gõ, knowledge/memory, tóm tắt AI theo project, skill/agent/slash command đã cài). '
      + 'Dùng khi người dùng hỏi "lần trước…", "tôi đã từng…", "đã quyết định gì về…", hoặc khi cần ngữ cảnh từ các session trước. '
      + 'Không phân biệt dấu tiếng Việt, khớp đầu từ, xếp theo độ liên quan (ưu tiên kết quả gần đây). '
      + 'Câu hỏi có mốc thời gian ("tuần trước", "tháng 10") thì đặt since/until hoặc days; nếu không đặt, mốc thời gian viết trong query '
      + '(hôm qua, tuần trước, tháng 9, 3 ngày qua, last month, 2026-10…) được tự hiểu và bỏ khỏi từ khoá. '
      + 'Kết quả loại prompt kèm prompt ngay trước/sau trong cùng session để rõ ngữ cảnh.',
    inputSchema: { type: 'object', properties: {
      query: { type: 'string', description: 'Từ khoá (tiếng Việt có/không dấu hoặc tiếng Anh)' },
      project: { type: 'string', description: 'Chỉ tìm trong project này (tuỳ chọn)' },
      kinds: { type: 'array', items: { enum: ['session', 'prompt', 'knowledge', 'summary', 'extension'] }, description: 'Lọc loại kết quả (tuỳ chọn)' },
      since: { type: 'string', description: 'Từ ngày (YYYY-MM-DD, tính cả ngày đó, giờ máy người dùng) — tuỳ chọn' },
      until: { type: 'string', description: 'Đến ngày (YYYY-MM-DD, tính cả ngày đó) — tuỳ chọn' },
      days: { type: 'integer', minimum: 1, maximum: 3650, description: 'Chỉ N ngày gần nhất (dùng khi không có since) — tuỳ chọn' },
      limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Số kết quả tối đa (mặc định 15)' },
      context: { type: 'boolean', description: 'Kèm prompt trước/sau cho 5 kết quả prompt đầu (mặc định true)' },
    }, required: ['query'] },
  },
  {
    name: 'brain_related',
    description: 'Những gì hay đi cùng một file / ticket (ABC-123, #123) / skill·agent·slash command / tên hàm trong lịch sử làm việc: '
      + 'file, ticket, skill, identifier xuất hiện chung session/memory, kèm các session có nhắc tới nó. '
      + 'Dùng khi hỏi "X liên quan tới gì", "sửa X thì thường đụng file nào", "ticket này đã làm ở session nào".',
    inputSchema: { type: 'object', properties: {
      entity: { type: 'string', description: 'Tên file (vd. query.mjs), mã ticket, tên skill/command, hoặc identifier' },
      project: { type: 'string', description: 'Chỉ trong project này (tuỳ chọn)' },
      limit: { type: 'integer', minimum: 1, maximum: 20, description: 'Số mục tối đa mỗi loại (mặc định 8)' },
    }, required: ['entity'] },
  },
  {
    name: 'brain_profile',
    description: 'Những gì đã ghi nhớ về người dùng, gom từ memory của mọi project: vai trò, sở thích (type user) và góp ý/cách làm việc họ muốn (type feedback). '
      + 'Dùng khi cần biết người dùng thích làm việc thế nào, hoặc trước việc mới chưa có ngữ cảnh.',
    inputSchema: { type: 'object', properties: {
      type: { enum: ['user', 'feedback'], description: 'Chỉ một loại (tuỳ chọn)' },
    } },
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

function brainSearch({ query, project, kinds, since, until, days, limit = 15, context = true }) {
  if (!String(query ?? '').trim()) throw new Error('Thiếu query');
  const proj = project ? resolveProject(db, project).name ?? project : null;
  let from = since ? parseDay(since) : Number(days) > 0 ? Date.now() - Math.min(Number(days), 3650) * 864e5 : null;
  let to = until ? parseDay(until, true) : null;
  if (from != null && to != null && from > to) throw new Error('since phải trước until');
  // no explicit window → read a time cue out of the query itself ("tuần trước", "tháng 9"…)
  const hint = from == null && to == null ? timeHint(query) : null;
  let q = query;
  if (hint) {
    if (!/[\p{L}\p{N}]/u.test(hint.rest)) return `Câu hỏi chỉ có mốc thời gian ("${hint.label}") — dùng brain_recent, hoặc thêm từ khoá.`;
    ({ since: from, until: to } = hint); q = hint.rest;
  }
  const hits = search(db, q, { project: proj, kinds, since: from, until: to, limit: Math.min(Number(limit) || 15, 50) });
  const window = from != null || to != null ? ` (${from != null ? localDay(from) : '…'} → ${to != null ? localDay(to) : 'nay'})` : '';
  const note = hint ? `(Hiểu "${hint.label}" là${window}; tìm "${q}". Truyền since/until để đổi.)\n` : '';
  if (!hits.length) return `${note}Không tìm thấy gì cho "${q}"${proj ? ` trong ${proj}` : ''}${window}.`;
  const typeOf = db.prepare('SELECT type FROM knowledge WHERE path = ?');
  let withCtx = context === false ? 0 : 5;
  return note + hits.map((h) => {
    let s = `- [${KIND[h.kind]}${h.kind === 'knowledge' ? typeTag(typeOf.get(h.ref)?.type) : ''}] ${h.project} · ${h.ts ? localDay(h.ts) : '?'}`
      + `${h.title && h.kind !== 'summary' ? ` · ${clip(h.title, 100)}` : ''}`
      + (h.kind === 'session' ? '' : `\n  ${clip(h.snippet, 400)}`);
    if (h.kind === 'prompt' && withCtx-- > 0) {
      const nb = promptNeighbors(db, h.ref, h.ts);
      for (const p of nb.before) s += `\n    ↑ trước: ${clip(p.text, 160)}`;
      for (const p of nb.after) s += `\n    ↓ sau: ${clip(p.text, 160)}`;
    }
    return s;
  }).join('\n');
}

const EKIND = { file: 'File', ticket: 'Ticket', code: 'Identifier', skill: 'Skill', agent: 'Agent', command: 'Slash command' };
function brainRelated({ entity, project, limit = 8 }) {
  if (!String(entity ?? '').trim()) throw new Error('Thiếu entity');
  const proj = project ? resolveProject(db, project).name ?? project : null;
  const r = related(db, entity, { project: proj, limit: Math.min(Number(limit) || 8, 20) });
  if (r.candidates) return `"${entity}" khớp nhiều mục — gọi lại với tên cụ thể:\n`
    + r.candidates.map((c) => `- ${EKIND[c.kind] ?? c.kind}: ${c.name} (${c.units} lần)`).join('\n');
  if (!r.matched.length) return `Không thấy "${entity}"${proj ? ` trong ${proj}` : ''} trong lịch sử (chỉ nhận file, ticket, skill/agent/command, \`identifier\`). Thử brain_search.`;
  const out = [`# ${r.matched.map((m) => `${EKIND[m.kind] ?? m.kind} ${m.name}`).join(', ')} — ${r.units.length} session/memory`];
  out.push(`Project: ${r.projects.map(([p, n]) => `${p} (${n})`).join(', ')}`);
  for (const k of Object.keys(EKIND)) {
    const xs = r.related.filter((x) => x.kind === k);
    if (xs.length) out.push(`\n## ${EKIND[k]} hay đi cùng`, ...xs.map((x) => `- ${x.name} (${x.units} lần cùng)`));
  }
  const title = db.prepare('SELECT title FROM sessions WHERE id = ?');
  const kname = db.prepare('SELECT name FROM knowledge WHERE path = ?');
  out.push('\n## Nhắc tới ở', ...r.units.slice(0, 10).map((u) => `- ${u.ts ? localDay(u.ts) : '?'} · ${u.project} · `
    + (u.unit_kind === 'session' ? clip(title.get(u.unit)?.title ?? '(không tiêu đề)', 100) : `memory: ${kname.get(u.unit)?.name ?? '?'}`)));
  if (r.units.length > 10) out.push(`- … và ${r.units.length - 10} nơi khác`);
  return out.join('\n');
}

function brainProfile({ type } = {}) {
  const rows = profile(db).filter((k) => !type || k.type === type);
  if (!rows.length) return 'Chưa có memory nào loại user/feedback. (Claude Code lưu chúng trong ~/.claude/projects/*/memory/*.md với `type: user` hoặc `type: feedback`.)';
  const out = [];
  for (const t of ['user', 'feedback']) {
    const xs = rows.filter((k) => k.type === t);
    if (xs.length) out.push(`## ${t === 'user' ? 'Về người dùng' : 'Góp ý / cách làm việc'} (${xs.length})`,
      ...xs.map((k) => `- **${k.name}** — ${k.description} _(${k.project}, ${localDay(k.mtime)})_\n  ${clip(k.content, 500)}`), '');
  }
  return out.join('\n').trim();
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
  list('Knowledge (memory)', b.knowledge.map((k) => `**${k.name}**${typeTag(k.type)} — ${k.description}\n  ${clip(k.content, 600)}`));
  // person-level memories saved in other projects: pointer only — they can hold other projects' personal/client
  // details, so their content is returned only when explicitly asked for via brain_profile
  const elsewhere = profile(db).filter((k) => k.project !== b.project).length;
  if (elsewhere) out.push(`\n(Còn ${elsewhere} memory về người dùng / cách làm việc lưu ở project khác — gọi brain_profile nếu cần.)`);
  list('Session gần đây', b.recent.map((s) => `${localDay(s.started_at)} · ${clip(s.title, 100)} (${s.n_prompts} prompt${via(s)})`));
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
  return [...byDay].map(([d, ss]) => `## ${d}\n` + ss.map((s) => `- ${s.project} · ${clip(s.title, 100)} (${s.n_prompts} prompt, ${money(s.cost_usd)}${via(s)})`).join('\n')).join('\n\n');
}

// sessions from GitHub Copilot are tagged so the agent knows they did not happen in Claude Code
function via(s) { return s.source === 'copilot-cli' ? ', Copilot CLI' : s.source === 'copilot-vscode' ? ', Copilot VS Code' : ''; }

const HANDLERS = { brain_search: brainSearch, brain_related: brainRelated, brain_project: brainProject, brain_recent: brainRecent, brain_profile: brainProfile };

function handle(msg) {
  const { method, params } = msg;
  if (method === 'initialize') return {
    protocolVersion: params?.protocolVersion ?? '2025-06-18',
    capabilities: { tools: {} },
    serverInfo: { name: 'personal-brain', version: VERSION },
    instructions: 'Bộ nhớ cá nhân: lịch sử các session Claude Code trước đây của người dùng (prompt, knowledge, tóm tắt AI theo project). '
      + 'Tra ở đây khi người dùng nhắc tới việc đã làm trước đó hoặc khi cần ngữ cảnh/quyết định cũ của project; '
      + 'brain_profile cho sở thích/cách làm việc của người dùng (áp dụng mọi project). Chỉ đọc.',
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
