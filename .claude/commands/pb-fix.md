---
description: Fix a bug via reproduce → isolate → fix the root cause → prevent regression
argument-hint: <bug description / issue #>
---

Bug: $ARGUMENTS

Follow the `pb-bugfix` skill:
1. Reproduce on the dev copy (`npm run smoke -- --keep`, port 4399) or with an `npm run db` query. For a GitHub issue, read the issue first.
2. Isolate the failing layer (ingest/DB → API → UI → AI → hook → MCP) and find the root cause. State the cause before fixing.
3. Fix the root cause with the smallest possible change.
4. Add a regression check to `scripts/smoke.mjs` (or an invariant query).
5. `npm test` + re-run the original failing scenario.
6. Report: root cause, where it was fixed (file:line), what was verified. Suggest a `fix: …` commit message; commit only when the user asks.
