// GitHub Copilot sources: Copilot CLI (~/.copilot/session-state/<id>/events.jsonl) and VS Code Copilot Chat
// (<VS Code user dir>/workspaceStorage/<hash>/chatSessions/<id>.json|.jsonl, + globalStorage/emptyWindowChatSessions).
// Each parser returns the same shape as ingest.mjs parseSession, plus `source`, `lines` and per-message `cost`.
// Copilot bills in AI credits (AIC); 1 AIC = $0.01 (model prices are published as AIC per 1M tokens = cents).
import { createReadStream, readdirSync, statSync, existsSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { redact, expandHome } from '../core/lib.mjs';

const USD_PER_NANO_AIU = 1e-11; // 1e9 nano-AIC = 1 AIC = $0.01
const CLI_EDIT_TOOLS = new Set(['edit', 'create', 'write']);
const SUBAGENT_TOOLS = new Set(['task', 'runSubagent']);

const signature = (files) => files.map((p) => { const st = statSync(p); return `${st.mtimeMs}:${st.size}`; }).join('|');
const tryRead = (dir) => { try { return readdirSync(dir, { withFileTypes: true }); } catch { return []; } };

// Default VS Code user dirs (stable + Insiders) per platform; config `vscodeUserDirs` overrides ([] = off).
export function vscodeUserDirs(cfg) {
  if (Array.isArray(cfg.vscodeUserDirs)) return cfg.vscodeUserDirs.map(expandHome);
  const base = process.platform === 'win32' ? (process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'))
    : process.platform === 'darwin' ? join(homedir(), 'Library', 'Application Support') : join(homedir(), '.config');
  return ['Code', 'Code - Insiders'].map((d) => join(base, d, 'User'));
}

export function listCopilotSessions(cfg) {
  const out = [];
  if (cfg.copilotDir) {
    const root = join(cfg.copilotDir, 'session-state');
    for (const d of tryRead(root)) {
      const f = join(root, d.name, 'events.jsonl');
      if (d.isDirectory() && existsSync(f)) out.push({ id: `copilot-cli:${d.name}`, kind: 'cli', files: [f], signature: signature([f]) });
    }
  }
  for (const user of vscodeUserDirs(cfg)) {
    const dirs = tryRead(join(user, 'workspaceStorage')).filter((d) => d.isDirectory())
      .map((d) => ({ chats: join(user, 'workspaceStorage', d.name, 'chatSessions'), ws: join(user, 'workspaceStorage', d.name, 'workspace.json') }));
    dirs.push({ chats: join(user, 'globalStorage', 'emptyWindowChatSessions'), ws: null });
    for (const { chats, ws } of dirs) {
      const files = tryRead(chats).filter((f) => f.isFile() && /\.jsonl?$/.test(f.name));
      if (!files.length) continue;
      const cwd = ws ? workspaceFolder(ws) : null;
      for (const f of files) {
        const p = join(chats, f.name);
        out.push({ id: `vscode:${f.name.replace(/\.jsonl?$/, '')}`, kind: 'vscode', files: [p], signature: signature([p]), cwd });
      }
    }
  }
  return out;
}

// workspace.json → { folder: "file:///c%3A/..." } or { workspace: "file:///…/x.code-workspace" }
function workspaceFolder(file) {
  try {
    const w = JSON.parse(readFileSync(file, 'utf8'));
    const uri = w.folder ?? w.workspace;
    if (!uri?.startsWith('file:')) return null;
    const p = fileURLToPath(uri);
    return w.folder ? p : dirname(p);
  } catch { return null; }
}

const empty = (source) => ({ source, cwd: null, title: null, customTitle: null, start: Infinity, end: 0, prompts: [], msgs: new Map(),
  tools: {}, ext: [], files: new Set(), costState: null, turns: 0, toolErrors: 0, subagents: 0, lines: null });
const span = (r, ts) => { if (Number.isFinite(ts)) { r.start = Math.min(r.start, ts); r.end = Math.max(r.end, ts); } };
const tool = (r, name) => {
  r.tools[name] = (r.tools[name] ?? 0) + 1;
  if (SUBAGENT_TOOLS.has(name)) r.subagents++;
};
const clipPrompt = (t) => (typeof t === 'string' && t.trim() ? redact(t.trim()).slice(0, 1500) : null);

function units(u, cu) {
  return u.input * cu.input + u.output * cu.output + u.cache_read * cu.cacheRead + u.cache_write * cu.cacheWrite5m;
}

// ---------- Copilot CLI ----------
export async function parseCopilotCli(s, cfg) {
  const r = empty('copilot-cli');
  const rl = createInterface({ input: createReadStream(s.files[0], 'utf8'), crlfDelay: Infinity });
  for await (const line of rl) {
    let e; try { e = JSON.parse(line); } catch { continue; }
    const ts = Date.parse(e.timestamp), d = e.data ?? {};
    switch (e.type) {
      case 'session.start': case 'session.resume':
        r.cwd ??= d.context?.cwd ?? null; span(r, ts); break;
      case 'user.message': {
        span(r, ts);
        const t = clipPrompt(d.content);
        if (t) r.prompts.push({ ts, text: t });
        const cmd = String(d.content ?? '').match(/^\/([\w:-]+)/);
        if (cmd) r.ext.push({ ts, kind: 'command', name: cmd[1] });
        break;
      }
      case 'assistant.message': r.turns++; span(r, ts); break;
      case 'tool.execution_start': {
        const a = d.arguments ?? {};
        tool(r, d.toolName);
        if (CLI_EDIT_TOOLS.has(d.toolName) && a.path) r.files.add(String(a.path).replace(/\\/g, '/'));
        if (d.toolName === 'skill' && (a.skill ?? a.name)) r.ext.push({ ts, kind: 'skill', name: a.skill ?? a.name });
        if (SUBAGENT_TOOLS.has(d.toolName) && a.agent_type) r.ext.push({ ts, kind: 'agent', name: a.agent_type });
        break;
      }
      case 'tool.execution_complete': if (d.success === false) r.toolErrors++; break;
      case 'session.usage_record': {
        const u = d.usage;
        if (!u?.model) break;
        span(r, ts);
        const cr = u.cacheReadTokens ?? 0, cw = u.cacheWriteTokens ?? 0;
        // inputTokens includes cache reads/writes; store the uncached part like Claude transcripts do
        const row = { id: u.apiCallId ?? e.id, ts, model: `copilot/${u.model}`, input: Math.max(0, (u.inputTokens ?? 0) - cr - cw),
          output: u.outputTokens ?? 0, cache_read: cr, cache_write: cw };
        row.units = units(row, cfg.costUnits);
        row.cost = (u.copilotUsage?.totalNanoAiu ?? 0) * USD_PER_NANO_AIU;
        r.msgs.set(row.id, row);
        break;
      }
      case 'session.usage_checkpoint': case 'session.shutdown': {
        const c = (d.accountingSnapshot ?? d)?.codeChanges;
        if (c) r.lines = { added: c.linesAdded ?? 0, removed: c.linesRemoved ?? 0 };
        break;
      }
    }
    if (e.type === 'tool.execution_start' && d.toolName === 'rename_chat' && d.arguments?.title) r.title = d.arguments.title;
  }
  return r;
}

// ---------- VS Code Copilot Chat ----------
// .jsonl = mutation log: kind 0 = initial state, 1 = set value at path k, 2 = push v (truncate to i first), 3 = delete.
export function replayChatLog(text) {
  let state = null;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let e; try { e = JSON.parse(line); } catch { continue; }
    if (e.kind === 0) { state = e.v; continue; }
    if (!state || !Array.isArray(e.k) || !e.k.length) continue;
    const parent = e.k.slice(0, -1).reduce((o, k) => o?.[k], state);
    const key = e.k.at(-1);
    if (parent == null || typeof parent !== 'object') continue;
    if (e.kind === 1) parent[key] = e.v;
    else if (e.kind === 2) {
      if (!Array.isArray(parent[key])) parent[key] = [];
      if (Number.isInteger(e.i)) parent[key].length = Math.min(parent[key].length, e.i);
      if (Array.isArray(e.v)) parent[key].push(...e.v);
    } else if (e.kind === 3) delete parent[key];
  }
  return state;
}

export function parseCopilotVscode(s, cfg) {
  const r = empty('copilot-vscode');
  r.cwd = s.cwd ?? null;
  const text = readFileSync(s.files[0], 'utf8');
  let chat;
  try { chat = s.files[0].endsWith('.jsonl') ? replayChatLog(text) : JSON.parse(text); } catch { chat = null; }
  if (!chat) return r;
  r.customTitle = chat.customTitle ?? null;
  for (const [i, q] of (chat.requests ?? []).entries()) {
    if (!q) continue;
    const ts = q.timestamp ?? chat.creationDate;
    span(r, ts);
    span(r, q.modelState?.completedAt);
    const t = clipPrompt(q.message?.text);
    if (t) r.prompts.push({ ts, text: t });
    if (q.agent?.name && !q.agent.isDefault) r.ext.push({ ts, kind: 'agent', name: q.agent.name });
    const slash = q.slashCommand?.name ?? String(q.message?.text ?? '').match(/^\/([\w:-]+)/)?.[1];
    if (slash) r.ext.push({ ts, kind: 'command', name: slash });
    r.turns++;
    for (const b of Array.isArray(q.response) ? q.response : []) {
      if (b?.kind === 'toolInvocationSerialized' && b.toolId) {
        tool(r, b.toolId);
        if (b.isComplete === false || b.resultDetails?.isError) r.toolErrors++;
      } else if (b?.kind === 'textEditGroup' && b.uri?.fsPath) r.files.add(b.uri.fsPath.replace(/\\/g, '/'));
    }
    const meta = q.result?.metadata ?? {};
    const input = q.promptTokens ?? meta.promptTokens ?? 0, output = q.completionTokens ?? meta.outputTokens ?? 0;
    const credits = q.copilotCredits ?? 0;
    if (!input && !output && !credits) continue;
    const model = String(meta.resolvedModel ?? q.modelId ?? 'unknown').replace(/^copilot\//, '');
    const row = { id: `${s.id}:${q.requestId ?? i}`, ts, model: `copilot/${model}`, input, output, cache_read: 0, cache_write: 0 };
    row.units = units(row, cfg.costUnits);
    row.cost = credits * 0.01;
    r.msgs.set(row.id, row);
  }
  span(r, chat.creationDate);
  span(r, chat.lastMessageDate);
  if (!r.prompts.length) r.start = Infinity; // empty chat (opened, never used) → skipped by writeSession
  return r;
}
