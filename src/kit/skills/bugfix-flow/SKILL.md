---
name: bugfix-flow
description: Disciplined bug-fixing process — reproduce, isolate the failing layer, fix the root cause, add a regression check, report honestly. Use when the user reports a bug, an error message, wrong output, a failing test, or "it used to work".
---

# Bug-fix flow

## 1. Reproduce

- Restate the symptom in one sentence: input → expected → actual.
- Reproduce it with the smallest command, test or request you can. Record the exact output.
- Cannot reproduce? Say so, list what you tried, and ask for the missing detail (version, data, steps) instead of guessing.

## 2. Isolate

- Walk the data path layer by layer (input → parsing → storage → logic → output/UI) and find the **first** layer where the data is wrong.
- Check recent changes: `git log -p --since=…` / `git diff` on the suspect files.
- Prefer evidence (logs, a quick query, a failing assertion) over reading code and speculating.

## 3. Fix the root cause

- Fix where the data first goes wrong, not where the symptom shows up.
- Keep the change minimal; no drive-by refactors.
- If the root cause is outside the code (config, data, environment), say so and propose the fix rather than patching around it.

## 4. Prevent regression

- Add or extend a test/check that fails before the fix and passes after.
- If no test harness exists, leave a reproducible command in the report.

## 5. Report

- Cause (one or two sentences), fix (files changed), how it was verified (command + result).
- Mention anything not verified or any follow-up risk.
