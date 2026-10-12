#!/usr/bin/env node
// Installs the Antigravity (agy) plan automation into ~/.gemini (or $AGY_GEMINI_DIR).
// It copies only the files in ./payload, backs up anything it would overwrite, merges ONE named hook into
// config/hooks.json, and removes the old hand-copied files of the first Antigravity setup. It never touches your
// history, projects, auth, models, MCP servers, plugins or the rest of hooks.json and settings.json.
//   npx --yes https://github.com/kaviyarasu-dev/kaviyarasu-dev/tarball/main antigravity              install or update
//   npx --yes https://github.com/kaviyarasu-dev/kaviyarasu-dev/tarball/main antigravity --dry-run    show what would change
//   npx --yes https://github.com/kaviyarasu-dev/kaviyarasu-dev/tarball/main antigravity --uninstall  remove what this installer added
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_URL = process.env.KAVIYARASU_REPO_URL || 'https://github.com/kaviyarasu-dev/kaviyarasu-dev.git';
const here = path.dirname(fileURLToPath(import.meta.url));

// npx keeps an old copy of a URL it has already run and does not re-download it, so a teammate could get an
// out-of-date installer and payload. To always install the newest files, this script clones the repo (HTTPS, no ssh
// key needed) and runs the installer found in that clone. --local skips this step.
if (!process.argv.includes('--local')) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-plan-automation-'));
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  const clone = spawnSync('git', ['clone', '--depth', '1', '--quiet', REPO_URL, tmp], { env, encoding: 'utf8', timeout: 90000, shell: process.platform === 'win32' });
  const fresh = path.join(tmp, 'antigravity-setup', 'install.mjs');
  if (clone.status === 0 && fs.existsSync(fresh)) {
    const r = spawnSync(process.execPath, [fresh, '--local', ...process.argv.slice(2)], { stdio: 'inherit' });
    fs.rmSync(tmp, { recursive: true, force: true });
    process.exit(r.status ?? 1);
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('WARN  Could not download the latest files (is GitHub reachable?). Using the copy bundled with this command, which may be out of date.');
}

const payload = path.join(here, 'payload');
const version = JSON.parse(fs.readFileSync(path.join(here, '..', 'package.json'), 'utf8')).version;
const args = new Set(process.argv.slice(2));
const dry = args.has('--dry-run');
const uninstall = args.has('--uninstall');
const target = process.env.AGY_GEMINI_DIR || path.join(os.homedir(), '.gemini');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupDir = path.join(target, 'backups', `plan-automation-${stamp}`);
const receiptPath = path.join(target, '.plan-automation-antigravity.json');
const HOOK_NAME = 'kaviyarasu-plan-automation';
// agy runs hook commands from the folder that holds hooks.json, so this path is relative and holds no user name.
const HOOK = { PreInvocation: [{ type: 'command', command: 'node scripts/planning-context.mjs', timeout: 5 }] };
// Files of the first, hand-copied Antigravity setup (relative to the target). Removed on install: the new skills and agents
// have the same names, and two copies would fight each other. They are kept in the repo under antigravity-setup/legacy/.
const LEGACY = [
  'config/scripts/plan-runner.js', 'config/scripts/plan-runner-2.js', 'config/scripts/validate-manifest.js', 'config/scripts/reminder_hook.js',
  'config/skills/plan_feature/SKILL.md', 'config/agents/plan_auditor.md', 'config/agents/plan_cold_reader.md', 'config/agents/plan_reviewer.md',
];

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

function findAgy() {
  const found = [];
  if (process.env.AGY_BIN) found.push(process.env.AGY_BIN);
  const w = run(process.platform === 'win32' ? 'where' : 'which', ['agy']) || '';
  found.push(...w.split(/\r?\n/).filter(Boolean));
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) found.push(path.join(process.env.LOCALAPPDATA, 'agy', 'bin', 'agy.exe'));
  return found.find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } }) || null;
}

function checkPrereqs() {
  if (Number(process.versions.node.split('.')[0]) < 20) fail(`Node 20 or newer is required (you have ${process.versions.node}).`);
  if (!run('git', ['--version'])) fail('git is not installed or not on PATH.');
  if (!findAgy()) warn('The "agy" command was not found. Install Antigravity CLI before you run a plan. (Set AGY_BIN if it lives somewhere unusual.)');
}

function readHooks() {
  const p = path.join(target, 'config', 'hooks.json');
  if (!fs.existsSync(p)) return { path: p, data: {}, exists: false };
  try { return { path: p, data: JSON.parse(fs.readFileSync(p, 'utf8').replace(/^﻿/, '')), exists: true }; }
  catch { return { path: p, data: null, exists: true }; }
}

function saveHooks(h) {
  if (dry) return;
  if (h.exists) { fs.mkdirSync(backupDir, { recursive: true }); fs.copyFileSync(h.path, path.join(backupDir, 'hooks.json')); }
  fs.mkdirSync(path.dirname(h.path), { recursive: true });
  fs.writeFileSync(h.path, `${JSON.stringify(h.data, null, 2)}\n`);
}

const isLegacyEntry = (e) => String(e?.command || '').includes('reminder_hook.js');

/** Drops the old PreInvocation reminder (first setup wrote it as a top-level event key) from a parsed hooks.json. Returns true when it changed. */
function dropLegacyHook(data) {
  if (!Array.isArray(data.PreInvocation)) return false;
  const kept = data.PreInvocation.filter((e) => !isLegacyEntry(e));
  if (kept.length === data.PreInvocation.length) return false;
  if (kept.length) data.PreInvocation = kept; else delete data.PreInvocation;
  return true;
}

function pruneEmpty(dir, stop) {
  let d = dir;
  while (d.startsWith(stop) && d !== stop) {
    try { if (fs.readdirSync(d).length) return; fs.rmdirSync(d); } catch { return; }
    d = path.dirname(d);
  }
}

function install() {
  checkPrereqs();
  const files = walk(payload);
  let added = 0, updated = 0, same = 0;
  const touched = [];
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
      updated++; touched.push(rel); say(`update ${rel}`);
    } else { added++; touched.push(rel); say(`add    ${rel}`); }
    if (!dry) { fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.writeFileSync(dst, content); }
  }

  // the first Antigravity setup: known files only, no backup (the originals are in the repo under antigravity-setup/legacy/)
  const removed = [];
  for (const rel of LEGACY) {
    const p = path.join(target, rel);
    if (!fs.existsSync(p)) continue;
    say(`remove old ${rel}`);
    removed.push(rel);
    if (!dry) { fs.rmSync(p); pruneEmpty(path.dirname(p), path.join(target, 'config')); }
  }

  const h = readHooks();
  if (h.data === null) {
    warn(`${h.path} is not plain JSON, so it was left alone. Add this by hand:`);
    say(`  ${JSON.stringify({ [HOOK_NAME]: HOOK })}`);
  } else {
    const legacy = dropLegacyHook(h.data);
    const current = JSON.stringify(h.data[HOOK_NAME]) === JSON.stringify(HOOK);
    if (legacy) say('remove old reminder hook from hooks.json');
    if (!current) { h.data[HOOK_NAME] = HOOK; say(`add    hooks.json ${HOOK_NAME} (PreInvocation)`); }
    if (legacy || !current) saveHooks(h);
  }

  if (!dry) fs.writeFileSync(receiptPath, `${JSON.stringify({ version, installedAt: new Date().toISOString(), files, hook: h.data === null ? null : HOOK_NAME, removedLegacy: removed }, null, 2)}\n`);
  let check = 0;
  if (!dry) {
    for (const rel of touched.filter((f) => f.endsWith('.mjs'))) { // only what this run wrote
      if (spawnSync(process.execPath, ['--check', path.join(target, rel)]).status !== 0) { check++; warn(`${rel} failed its syntax check.`); }
    }
  }
  say(`\n${dry ? '[dry run] ' : ''}Antigravity plan automation v${version}: ${added} added, ${updated} updated, ${same} unchanged, ${removed.length} old file(s) removed.`);
  if (updated && !dry) say(`Old copies of changed files are in ${backupDir}`);
  if (check) fail('Some installed files failed their syntax check.');
  say('\nNext: restart agy, then use /plan-feature <idea> and /plan-split <slug>, and run the plan from a separate terminal:');
  say('  node $HOME/.gemini/tools/plan-runner/run.mjs run <slug>');
  say('($HOME works in PowerShell and in Git Bash; do not use ~.) Update later by running the same install command again.');
}

function remove() {
  if (!fs.existsSync(receiptPath)) fail('Nothing to remove: no receipt found. This installer has not run here.');
  const { files, hook } = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
  for (const rel of files) {
    const p = path.join(target, rel);
    if (fs.existsSync(p)) { say(`remove ${rel}`); if (!dry) { fs.rmSync(p); pruneEmpty(path.dirname(p), target); } }
  }
  const h = readHooks();
  if (h.data && hook && h.data[hook]) {
    delete h.data[hook];
    saveHooks(h); say(`remove hooks.json ${hook}`);
  }
  if (!dry) fs.rmSync(receiptPath);
  say(`\n${dry ? '[dry run] ' : ''}Removed. Run history in ${path.join(target, 'plan-runs')} was kept. The old files of the first setup are not restored (they are in the repo under antigravity-setup/legacy/).`);
}

say(`Antigravity plan automation v${version} -> ${target}${dry ? ' (dry run)' : ''}`);
uninstall ? remove() : install();
