// Draft a SKILL.md from prompts the user keeps typing, with the active AI provider (nothing is written to disk here).
import { loadConfig, redact } from '../core/lib.mjs';
import { PROVIDERS, generateJson } from './providers.mjs';
import { NoApiKeyError, activeProvider, aiConfig } from './summarize.mjs';

export const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]{1,59}$/;

const SYSTEM = (lang) => `Bạn viết Agent Skill (file SKILL.md) cho Claude Code từ những câu người dùng hay gõ lặp lại.
Quy tắc:
- name: kebab-case, 2-4 từ tiếng Anh, mô tả việc (vd. "release-checklist"), tối đa 40 ký tự.
- description (tiếng Anh hoặc ${lang}, 1-3 câu, tối đa 400 ký tự): nói skill LÀM GÌ và DÙNG KHI NÀO, kèm vài cụm người dùng hay nói để Claude kích hoạt đúng ("Use when the user …").
- body (markdown, ${lang}, ngắn gọn dưới 60 dòng): quy trình theo bước đánh số, điều kiện dừng, cách kiểm tra kết quả. Tổng quát hoá từ các ví dụ, không chép nguyên văn.
- Không đưa tên người, tên khách hàng, đường dẫn cá nhân, key/token vào skill. Không bịa chi tiết ngoài các ví dụ; thiếu thông tin thì viết bước mang tính hướng dẫn chung.
- Không dùng ký tự --- ở đầu body.`;

const SCHEMA = {
  type: 'object',
  properties: { name: { type: 'string' }, description: { type: 'string' }, body: { type: 'string' } },
  required: ['name', 'description', 'body'],
  additionalProperties: false,
};

const oneLine = (s) => String(s).replace(/\s+/g, ' ').trim();

// → { name, content (full SKILL.md), usage }
export async function draftSkill(examples) {
  const cfg = loadConfig();
  const p = activeProvider(cfg);
  if (!p.ready) throw new NoApiKeyError(`Chưa cấu hình đủ ${PROVIDERS[p.id].label} (API key / model) — vào ⚙ Cài đặt.`);
  const ex = examples.map((e) => redact(oneLine(e)).slice(0, 400)).filter(Boolean).slice(0, 8);
  const user = `Các câu người dùng đã gõ (lặp lại nhiều lần):\n${ex.map((e) => `- ${e}`).join('\n')}\n\nViết skill giúp Claude làm đúng việc này mà người dùng không phải gõ lại.`;
  const r = await generateJson(p.id, { key: p.key, settings: p.settings, system: SYSTEM(aiConfig(cfg).language), user, schema: SCHEMA });
  const name = oneLine(r.data?.name ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  const description = oneLine(r.data?.description ?? '').slice(0, 600);
  const body = String(r.data?.body ?? '').trim();
  if (!SKILL_NAME_RE.test(name) || !description || !body) throw new Error('AI trả về skill không hợp lệ — thử lại.');
  return { name, content: `---\nname: ${name}\ndescription: ${description.replace(/\n/g, ' ')}\n---\n\n${redact(body)}\n`, usage: { ...r.usage, provider: r.provider, model: r.model } };
}
