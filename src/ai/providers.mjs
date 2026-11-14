// AI providers for project summaries. Each provider: listModels (also used to verify the key) and
// generateJson (system + user prompt → object matching SCHEMA). Claude goes through the official
// Anthropic SDK; the others use their REST APIs via fetch (no extra dependencies).
import Anthropic from '@anthropic-ai/sdk';

const TIMEOUT_MS = 180_000;

// Known Claude prices ($/MTok, claude-api reference cached 2026-10-06) — for cost estimates only.
const CLAUDE_PRICES = {
  'claude-opus-5-5': [4, 20], 'claude-sonnet-5-5': [2, 10], 'claude-haiku-5-5': [0.1, 0.5],
  'claude-fable-5-1': [10, 50], 'claude-opus-5': [5, 25], 'claude-sonnet-5': [2, 10],
};
const CLAUDE_FALLBACK_MODELS = new Set(['claude-opus-5-5', 'claude-opus-5', 'claude-fable-5-1', 'claude-sonnet-5-5']);

export const PROVIDERS = {
  anthropic: {
    label: 'Anthropic (Claude)', docs: 'https://platform.claude.com/settings/keys', keyPlaceholder: 'sk-ant-…',
    defaultModel: 'claude-opus-5-5', effort: true, fields: [],
  },
  openai: {
    label: 'OpenAI', docs: 'https://platform.openai.com/api-keys', keyPlaceholder: 'sk-…', fields: [],
  },
  gemini: {
    label: 'Google Gemini', docs: 'https://aistudio.google.com/apikey', keyPlaceholder: 'AIza…', fields: [],
  },
  azure: {
    label: 'Azure OpenAI', docs: 'https://portal.azure.com', keyPlaceholder: 'Azure OpenAI key',
    fields: [
      { name: 'endpoint', label: 'Endpoint', placeholder: 'https://<resource>.openai.azure.com', required: true },
      { name: 'apiVersion', label: 'API version', placeholder: '2024-10-21', default: '2024-10-21' },
    ],
    modelLabel: 'Deployment',
  },
  compatible: {
    label: 'OpenAI-compatible (OpenRouter, DeepSeek, Groq, Mistral, xAI, Ollama, LM Studio…)', docs: null,
    keyPlaceholder: 'API key (để trống nếu server local không cần)', keyOptional: true,
    fields: [{ name: 'baseUrl', label: 'Base URL', placeholder: 'https://openrouter.ai/api/v1 · http://localhost:11434/v1', required: true }],
  },
};

export class ProviderError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

const trimSlash = (u) => String(u ?? '').trim().replace(/\/+$/, '');

async function http(url, { method = 'GET', headers = {}, body } = {}) {
  let res;
  try {
    res = await fetch(url, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e) {
    throw new ProviderError(`Không kết nối được tới ${new URL(url).host}: ${e.cause?.code ?? e.message}`, 0);
  }
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = null; }
  if (!res.ok) {
    const msg = json?.error?.message ?? json?.error ?? json?.message ?? text.slice(0, 300);
    throw new ProviderError(`${res.status} ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`, res.status);
  }
  return json;
}

// ---------- shared OpenAI-style chat (OpenAI, Azure, compatible) ----------
const NON_CHAT = /embed|tts|whisper|dall-e|audio|realtime|moderation|image|transcribe|search|computer-use|davinci|babbage/i;

async function openaiStyleChat({ url, headers, model, system, user, schema, tokenParam }) {
  // Try strict JSON schema first, then JSON mode, then plain — not every compatible server supports all three.
  const modes = [
    { type: 'json_schema', json_schema: { name: 'project_summary', strict: true, schema } },
    { type: 'json_object' },
    null,
  ];
  let lastErr;
  for (const rf of modes) {
    const body = {
      ...(model ? { model } : {}),
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      [tokenParam]: 8000,
      ...(rf ? { response_format: rf } : {}),
    };
    try {
      const r = await http(url, { method: 'POST', headers, body });
      const choice = r.choices?.[0];
      if (choice?.finish_reason === 'length') throw new ProviderError('Kết quả bị cắt do vượt giới hạn token', 200);
      if (choice?.message?.refusal) throw new ProviderError(`Model từ chối: ${choice.message.refusal}`, 200);
      return { text: choice?.message?.content ?? '', model: r.model ?? model,
        input: r.usage?.prompt_tokens ?? 0, output: r.usage?.completion_tokens ?? 0 };
    } catch (e) {
      lastErr = e;
      if (!(e instanceof ProviderError) || ![400, 404, 415, 422].includes(e.status)) throw e; // only retry "unsupported" errors
    }
  }
  throw lastErr;
}

// ---------- per-provider implementations ----------
const impl = {
  anthropic: {
    async listModels({ key }) {
      const ids = [];
      try { for await (const m of new Anthropic({ apiKey: key }).models.list()) ids.push(m.id); }
      catch (e) { throw anthropicError(e); }
      return ids;
    },
    async generate({ key, model, effort, system, user, schema }) {
      const client = new Anthropic({ apiKey: key });
      const params = {
        model, max_tokens: 16000, system, messages: [{ role: 'user', content: user }],
        output_config: { effort: effort ?? 'medium', format: { type: 'json_schema', schema } },
      };
      let r;
      try {
        r = CLAUDE_FALLBACK_MODELS.has(model)
          ? await client.beta.messages.create({ ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' })
          : await client.messages.create(params);
      } catch (e) { throw anthropicError(e); }
      if (r.stop_reason === 'refusal') throw new ProviderError(`Claude từ chối (${r.stop_details?.category ?? 'không rõ lý do'})`, 200);
      if (r.stop_reason === 'max_tokens') throw new ProviderError('Kết quả bị cắt do vượt max_tokens', 200);
      const u = r.usage;
      return { text: r.content.filter((b) => b.type === 'text').map((b) => b.text).join(''), model: r.model,
        input: u.input_tokens + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0), output: u.output_tokens };
    },
  },

  openai: {
    async listModels({ key }) {
      const r = await http('https://api.openai.com/v1/models', { headers: { authorization: `Bearer ${key}` } });
      return (r.data ?? []).map((m) => m.id).filter((id) => !NON_CHAT.test(id)).sort();
    },
    generate: ({ key, model, system, user, schema }) => openaiStyleChat({
      url: 'https://api.openai.com/v1/chat/completions', headers: { authorization: `Bearer ${key}` },
      model, system, user, schema, tokenParam: 'max_completion_tokens' }),
  },

  gemini: {
    async listModels({ key }) {
      const ids = [];
      let pageToken = '';
      do {
        const r = await http(`https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000${pageToken ? `&pageToken=${pageToken}` : ''}`,
          { headers: { 'x-goog-api-key': key } });
        for (const m of r.models ?? []) if (m.supportedGenerationMethods?.includes('generateContent')) ids.push(m.name.replace(/^models\//, ''));
        pageToken = r.nextPageToken ?? '';
      } while (pageToken);
      return ids;
    },
    async generate({ key, model, system, user, schema }) {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
      const base = { systemInstruction: { parts: [{ text: system }] }, contents: [{ role: 'user', parts: [{ text: user }] }] };
      let r;
      try {
        r = await http(url, { method: 'POST', headers: { 'x-goog-api-key': key },
          body: { ...base, generationConfig: { responseMimeType: 'application/json', responseSchema: toGeminiSchema(schema), maxOutputTokens: 8000 } } });
      } catch (e) {
        if (!(e instanceof ProviderError) || e.status !== 400) throw e;
        r = await http(url, { method: 'POST', headers: { 'x-goog-api-key': key },
          body: { ...base, generationConfig: { responseMimeType: 'application/json', maxOutputTokens: 8000 } } });
      }
      const cand = r.candidates?.[0];
      if (!cand) throw new ProviderError(`Gemini không trả kết quả (${r.promptFeedback?.blockReason ?? 'không rõ'})`, 200);
      if (cand.finishReason === 'MAX_TOKENS') throw new ProviderError('Kết quả bị cắt do vượt giới hạn token', 200);
      return { text: (cand.content?.parts ?? []).map((p) => p.text ?? '').join(''), model: r.modelVersion ?? model,
        input: r.usageMetadata?.promptTokenCount ?? 0, output: r.usageMetadata?.candidatesTokenCount ?? 0 };
    },
  },

  azure: {
    async listModels({ key, settings }) {
      const ep = trimSlash(settings.endpoint);
      if (!ep) throw new ProviderError('Cần nhập Endpoint', 400);
      const v = settings.apiVersion || '2024-10-21';
      // Deployments are what you call; fall back to the model catalog if listing deployments is not allowed.
      try {
        const r = await http(`${ep}/openai/deployments?api-version=2022-12-01`, { headers: { 'api-key': key } });
        return (r.data ?? []).map((d) => d.id);
      } catch (e) {
        if (e.status === 401 || e.status === 0) throw e;
        await http(`${ep}/openai/models?api-version=${v}`, { headers: { 'api-key': key } }); // verifies the key
        return [];
      }
    },
    generate: ({ key, model, settings, system, user, schema }) => openaiStyleChat({
      url: `${trimSlash(settings.endpoint)}/openai/deployments/${encodeURIComponent(model)}/chat/completions?api-version=${settings.apiVersion || '2024-10-21'}`,
      headers: { 'api-key': key }, model: null, system, user, schema, tokenParam: 'max_tokens' }),
  },

  compatible: {
    async listModels({ key, settings }) {
      const base = trimSlash(settings.baseUrl);
      if (!base) throw new ProviderError('Cần nhập Base URL', 400);
      const r = await http(`${base}/models`, { headers: key ? { authorization: `Bearer ${key}` } : {} });
      return (r.data ?? r.models ?? []).map((m) => m.id ?? m.name).filter((id) => id && !NON_CHAT.test(id)).sort();
    },
    generate: ({ key, model, settings, system, user, schema }) => openaiStyleChat({
      url: `${trimSlash(settings.baseUrl)}/chat/completions`, headers: key ? { authorization: `Bearer ${key}` } : {},
      model, system, user, schema, tokenParam: 'max_tokens' }),
  },
};

function anthropicError(e) {
  if (e instanceof Anthropic.AuthenticationError) return new ProviderError('401 API key không hợp lệ', 401);
  if (e instanceof Anthropic.PermissionDeniedError) return new ProviderError('403 Key không có quyền truy cập', 403);
  if (e instanceof Anthropic.RateLimitError) return new ProviderError('429 Bị giới hạn tốc độ — thử lại sau', 429);
  if (e instanceof Anthropic.APIConnectionError) return new ProviderError('Không kết nối được tới api.anthropic.com', 0);
  if (e instanceof Anthropic.APIError) return new ProviderError(`${e.status} ${e.message}`, e.status);
  return e;
}

// Gemini responseSchema is an OpenAPI subset: uppercase types, no additionalProperties.
function toGeminiSchema(s) {
  if (Array.isArray(s)) return s.map(toGeminiSchema);
  if (!s || typeof s !== 'object') return s;
  const out = {};
  for (const [k, v] of Object.entries(s)) {
    if (k === 'additionalProperties') continue;
    out[k] = k === 'type' ? String(v).toUpperCase() : k === 'properties' ? Object.fromEntries(Object.entries(v).map(([p, d]) => [p, toGeminiSchema(d)])) : toGeminiSchema(v);
  }
  return out;
}

export function providerReady(id, key, settings) {
  const p = PROVIDERS[id];
  if (!p) return false;
  if (!key && !p.keyOptional) return false;
  if (p.fields.some((f) => f.required && !settings?.[f.name])) return false;
  return !!(settings?.model || p.defaultModel);
}

export const listModels = (id, key, settings = {}) => impl[id].listModels({ key, settings });

export async function generateJson(id, { key, settings = {}, system, user, schema }) {
  const model = settings.model || PROVIDERS[id].defaultModel;
  if (!model) throw new ProviderError('Chưa chọn model', 400);
  const r = await impl[id].generate({ key, model, effort: settings.effort, settings, system, user, schema });
  const price = id === 'anthropic' ? CLAUDE_PRICES[model] : null;
  return { data: parseJsonLoose(r.text), model: r.model, provider: id,
    usage: { input: r.input, output: r.output, costUsd: price ? (r.input * price[0] + r.output * price[1]) / 1e6 : null } };
}

function parseJsonLoose(text) {
  const t = String(text).trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try { return JSON.parse(t); } catch { /* fall through */ }
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a < 0 || b <= a) throw new ProviderError('Model không trả về JSON hợp lệ', 200);
  return JSON.parse(t.slice(a, b + 1));
}
