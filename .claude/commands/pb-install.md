---
description: Cài bản đang sửa vào ~/.personal-brain (giữ dữ liệu) và kiểm tra bản cài
allowed-tools: Bash(npm test:*), Bash(node scripts/install.mjs:*), Bash(git status:*), Bash(git log:*)
---

1. Chạy `npm test`; nếu fail thì dừng và báo lỗi.
2. Nếu `git status` có thay đổi chưa commit, nói rõ bản cài sẽ mang nhãn `-dirty`.
3. Chạy `node scripts/install.mjs` (Windows không gọi được `install.cmd` từ shell này).
4. Kiểm `~/.personal-brain/version.json` khớp commit hiện tại.
5. Báo cáo kết quả. Nếu installer báo server cũ đang chạy, nhắc người dùng Ctrl+C cửa sổ server rồi chạy `brain` — không tự kill tiến trình.
