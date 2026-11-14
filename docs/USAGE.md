# Using Personal Brain with Claude Code (Desktop)

Personal Brain reads your Claude Code session history into a local SQLite database. It has two parts: a dashboard to browse the data, and a read-only MCP server that lets Claude look up what you did before. Everything stays on your machine.

## 1. Install

Requirements: Node.js >= 22.5, and Claude Code has run on this machine at least once.

```bat
git clone https://github.com/hienct-fpt/personal-brain.git
cd personal-brain
install.cmd
```

On macOS/Linux use `node scripts/install.mjs`. The installer:

- adds a **SessionEnd** hook to `~/.claude/settings.json`, so each session is saved to `brain.db` when it ends;
- raises `cleanupPeriodDays` to at least 365, so transcripts are not deleted after 30 days;
- registers the `personal-brain` MCP server at user scope, so it works in every project;
- puts a `brain` command on PATH.

See the README for all installer options (`--no-mcp`, `--dry-run`, ...).

## 2. Ask the brain from Claude Code Desktop

After installing, **quit Claude Code Desktop completely and reopen it** so it picks up the new MCP server. Then:

1. Type `/mcp` and check that `personal-brain` is connected.
2. Ask normally. Claude calls the tools when they are useful.

| Question | Tool |
| --- | --- |
| "How did I fix the CSRF bug last time?" | `brain_search` |
| "What did I decide about X in October?" | `brain_search` (time cues such as "last month", "3 days ago", "2026-10" are detected automatically) |
| "What usually changes together with `query.mjs`?" | `brain_related` |
| "Where is this project at, what did we decide?" | `brain_project` (empty name = current project) |
| "What did I work on this week?" | `brain_recent` |
| "How do I like to work with Claude?" | `brain_profile` |

If `/mcp` does not list the server (for example you installed with `--no-mcp`), register it manually:

```sh
claude mcp add --scope user personal-brain -- node --no-warnings "<install dir>/mcp.mjs"
claude mcp get personal-brain
```

The default install dir is `~/.personal-brain`.

Note: tool results go into the session context, so they pass through the Claude API like everything else in the session.

## 3. Dashboard

```text
brain start            run in the background  ->  http://localhost:4377
brain                  run in this terminal window
brain stop | restart   stop / restart (after an upgrade: brain restart)
brain status           is it running, which version, autostart state
brain autostart on     start at Windows logon
brain ingest [--full]  read new transcripts (--full re-reads everything)
```

Tabs:

- **Projects**: activity heatmap, weekly timeline, Kanban, decisions and knowledge.
- **AI usage**: tokens, models and cost by day, project, model and hour of day.
- **Tips**: optimization hints, e.g. when Opus dominates cost.
- **Skills**: skills, subagents and commands on your machine, and which ones you actually use.
- **Settings**: provider, API key and model list for AI summaries (optional).

The search box uses SQLite FTS5 and is accent-insensitive.

## 4. AI summaries (optional)

Run `brain summarize "<project>"` or use the Settings tab. `brain_project` gives its richest answer once a project has a summary. Summaries send session titles, prompts and project memory to the provider you choose; add sensitive projects to `exclude` in `config.json` to keep them out.

## 5. Starter kit

Run from a project folder:

```sh
brain kit                  # list
brain kit add all          # copy into ./.claude  (--user = ~/.claude)
brain kit remove <name>    # remove unmodified copies
```

| Kind | Name | What it does |
| --- | --- | --- |
| skill | `brain-recall` | pulls prior project context from the brain before non-trivial work |
| skill | `bugfix-flow`, `verify-before-done` | bug-fix process, and checks before declaring done |
| agent | `brain-researcher`, `code-reviewer`, `test-runner` | history lookup, diff review, compact test runs |
| command | `/brain`, `/recap`, `/check`, `/commit-msg` | project brief, handoff recap, run checks, draft commit message |

## 6. Configuration

`config.json` in the install dir:

- `workspaceRoot`: folder containing your projects.
- `aliases`: group temporary folders into one project.
- `exclude`: project-name prefixes that are never recorded or sent to an AI.
- `port`, `refreshMinutes`: server port and transcript re-read interval.

## 7. Troubleshooting

- Empty dashboard: run `brain ingest --full`.
- Claude does not see the brain tools: check `/mcp`, then quit Desktop completely (tray icon -> Quit) and reopen it.
- Works in the terminal but not in Desktop: the GUI app may not have `node` on its PATH. The installer registers the absolute path of `node`; to fix an older registration, re-run `install.cmd` or re-add it by hand:

  ```bat
  claude mcp remove personal-brain -s user
  claude mcp add --scope user personal-brain -- "C:\Program Files\nodejs\node.exe" --no-warnings "C:/Users/<you>/.personal-brain/mcp.mjs"
  ```

- Upgrade: `git pull`, run `install.cmd`, then `brain restart`.
- Logs: `server.log` and `ingest-hook.log` in the install dir. Remove sensitive prompts and paths before sharing them.
- Uninstall: `uninstall.cmd` (add `--purge` to delete the data too).
