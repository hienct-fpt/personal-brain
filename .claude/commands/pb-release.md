---
description: Phát hành phiên bản mới — bump version, cập nhật PLAN, test, commit, tag, push lên GitHub
argument-hint: <patch|minor|major|x.y.z>
---

Phiên bản: $ARGUMENTS (mặc định `patch`)

1. Kiểm `git status` sạch ngoài các thay đổi dự kiến; đang ở `main`.
2. `npm test` phải pass.
3. Tính version mới từ `package.json`; cập nhật `version` trong `package.json` và `package-lock.json` (`npm version <x> --no-git-tag-version`).
4. Cập nhật dòng trạng thái đầu `docs/PLAN.md` nếu cần; liệt kê thay đổi từ `git log <tag cũ>..HEAD --oneline`.
5. **Hỏi người dùng xác nhận** version + danh sách thay đổi trước khi commit/push (repo public).
6. Commit `release: vX.Y.Z` với `-c user.name=hienct-fpt -c user.email=hienct-fpt@users.noreply.github.com`, tạo tag `vX.Y.Z`, `git push --follow-tags`.
7. Kiểm không có thông tin cá nhân / tên dự án khách hàng trong diff trước khi push.
