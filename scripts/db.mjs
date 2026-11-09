#!/usr/bin/env node
// Read-only SQL against brain.db — for debugging ingest / dashboard numbers.
//
//   node scripts/db.mjs "<SELECT …>"            dev DB (src/brain.db)
//   node scripts/db.mjs --installed "<SELECT …>" installed DB (~/.personal-brain/brain.db, or --dir <path>)
//   node scripts/db.mjs --tables                 list tables with row counts
//   node scripts/db.mjs --schema <table>         show columns of a table
//
// The DB is opened read-only, so this never changes data. Output: console.table (max 200 rows) or --json.
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = (n) => { const i = argv.indexOf(n); if (i >= 0) argv.splice(i, 1); return i >= 0; };
const opt = (n) => { const i = argv.indexOf(n); if (i < 0) return null; const v = argv[i + 1]; argv.splice(i, 2); return v; };

const dir = opt('--dir');
const installed = flag('--installed');
const asJson = flag('--json');
const tables = flag('--tables');
const schema = opt('--schema');
const file = dir ? join(resolve(dir.replace(/^~/, homedir())), 'brain.db')
  : installed ? join(homedir(), '.personal-brain', 'brain.db') : join(root, 'src', 'brain.db');
if (!existsSync(file)) { console.error(`✗ Không có ${file}${installed || dir ? '' : ' — chạy `npm run ingest` để tạo DB dev'}`); process.exit(1); }

const db = new DatabaseSync(file, { readOnly: true });
let sql = argv.join(' ').trim();
if (tables) sql = "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name";
if (schema) sql = `PRAGMA table_info(${JSON.stringify(schema)})`;
if (!sql) { console.error('Cách dùng: node scripts/db.mjs [--installed | --dir <path>] [--json] "<SELECT …>" | --tables | --schema <table>'); process.exit(1); }

try {
  let rows = db.prepare(sql).all();
  if (tables) rows = rows.map((r) => ({ table: r.name, rows: db.prepare(`SELECT COUNT(*) n FROM "${r.name}"`).get().n }));
  console.error(`# ${file} · ${rows.length} dòng`);
  if (asJson) console.log(JSON.stringify(rows, null, 2));
  else console.table(rows.slice(0, 200).map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === 'string' && v.length > 80 ? v.slice(0, 77) + '…' : v]))));
  if (!asJson && rows.length > 200) console.error(`… còn ${rows.length - 200} dòng (dùng LIMIT hoặc --json)`);
} catch (e) { console.error(`✗ ${e.message}`); process.exit(1); }
finally { db.close(); }
