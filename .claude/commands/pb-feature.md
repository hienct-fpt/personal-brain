---
description: Build a new feature end-to-end — short design, code, smoke test, update docs/Mermaid
argument-hint: <feature description>
---

Feature: $ARGUMENTS

1. Use the `pb-coding` skill: find the files to change from the code map. If the request is vague, or needs a new dependency / a large schema change, ask the user first.
2. State a 3–6 line plan (which files, what changes), then code.
3. Add assertions for the new behavior to `scripts/smoke.mjs` if there is a new API/data/MCP tool.
4. Use the `pb-testing` skill: `npm test`, plus data checks (`npm run db`) or UI checks where relevant.
5. Update `README.md` (commands/config) and the Mermaid diagrams in `README.md` / `docs/PLAN.md` if a flow changes.
6. Summarize: what changed, what was verified, what was not. Do not commit unless the user asks.
