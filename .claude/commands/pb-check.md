---
description: Kiểm tra nhanh toàn repo — syntax + smoke test server thật (cổng 4399) + trạng thái git
allowed-tools: Bash(npm test:*), Bash(npm run check:*), Bash(npm run smoke:*), Bash(git status:*), Bash(git diff:*)
---

Chạy `npm test` (check + smoke). Sau đó `git status --short`.

Báo cáo ngắn: tầng nào pass/fail, lỗi cụ thể (file:dòng) nếu có, và các file đang thay đổi.
Nếu fail, đề xuất nguyên nhân dựa trên diff hiện tại — chưa tự sửa trừ khi người dùng bảo.
