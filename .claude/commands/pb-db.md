---
description: Query brain.db (read-only) — write SQL from a natural-language question or run SQL directly
argument-hint: <question or SELECT …> [--installed]
allowed-tools: Bash(npm run db:*), Bash(node --no-warnings scripts/db.mjs:*)
---

Request: $ARGUMENTS

- Use the dev DB (`src/brain.db`) by default. If the request contains `--installed` or mentions "real data / the installed copy", add `--installed`.
- If the columns are unclear, run `npm run db -- --tables` and `npm run db -- --schema <table>` first.
- For a natural-language question, write the matching SELECT (times are epoch ms; the `day` column is YYYY-MM-DD), then run `npm run db -- "<SQL>"`.
- SELECT/PRAGMA only (the DB is opened read-only).

Answer with: the SQL that was run + a compact result + a short note if the numbers look unusual. Do not paste the user's long prompts verbatim.
