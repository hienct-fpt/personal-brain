---
description: Làm một tính năng mới end-to-end — thiết kế ngắn, code, smoke test, cập nhật doc/Mermaid
argument-hint: <mô tả tính năng>
---

Tính năng cần làm: $ARGUMENTS

1. Dùng skill `pb-coding`: xác định file cần sửa theo bản đồ code. Nếu yêu cầu mơ hồ hoặc cần thêm dependency / đổi schema lớn, hỏi người dùng trước.
2. Nêu kế hoạch 3–6 dòng (file nào, đổi gì), rồi code.
3. Thêm assertion cho hành vi mới vào `scripts/smoke.mjs` nếu có API/dữ liệu mới.
4. Dùng skill `pb-testing`: `npm test`, thêm kiểm dữ liệu (`npm run db`) hoặc UI nếu liên quan.
5. Cập nhật `README.md` (lệnh/config) và sơ đồ Mermaid trong `README.md` / `docs/PLAN.md` nếu luồng thay đổi.
6. Tóm tắt: đã đổi gì, đã kiểm gì, chưa kiểm gì. Không commit trừ khi người dùng bảo.
