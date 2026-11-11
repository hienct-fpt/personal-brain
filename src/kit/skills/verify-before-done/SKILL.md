---
name: verify-before-done
description: Checklist to verify a change before saying it is done — find and run the project's own test/lint/build commands, review the diff, and report results faithfully. Use after editing code, before committing, or when the user asks to "test", "verify", "check".
---

# Verify before done

## 1. Find the project's checks

Look in this order and use what exists — do not invent commands:

- `CLAUDE.md` / `AGENTS.md` / `README.md` (a "Commands" or "Development" section)
- `package.json` scripts (`test`, `lint`, `check`, `typecheck`, `build`)
- `Makefile`, `justfile`, `pyproject.toml` / `tox.ini`, `Cargo.toml`, `go.mod`, `*.sln` / `*.csproj`, `pom.xml` / `build.gradle`
- CI config (`.github/workflows/*.yml`) — it shows what must pass

## 2. Run them

- Fastest first (syntax/lint/typecheck), then unit tests, then build.
- Run only what is relevant if the full suite is very slow, and say which parts you skipped.

## 3. Review the diff

- `git diff` / `git status`: only intended files changed, no debug output, no secrets, no stray generated files.
- Public API, config keys or schema changed → docs and migrations updated?

## 4. Report

- Each check: command → pass/fail. On failure, the first relevant error (`file:line`) and your assessment.
- Never claim something passed that you did not run. If a check could not run, say why.
