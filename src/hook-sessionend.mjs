// Claude Code SessionEnd hook: archive the just-finished session into brain.db even when the dashboard
// server is not running (transcripts are deleted by Claude Code after cleanupPeriodDays, default 30).
// Never blocks or fails the session: spawns ingest detached and exits 0 immediately.
import { spawn } from 'node:child_process';
import { openSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

try {
  const here = dirname(fileURLToPath(import.meta.url));
  const log = openSync(join(here, 'ingest-hook.log'), 'a');
  spawn(process.execPath, ['--no-warnings', join(here, 'ingest.mjs')], {
    cwd: here, detached: true, stdio: ['ignore', log, log], windowsHide: true,
  }).unref();
} catch { /* never break the user's session */ }
process.exit(0);
