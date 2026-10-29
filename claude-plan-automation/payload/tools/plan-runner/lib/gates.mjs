// Checks the runner runs ITSELF after a session. A session saying "done" counts for nothing
// until every one of these passes.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { branch, changedBetween, head } from './git.mjs';
import { killTree } from './claude.mjs';
import { log, matchesAny, tail } from './util.mjs';

/**
 * Plan commands may say {{runner}} for the folder this runner is installed in (for example
 * node "{{runner}}/assert.mjs" has ...), so a plan folder holds no machine-specific path.
 */
export const RUNNER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..').split(path.sep).join('/');
export const expandRunner = (cmd) => String(cmd).replaceAll('{{runner}}', RUNNER_DIR);

/** Accepts "cmd" or { repo, cmd, if_changed, timeout_min }. */
export function normCmd(c, defaultRepo) {
  if (typeof c === 'string') return { repo: defaultRepo, cmd: c };
  return { repo: c.repo || defaultRepo, cmd: c.cmd, if_changed: c.if_changed, timeout_min: c.timeout_min };
}

export function runCommand({ cwd, cmd, env, timeoutMs = 10 * 60 * 1000 }) {
  return new Promise((resolve) => {
    const child = spawn(cmd, { cwd, env, shell: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let timedOut = false;
    const add = (d) => { out = (out + d.toString('utf8')).slice(-20000); };
    child.stdout.on('data', add);
    child.stderr.on('data', add);
    const t = setTimeout(() => { timedOut = true; killTree(child.pid); }, timeoutMs);
    child.on('error', (e) => { out += `\n${e.message}`; });
    child.on('close', (code) => {
      clearTimeout(t);
      resolve({ ok: code === 0 && !timedOut, code, out, timedOut });
    });
  });
}

/** Full repo-prefixed paths changed between two sets of trees. */
export function changedPaths(repos, fromTrees, toTrees) {
  const out = [];
  for (const [name, dir] of Object.entries(repos)) {
    if (!fromTrees[name] || !toTrees[name]) continue;
    for (const c of changedBetween(dir, fromTrees[name], toTrees[name])) out.push(`${name}/${c.path}`);
  }
  return out;
}

/**
 * Scope gate. A session may change any file in the project repos except BLOCKED_PATHS: the runner's own safety net
 * (.git), real secrets (.env, .env.* but not the .env.example family), the plan folder (only BLOCKED.md may be written
 * there), and the agent files that change how the NEXT session behaves (settings, hooks, sub-agents, skills, commands).
 * Rule and doc files under .claude/ and .agents/ are open. A change outside the plan's allowed_paths is not a failure:
 * it is returned as `outside` so the report can show it. Dependency manifests and lock files (DEP_FILES) are never
 * "outside", because installs are permitted; they are reported separately as changed dependencies.
 */
export const DEP_FILES = [
  'package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lock', 'bun.lockb',
  'composer.json', 'composer.lock', 'requirements.txt', 'pyproject.toml', 'poetry.lock', 'uv.lock', 'Pipfile', 'Pipfile.lock',
  'go.mod', 'go.sum', 'Cargo.toml', 'Cargo.lock', 'Gemfile', 'Gemfile.lock', 'packages.lock.json', 'pubspec.yaml', 'pubspec.lock',
  'mix.exs', 'mix.lock', 'Package.resolved', 'gradle.lockfile',
];

/** Example env files hold no secrets, so they are open (and not fingerprinted). */
export const ENV_EXAMPLES = ['**/.env.example', '**/.env.sample', '**/.env.template', '**/.env.dist'];
const isEnvExample = (name) => /^\.env\.(?:example|sample|template|dist)$/i.test(name);

export const BLOCKED_PATHS = [
  '**/.git/**', '**/.env', '**/.env.*',
  '**/.claude/settings*.json', '**/.claude/hooks/**', '**/.claude/agents/**', '**/.claude/skills/**', '**/.claude/commands/**',
  '**/.agents/hooks.json', '**/.agents/hooks/**', '**/.agents/skills/**', '**/.agents/workflows/**',
  '**/.agent/hooks.json', '**/.agent/hooks/**', '**/.agent/skills/**', '**/.agent/workflows/**', '**/.gemini/**',
];

/** Repo-prefixed path ("repo/x/y") -> null when the session may change it, else the reason it may not. */
export function blockedReason(p, { planDirRel, primaryName }) {
  if (p === `${primaryName}/${planDirRel}/BLOCKED.md`) return null; // the one file a session may write there
  if (p.startsWith(`${primaryName}/${planDirRel}/`)) return 'the plan folder is managed by the runner';
  const low = p.toLowerCase(); // Windows file names are not case-sensitive: .ENV is .env
  if (matchesAny(ENV_EXAMPLES, low)) return null;
  if (matchesAny(BLOCKED_PATHS, low)) return 'blocked file (git, secrets or agent settings)';
  return null;
}

export function scopeCheck({ changed, allowed, extra = [], planDirRel, primaryName }) {
  const allow = [...allowed, ...extra, ...DEP_FILES.map((f) => `**/${f}`)];
  const violations = [];
  const outside = [];
  for (const p of changed) {
    if (p === `${primaryName}/${planDirRel}/BLOCKED.md`) continue;
    const why = blockedReason(p, { planDirRel, primaryName });
    if (why) violations.push(`${p}  (${why})`);
    else if (!matchesAny(allow, p)) outside.push(p);
  }
  return { ok: violations.length === 0, violations, outside };
}

/** Run a list of commands in order. Stops at the first failure. */
export async function runList(list, { repos, defaultRepo, env, changed = [], label }) {
  for (const raw of list) {
    const c = normCmd(raw, defaultRepo);
    if (c.if_changed && !changed.some((p) => matchesAny(c.if_changed, p))) {
      log('Gate', `${label}: skipped "${c.cmd}" (no matching files changed)`);
      continue;
    }
    const cwd = repos[c.repo];
    if (!cwd) return { ok: false, failure: `${label}: unknown repo "${c.repo}" for command "${c.cmd}"` };
    log('Gate', `${label}: ${c.repo}> ${c.cmd}`);
    const r = await runCommand({ cwd, cmd: expandRunner(c.cmd), env, timeoutMs: (c.timeout_min || 10) * 60 * 1000 });
    if (!r.ok) {
      const why = r.timedOut ? 'timed out' : `exit code ${r.code}`;
      log('Gate', `FAILED (${why}): ${c.cmd}`);
      return { ok: false, failure: `${label} failed (${why}) in ${c.repo}: ${c.cmd}\n${tail(r.out)}` };
    }
  }
  return { ok: true };
}

/** php -l on every changed PHP file. Skipped quietly when php is not installed. */
export function phpLintChanged(repos, changed, env) {
  const probe = spawnSync('php', ['-v'], { encoding: 'utf8', windowsHide: true, env });
  if (probe.error) return { ok: true, skipped: true };
  for (const full of changed.filter((p) => p.endsWith('.php'))) {
    const [repo, ...rest] = full.split('/');
    const file = path.join(repos[repo], ...rest);
    const r = spawnSync('php', ['-l', file], { encoding: 'utf8', windowsHide: true, env });
    if (r.status !== 0) {
      // A deleted file cannot be linted; ignore that case.
      if (/Could not open input file/.test(r.stdout + r.stderr)) continue;
      return { ok: false, failure: `php -l failed on ${full}:\n${(r.stdout + r.stderr).trim()}` };
    }
  }
  return { ok: true };
}

/**
 * Secret files (.env, .env.*, not the .env.example family) in each repo root. Git ignores them, so the snapshot, the scope gate and the
 * rollback cannot see them. Fingerprint them before the run and compare after every plan.
 */
export function secretFingerprint(repos) {
  const out = {};
  for (const [name, dir] of Object.entries(repos)) {
    let files = [];
    try { files = fs.readdirSync(dir); } catch { continue; }
    for (const f of files.filter((x) => (x === '.env' || x.startsWith('.env.')) && !isEnvExample(x))) {
      try { out[`${name}/${f}`] = crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, f))).digest('hex'); } catch { /* unreadable */ }
    }
  }
  return out;
}

export function secretChanges(before, after) {
  const out = [];
  for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (!(k in after)) out.push(`${k} (deleted)`);
    else if (!(k in before)) out.push(`${k} (created)`);
    else if (before[k] !== after[k]) out.push(`${k} (changed)`);
  }
  return out;
}

/**
 * Branch and HEAD of every repo. A session must never commit, switch branch or reset. The deny rules refuse the git
 * commands, but a program the session runs (node -e, a test script) could still do it, so the runner checks the result.
 */
export function gitHeads(repos) {
  const out = {};
  for (const [name, dir] of Object.entries(repos)) {
    try { out[name] = { head: head(dir), branch: branch(dir) }; } catch { out[name] = { head: '(no commits)', branch: '(unknown)' }; }
  }
  return out;
}

export function headChanges(before, after) {
  const out = [];
  for (const [name, b] of Object.entries(before)) {
    const a = after[name];
    if (!a) continue;
    if (a.head !== b.head) out.push(`${name}: HEAD moved ${b.head.slice(0, 8)} -> ${a.head.slice(0, 8)}`);
    if (a.branch !== b.branch) out.push(`${name}: branch changed ${b.branch} -> ${a.branch}`);
  }
  return out;
}

/**
 * Git repos next to the project repos (in the same workspace folder) that are not part of the plan. A session must not
 * touch them. Shell commands cannot be fenced in on Windows, so the runner fingerprints these repos before a plan and
 * after every session. Best effort: it sees new, deleted and newly changed files and commits, not a second edit to a
 * file that was already changed before the run.
 */
export function otherRepos(workspace, repoDirs) {
  const own = new Set(repoDirs.map((d) => path.resolve(d).toLowerCase()));
  let entries = [];
  try { entries = fs.readdirSync(workspace, { withFileTypes: true }); } catch { return []; }
  return entries.filter((e) => e.isDirectory()).map((e) => path.join(workspace, e.name))
    .filter((d) => !own.has(path.resolve(d).toLowerCase()) && fs.existsSync(path.join(d, '.git')));
}

export function repoFingerprints(dirs) {
  const out = {};
  for (const d of dirs) {
    const env = { ...process.env, GIT_OPTIONAL_LOCKS: '0' }; // read only: do not refresh that repo's index
    const st = spawnSync('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], { cwd: d, env, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
    const hd = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: d, env, encoding: 'utf8', windowsHide: true });
    out[d] = crypto.createHash('sha256').update(`${hd.stdout || ''}
${st.stdout || ''}`).digest('hex');
  }
  return out;
}

export function fingerprintChanges(before, after) {
  return Object.keys(before).filter((d) => after[d] !== before[d]);
}
