#!/usr/bin/env node
// Installs the Claude Code plan automation into ~/.claude (or $CLAUDE_CONFIG_DIR).
// It copies only the files in ./payload, backs up anything it would overwrite, and adds one
// SessionStart hook to settings.json. It never touches the rest of settings.json, history or projects.
//   npx github:kaviyarasu-dev/kaviyarasu-dev            install or update
//   npx github:kaviyarasu-dev/kaviyarasu-dev --dry-run   show what would change
//   npx github:kaviyarasu-dev/kaviyarasu-dev --uninstall  remove what this installer added
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const payload = path.join(here, 'payload');
const version = JSON.parse(fs.readFileSync(path.join(here, '..', 'package.json'), 'utf8')).version;
const args = new Set(process.argv.slice(2));
const dry = args.has('--dry-run');
const uninstall = args.has('--uninstall');
const target = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupDir = path.join(target, 'backups', `plan-automation-${stamp}`);
const receiptPath = path.join(target, '.plan-automation.json');
const HOOK_CMD = 'bash "$HOME/.claude/hooks/planning-context.sh"';

const say = (m) => console.log(m);
const warn = (m) => console.log(`WARN  ${m}`);
const fail = (m) => { console.error(`ERROR ${m}`); process.exit(1); };

function walk(dir, base = dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p, base) : [path.relative(base, p).split(path.sep).join('/')];
  });
}

function run(cmd, a) {
  const r = spawnSync(cmd, a, { encoding: 'utf8', shell: process.platform === 'win32' });
  return r.status === 0 ? (r.stdout || '').trim() : null;
}

function checkPrereqs() {
  if (Number(process.versions.node.split('.')[0]) < 20) fail(`Node 20 or newer is required (you have ${process.versions.node}).`);
  if (!run('git', ['--version'])) fail('git is not installed or not on PATH.');
  if (!run('claude', ['--version'])) warn('The "claude" command was not found on PATH. Install Claude Code before you run a plan.');
  if (process.platform === 'win32') {
    const w = run('where', ['git']) || '';
    const found = w.split(/\r?\n/).filter(Boolean).some((g) => {
      const root = path.dirname(path.dirname(g));
      return fs.existsSync(path.join(root, 'bin', 'bash.exe')) || fs.existsSync(path.join(root, 'usr', 'bin', 'bash.exe'));
    });
    if (!found) warn('Git Bash was not found. Claude Code on Windows needs Git for Windows (it includes Git Bash).');
  }
}

function readSettings() {
  const p = path.join(target, 'settings.json');
  if (!fs.existsSync(p)) return { path: p, data: {}, exists: false };
  try { return { path: p, data: JSON.parse(fs.readFileSync(p, 'utf8')), exists: true }; }
  catch { return { path: p, data: null, exists: true }; }
}

function hookPresent(data) {
  return (data.hooks?.SessionStart || []).some((g) => (g.hooks || []).some((h) => String(h.command || '').includes('planning-context.sh')));
}

function saveSettings(s) {
  if (dry) return;
  if (s.exists) { fs.mkdirSync(backupDir, { recursive: true }); fs.copyFileSync(s.path, path.join(backupDir, 'settings.json')); }
  fs.writeFileSync(s.path, JSON.stringify(s.data, null, 2) + '\n');
}

function install() {
  checkPrereqs();
  const files = walk(payload);
  let added = 0, updated = 0, same = 0;
  for (const rel of files) {
    const src = path.join(payload, rel);
    const dst = path.join(target, rel);
    const content = fs.readFileSync(src);
    if (fs.existsSync(dst)) {
      if (fs.readFileSync(dst).equals(content)) { same++; continue; }
      if (!dry) {
        const b = path.join(backupDir, rel);
        fs.mkdirSync(path.dirname(b), { recursive: true });
        fs.copyFileSync(dst, b);
      }
      updated++; say(`update ${rel}`);
    } else { added++; say(`add    ${rel}`); }
    if (!dry) { fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.writeFileSync(dst, content); }
  }
  if (!dry) { try { fs.chmodSync(path.join(target, 'hooks', 'planning-context.sh'), 0o755); } catch { /* windows */ } }

  const s = readSettings();
  if (s.data === null) {
    warn(`${s.path} is not plain JSON, so it was left alone. Add this under "hooks" by hand:`);
    say(`  "SessionStart": [{ "matcher": "compact", "hooks": [{ "type": "command", "command": ${JSON.stringify(HOOK_CMD)} }] }]`);
  } else if (!hookPresent(s.data)) {
    s.data.hooks ??= {};
    s.data.hooks.SessionStart ??= [];
    s.data.hooks.SessionStart.push({ matcher: 'compact', hooks: [{ type: 'command', command: HOOK_CMD }] });
    saveSettings(s); say('add    settings.json hook (SessionStart, compact)');
  }

  if (!dry) fs.writeFileSync(receiptPath, JSON.stringify({ version, installedAt: new Date().toISOString(), files }, null, 2) + '\n');
  const check = dry ? 0 : spawnSync(process.execPath, ['--check', path.join(target, 'tools', 'plan-runner', 'run.mjs')]).status;
  say(`\n${dry ? '[dry run] ' : ''}Plan automation v${version}: ${added} added, ${updated} updated, ${same} unchanged.`);
  if (updated && !dry) say(`Old copies are in ${backupDir}`);
  if (check !== 0) fail('Installed run.mjs failed its syntax check.');
  say('\nNext: restart Claude Code, then use /plan-feature <idea>, /plan-split <slug>, and run the plan with:');
  say('  node ~/.claude/tools/plan-runner/run.mjs run <slug>');
  say('Update later by running the same command again.');
}

function remove() {
  if (!fs.existsSync(receiptPath)) fail('Nothing to remove: no receipt found. This installer has not run here.');
  const { files } = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
  for (const rel of files) {
    const p = path.join(target, rel);
    if (fs.existsSync(p)) { say(`remove ${rel}`); if (!dry) fs.rmSync(p); }
  }
  const s = readSettings();
  if (s.data && hookPresent(s.data)) {
    s.data.hooks.SessionStart = s.data.hooks.SessionStart
      .map((g) => ({ ...g, hooks: (g.hooks || []).filter((h) => !String(h.command || '').includes('planning-context.sh')) }))
      .filter((g) => g.hooks.length);
    if (!s.data.hooks.SessionStart.length) delete s.data.hooks.SessionStart;
    saveSettings(s); say('remove settings.json hook');
  }
  if (!dry) fs.rmSync(receiptPath);
  say(`\n${dry ? '[dry run] ' : ''}Removed. Run history in ${path.join(target, 'plan-runs')} was kept.`);
}

say(`Claude plan automation v${version} -> ${target}${dry ? ' (dry run)' : ''}`);
uninstall ? remove() : install();
