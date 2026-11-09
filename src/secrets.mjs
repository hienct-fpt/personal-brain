// API key storage, one key per AI provider. On Windows each key is encrypted with DPAPI (CurrentUser scope)
// via .NET ProtectedData, so secrets.json is useless if copied to another machine/user. Keys are passed to
// PowerShell through env vars, never on the command line. Other OSes: plaintext file with 0600 permissions.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { HOME } from './lib.mjs';

const FILE = join(HOME, 'secrets.json');
const WIN = process.platform === 'win32';

function ps(script, env) {
  const { PSModulePath, ...base } = process.env; // pwsh 7's module path breaks Windows PowerShell 5.1
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Add-Type -AssemblyName System.Security; ' + script],
    { env: { ...base, ...env }, encoding: 'utf8', windowsHide: true }).trim();
}
const PROTECT = "[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($env:PB_KEY), $null, 'CurrentUser'))";
const UNPROTECT = "[Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($env:PB_ENC), $null, 'CurrentUser'))";

// file format: { providers: { <id>: { dpapi | apiKey, savedAt } } }  (legacy v0.5: { dpapi } = anthropic)
function readFile() {
  if (!existsSync(FILE)) return { providers: {} };
  const s = JSON.parse(readFileSync(FILE, 'utf8'));
  if (!s.providers) return { providers: s.dpapi || s.apiKey ? { anthropic: s } : {} };
  return s;
}

const cache = new Map(); // provider → key | null
export function getApiKey(provider) {
  if (cache.has(provider)) return cache.get(provider);
  let key = null;
  try {
    const e = readFile().providers[provider];
    if (e) key = e.dpapi ? ps(UNPROTECT, { PB_ENC: e.dpapi }) : e.apiKey ?? null;
  } catch (err) { console.error(`Không đọc được API key (${provider}):`, err.message); }
  cache.set(provider, key);
  return key;
}

export function setApiKey(provider, key) {
  const s = readFile();
  if (!key) delete s.providers[provider];
  else s.providers[provider] = WIN ? { dpapi: ps(PROTECT, { PB_KEY: key }), savedAt: Date.now() } : { apiKey: key, savedAt: Date.now() };
  writeFileSync(FILE, JSON.stringify(s), { mode: 0o600 });
  cache.set(provider, key || null);
}

export const storedProviders = () => Object.keys(readFile().providers);
export const keyHint = (k) => (k ? (k.length > 16 ? `${k.slice(0, 7)}…${k.slice(-4)}` : '••••' + k.slice(-2)) : null);
