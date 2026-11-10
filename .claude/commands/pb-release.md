---
description: Release a new version — bump version, update PLAN, test, commit, tag, push to GitHub
argument-hint: <patch|minor|major|x.y.z>
---

Version: $ARGUMENTS (default `patch`)

1. Check that `git status` is clean apart from expected changes, and that you are on `main`.
2. `npm test` must pass.
3. Compute the new version from `package.json`; update `version` in `package.json` and `package-lock.json` (`npm version <x> --no-git-tag-version`).
4. Update the status line at the top of `docs/PLAN.md` if needed; list changes from `git log <previous tag>..HEAD --oneline`.
5. **Ask the user to confirm** the version + change list before committing/pushing (public repo).
6. Commit `release: vX.Y.Z` with `-c user.name=hienct-fpt -c user.email=hienct-fpt@users.noreply.github.com`, create tag `vX.Y.Z`, `git push --follow-tags`.
7. Check the diff contains no personal information / client project names before pushing.
