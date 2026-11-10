---
description: Install the working copy into ~/.personal-brain (keeps data) and verify the install
allowed-tools: Bash(npm test:*), Bash(node scripts/install.mjs:*), Bash(git status:*), Bash(git log:*)
---

1. Run `npm test`; if it fails, stop and report the error.
2. If `git status` shows uncommitted changes, say that the install will be labeled `-dirty`.
3. Run `node scripts/install.mjs` (on Windows, `install.cmd` cannot be called from this shell).
4. Check that `~/.personal-brain/version.json` matches the current commit, and `claude mcp get personal-brain` reports Connected.
5. Report the result. If the installer says an old server is running in a window, remind the user to Ctrl+C that window and run `brain` again — do not kill the process yourself.
