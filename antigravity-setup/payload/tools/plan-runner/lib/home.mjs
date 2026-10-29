// The throwaway HOME an unattended session runs in.
// agy has no flag for "refuse instead of ask", no per-run settings file and no way to skip the user's
// plugins, MCP servers and global rules. It does read everything from ~/.gemini, and it works with
// HOME / USERPROFILE pointed somewhere else (it signs in through the OS credential store). So each run
// gets its own folder with a generated settings.json (permissions) and hooks.json (the guard), and none of
// the user's own configuration reaches the session.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { agyCommand } from './agy.mjs';
import { writeJsonAtomic } from './util.mjs';

export const GUARD_FILES = ['guard.mjs', 'rules.mjs', 'util.mjs'];
// Copied from the real home when present: git identity and settings the project's own git commands may need.
// Never copied: .npmrc, .netrc, .ssh, .aws and anything else that can hold a credential.
const COPY_FROM_HOME = ['.gitconfig'];
// Names that look like secrets are removed from the session's environment. The Gemini sign-in variables stay.
const SECRET_NAME = /(?:token|secret|passw(?:or)?d|credential|private[_-]?key|api[_-]?key|auth)/i;
const KEEP = /^(?:GEMINI_API_KEY|GOOGLE_API_KEY|GOOGLE_APPLICATION_CREDENTIALS|GOOGLE_GENAI_USE_VERTEXAI|GOOGLE_CLOUD_\w+|SSH_AUTH_SOCK|PLAN_RUNNER\w*|AGY_\w+)$/;

export function scrubEnv(env) {
  const out = {};
  for (const [k, v] of Object.entries(env)) {
    if (SECRET_NAME.test(k) && !KEEP.test(k)) continue;
    out[k] = v;
  }
  return out;
}

/** Writes settings.json, hooks.json and the guard files into <dir>/.gemini. Safe to call before every session. */
export function buildSessionHome({ dir, permissions, manifestDeny = [], libDir, readOnly = false, scope = null, realHome = os.homedir() }) {
  const cli = path.join(dir, '.gemini', 'antigravity-cli');
  const cfg = path.join(dir, '.gemini', 'config');
  fs.mkdirSync(cli, { recursive: true });
  fs.mkdirSync(cfg, { recursive: true });
  // Windows asks the profile for AppData\Local and Documents. When the folder is missing, PowerShell gets an empty path and
  // writes its cache (Microsoft\Windows\PowerShell\ModuleAnalysisCache) into the WORKSPACE, which the scope gate then
  // rejects (found in a real run). With the folders present the caches stay inside the throwaway HOME.
  if (process.platform === 'win32') for (const d of ['AppData\\Local', 'AppData\\Roaming', 'Documents']) fs.mkdirSync(path.join(dir, d), { recursive: true });
  // agy allows file edits inside the workspace by itself, so a read-only session needs explicit deny rules (deny wins over allow).
  const deny = [...(permissions.settings_deny || []), ...(readOnly ? ['write_file(*)', 'command(*)'] : [])];
  writeJsonAtomic(path.join(cli, 'settings.json'), { permissions: { allow: readOnly ? [] : permissions.allow, deny } });
  for (const f of GUARD_FILES) fs.copyFileSync(path.join(libDir, f), path.join(cfg, f));
  writeJsonAtomic(path.join(cfg, 'guard-rules.json'), { permissions, manifestDeny, readOnly, scope });
  // agy runs "node guard.mjs" from the folder that holds hooks.json, so there is no path (and no quoting problem) in the command.
  writeJsonAtomic(path.join(cfg, 'hooks.json'), {
    'plan-runner-guard': { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'node guard.mjs', timeout: 30 }] }] },
  });
  for (const f of COPY_FROM_HOME) {
    const src = path.join(realHome, f);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(dir, f));
  }
  return { cfgDir: cfg, settingsPath: path.join(cli, 'settings.json'), deniedLog: path.join(cfg, 'guard-denied.log') };
}

/**
 * The environment for the agy process: the throwaway HOME, node on PATH for the guard hook, and the runner's own
 * environment without secret-looking variables. The manifest's "env" is added AFTER the scrub: it holds the
 * throwaway test values the plans are meant to use.
 */
export function sessionEnv(processEnv, manifestEnv, home) {
  const e = { ...scrubEnv(processEnv), ...manifestEnv };
  e.HOME = home;
  e.USERPROFILE = home;
  if (process.platform === 'win32') {
    const root = path.parse(home).root; // C:\
    e.HOMEDRIVE = root.replace(/[\\/]$/, '');
    e.HOMEPATH = `\\${home.slice(root.length)}`;
  }
  const pathKey = Object.keys(e).find((k) => k.toUpperCase() === 'PATH') || 'PATH';
  const nodeDir = path.dirname(process.execPath);
  if (!String(e[pathKey] || '').split(path.delimiter).includes(nodeDir)) e[pathKey] = `${nodeDir}${path.delimiter}${e[pathKey] || ''}`;
  return e;
}

/** Offline check that the guard hook really refuses and really lets normal commands through. No model usage. */
export function selfTestGuard(cfgDir, { readOnly = false } = {}) {
  const ask = (name, args) => {
    const r = spawnSync(process.execPath, [path.join(cfgDir, 'guard.mjs')], {
      input: JSON.stringify({ toolCall: { name, args } }), cwd: cfgDir, encoding: 'utf8', windowsHide: true, timeout: 60000,
    });
    try { return JSON.parse(r.stdout).decision; } catch { return `no answer (${(r.stderr || '').slice(0, 120)})`; }
  };
  if (readOnly) { // the review session: nothing but reading
    const cmd = ask('run_command', { CommandLine: 'node -v' });
    const write = ask('write_to_file', { TargetFile: path.join(cfgDir, 'x.txt') });
    const read = ask('view_file', { AbsolutePath: path.join(cfgDir, 'x.txt') });
    if (cmd !== 'deny' || write !== 'deny') return `the read-only guard allowed a command or a file write (answers: ${cmd}, ${write})`;
    if (read !== 'ask') return `the read-only guard refused a file read (answer: ${read})`;
    return null;
  }
  const denied = ask('run_command', { CommandLine: 'git commit -m x' });
  const allowed = ask('run_command', { CommandLine: 'node -v' });
  const secret = ask('write_to_file', { TargetFile: path.join(cfgDir, '..', '..', 'proj', '.env') });
  if (denied !== 'deny') return `the guard did not refuse "git commit" (answer: ${denied})`;
  if (allowed !== 'ask') return `the guard refused a normal command (answer: ${allowed})`;
  if (secret !== 'deny') return `the guard did not refuse writing a .env file (answer: ${secret})`;
  let rules = {};
  try { rules = JSON.parse(fs.readFileSync(path.join(cfgDir, 'guard-rules.json'), 'utf8')); } catch { /* checked below */ }
  if (rules.scope) { // a write outside the project (here: next to the drive root) must be refused
    const outside = ask('write_to_file', { TargetFile: path.join(path.parse(cfgDir).root, 'plan-runner-guard-selftest', 'x.txt') });
    if (outside !== 'deny') return `the guard did not refuse a file write outside the project (answer: ${outside})`;
  }
  return null;
}

/** `agy models` in the throwaway HOME: proves agy starts and signs in there, and lists the model names the manifest may use. */
export function probeAgy(env, cwd) {
  const [cmd, ...pre] = agyCommand();
  const r = spawnSync(cmd, [...pre, 'models'], { env, cwd, encoding: 'utf8', windowsHide: true, timeout: 90000, shell: /\.(cmd|bat)$/i.test(cmd) });
  if (r.error) return { ok: false, error: r.error.message, slugs: [] };
  const slugs = (r.stdout || '').split(/\r?\n/).map((l) => l.split(/\s+/)[0]).filter((s) => /^[a-z0-9][\w.-]*$/i.test(s) && s !== 'Fetching');
  if (r.status !== 0 || !slugs.length) return { ok: false, error: `exit ${r.status}: ${((r.stderr || '') + (r.stdout || '')).trim().slice(0, 300)}`, slugs };
  return { ok: true, slugs };
}
