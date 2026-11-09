# Personal Brain — hướng dẫn cho agent

Dashboard local đọc transcript Claude Code → SQLite (`node:sqlite`) → HTTP server + dashboard JS thuần.
Node >= 22.5, toàn bộ ES module `.mjs`, 1 dependency (`@anthropic-ai/sdk`). Không có framework, không bundler.

## Lệnh

| Lệnh | Việc |
| --- | --- |
| `npm run check` | syntax mọi `.mjs` + script trong `index.html` + JSON |
| `npm run smoke` | chạy `src/server.mjs` ở cổng 4399, gọi mọi API, kiểm CSRF, rồi tắt |
| `npm test` | `check` + `smoke` — **chạy trước mọi commit** |
| `npm run ingest [-- --full]` | đọc transcript vào DB dev `src/brain.db` |
| `npm run db -- "<SELECT …>"` | query read-only DB dev (`--installed` = DB đang cài, `--tables`, `--schema <t>`) |
| `npm run dev` | server dev cổng 4377 + mở trình duyệt (đụng cổng với bản đang cài → dùng `BRAIN_PORT=4399`) |
| `node scripts/install.mjs` | cài bản đang sửa vào `~/.personal-brain` |

## Quy tắc

- Dev chạy từ `src/` = thư mục dữ liệu riêng (`src/brain.db`, `src/config.json`, đã gitignore). **Không** đụng `~/.personal-brain` hay `~/.claude/settings.json` khi dev/test.
- Không bao giờ dùng cổng 4377 để test: đó là dashboard người dùng đang chạy.
- Hook (`hook-sessionend.mjs`) luôn `exit 0`, không chặn session.
- Mọi text lưu vào DB từ prompt/memory phải qua `redact()` (`src/lib.mjs`).
- Đổi schema: thêm vào `SCHEMA` + migration `ALTER TABLE … ADD COLUMN` có kiểm tra cột trong `openDb()`; không xoá cột/bảng dữ liệu người dùng.
- POST API phải đi qua `trusted()` (header `x-brain: 1` + Origin). API key không bao giờ trả ra trình duyệt.
- UI và thông báo lỗi bằng tiếng Việt. Không đưa thông tin cá nhân / tên dự án khách hàng vào repo.
- Commit với `-c user.email=hienct-fpt@users.noreply.github.com -c user.name=hienct-fpt` (repo public).

Skills: `pb-coding` (kiến trúc, nơi sửa), `pb-testing` (kiểm chứng), `pb-bugfix` (quy trình sửa lỗi).
Commands: `/pb-check`, `/pb-feature`, `/pb-fix`, `/pb-db`, `/pb-install`, `/pb-release`.
