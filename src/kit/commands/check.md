---
description: Run this project's own checks (lint, typecheck, tests, build) and summarize — uses the test-runner agent if installed
argument-hint: "[what to check, e.g. 'tests only' or a path]"
---

Verify the current state of this project.

1. Find the project's check commands (CLAUDE.md / README / package.json scripts / Makefile / pyproject / CI workflows). Do not invent commands.
2. Run them — scoped by `$ARGUMENTS` if given. If a `test-runner` subagent is available, delegate the run to it to keep output short.
3. Run `git status --short`.

Report: each command → ✓/✗, the first relevant error (`file:line`) for each failure, and the changed files. Suggest a likely cause for failures based on the current diff, but do not fix anything unless I ask.
