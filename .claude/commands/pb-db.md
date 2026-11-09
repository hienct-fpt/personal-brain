---
description: Hỏi dữ liệu trong brain.db (read-only) — viết SQL từ câu hỏi tiếng Việt hoặc chạy SQL trực tiếp
argument-hint: <câu hỏi hoặc SELECT …> [--installed]
allowed-tools: Bash(npm run db:*), Bash(node --no-warnings scripts/db.mjs:*)
---

Yêu cầu: $ARGUMENTS

- Mặc định dùng DB dev (`src/brain.db`). Nếu yêu cầu có `--installed` hoặc nói "dữ liệu thật / bản cài", thêm `--installed`.
- Nếu chưa rõ cột, chạy `npm run db -- --tables` và `npm run db -- --schema <bảng>` trước.
- Nếu là câu hỏi tự nhiên, viết câu SELECT tương ứng (thời gian là epoch ms; cột `day` dạng YYYY-MM-DD), rồi chạy `npm run db -- "<SQL>"`.
- Chỉ dùng SELECT/PRAGMA (DB mở read-only).

Trả lời: câu SQL đã chạy + kết quả tóm gọn + nhận xét ngắn nếu số liệu bất thường. Không dán nguyên văn prompt dài của người dùng.
