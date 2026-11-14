# Personal Brain — agent guide

Local dashboard: reads Claude Code transcripts → SQLite (`node:sqlite`) → HTTP server + plain-JS dashboard, plus a read-only MCP server for Claude Code.
Node >= 22.5, all ES modules (`.mjs`), 1 dependency (`@anthropic-ai/sdk`). No framework, no bundler.

## Commands

| Command | Does |
| --- | --- |
| `npm run check` | syntax of every `.mjs` + the script in `index.html` + JSON |
| `npm run smoke` | runs `src/server.mjs` on port 4399, calls every API, checks CSRF, tests the MCP server over stdio, then stops |
| `npm test` | `check` + `smoke` — **run before every commit** |
| `npm run ingest [-- --full]` | read transcripts into the dev DB `src/brain.db` |
| `npm run db -- "<SELECT …>"` | read-only query on the dev DB (`--installed` = installed DB, `--tables`, `--schema <t>`) |
| `npm run dev` | dev server on port 4377 + opens the browser (clashes with the installed copy → use `BRAIN_PORT=4399`) |
| `node scripts/install.mjs` | install the working copy into `~/.personal-brain` |

## Rules

- Dev runs from `src/` = its own data directory (`src/brain.db`, `src/config.json`, gitignored). **Do not** touch `~/.personal-brain`, `~/.claude/settings.json` or the user's MCP config while developing/testing.
- Never use port 4377 for testing: that is the dashboard the user is running.
- The hook (`hook-sessionend.mjs`) always exits 0 and never blocks a session.
- Any text stored in the DB from prompts/memory must go through `redact()` (`src/core/lib.mjs`).
- Schema changes: add to `SCHEMA` + an `ALTER TABLE … ADD COLUMN` migration with a column check in `openDb()`; never drop user-data columns/tables.
- POST APIs must pass `trusted()` (header `x-brain: 1` + Origin). API keys are never returned to the browser.
- The MCP server (`src/mcp.mjs`) is read-only; stdout is reserved for JSON-RPC (log to stderr).
- UI text and error messages are in Vietnamese. Docs (`*.md`) and code comments are in English.
- Never put personal information or client project names in the repo.
- Commit with `-c user.email=hienct-fpt@users.noreply.github.com -c user.name=hienct-fpt` (public repo).

Skills: `pb-coding` (architecture, where to change things), `pb-testing` (verification), `pb-bugfix` (bug-fix process).
Commands: `/pb-check`, `/pb-feature`, `/pb-fix`, `/pb-db`, `/pb-install`, `/pb-release`.
