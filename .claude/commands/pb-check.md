---
description: Quick whole-repo check — syntax + smoke test against a real server (port 4399) + git status
allowed-tools: Bash(npm test:*), Bash(npm run check:*), Bash(npm run smoke:*), Bash(git status:*), Bash(git diff:*)
---

Run `npm test` (check + smoke), then `git status --short`.

Short report: which layer passed/failed, the specific error (file:line) if any, and the files currently changed.
If something fails, suggest a cause based on the current diff — do not fix it unless the user asks.
