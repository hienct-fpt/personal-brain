---
description: Draft a commit message from the staged diff (Conventional Commits style); does not commit
allowed-tools: Bash(git diff:*), Bash(git status:*), Bash(git log:*)
---

1. Read `git diff --staged` (if nothing is staged, use `git diff` and say so) and `git log --oneline -10` to match the repo's existing style.
2. Draft one commit message:
   - subject ≤ 72 chars, imperative mood, `type(scope): …` (feat, fix, docs, refactor, test, chore…) unless the repo clearly uses another style
   - body: what changed and **why**, wrapped at 72 chars; mention breaking changes
3. Show the message in a code block. Do not run `git commit` — I will.

Extra instructions from me (optional): $ARGUMENTS
