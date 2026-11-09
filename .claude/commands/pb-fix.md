---
description: Sửa một lỗi theo quy trình tái hiện → khoanh vùng → sửa gốc → chặn tái phát
argument-hint: <mô tả lỗi / issue #>
---

Lỗi: $ARGUMENTS

Làm theo skill `pb-bugfix`:
1. Tái hiện trên bản dev (`npm run smoke -- --keep`, cổng 4399) hoặc bằng truy vấn `npm run db`. Nếu là issue GitHub, đọc issue trước.
2. Khoanh vùng tầng lỗi (ingest/DB → API → UI → AI → hook) và tìm nguyên nhân gốc. Nêu nguyên nhân trước khi sửa.
3. Sửa tận gốc, thay đổi nhỏ nhất có thể.
4. Thêm kiểm tra chống tái phát vào `scripts/smoke.mjs` (hoặc truy vấn bất biến).
5. `npm test` + chạy lại kịch bản lỗi.
6. Báo cáo: nguyên nhân, sửa ở đâu (file:dòng), đã kiểm gì. Đề xuất commit message `fix: …`; chỉ commit khi người dùng bảo.
