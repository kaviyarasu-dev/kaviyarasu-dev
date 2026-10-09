// Checks the runner runs ITSELF after a session. A session saying "done" counts for nothing
// until every one of these passes.
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { changedBetween } from './git.mjs';
import { killTree } from './claude.mjs';
import { log, matchesAny, tail } from './util.mjs';

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
 * Scope gate. Everything a session changed must be inside the plan's allowed_paths.
 * Always forbidden: .claude/, .env files, .git/, the manifest and plan files.
 * package.json and package-lock.json are always allowed (installs are permitted) and are
 * reported separately as new dependencies.
 */
export function scopeCheck({ changed, allowed, extra = [], planDirRel, primaryName }) {
  const allow = [...allowed, ...extra, '**/package.json', '**/package-lock.json'];
  const forbidden = ['**/.claude/**', '**/.env', '**/.env.*', '**/.git/**', `${primaryName}/${planDirRel}/**`];
  const violations = [];
  for (const p of changed) {
    if (p === `${primaryName}/${planDirRel}/BLOCKED.md`) continue; // the one file a session may write there
    if (matchesAny(forbidden, p)) violations.push(`${p}  (forbidden area)`);
    else if (!matchesAny(allow, p)) violations.push(`${p}  (outside allowed_paths)`);
  }
  return { ok: violations.length === 0, violations };
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
    const r = await runCommand({ cwd, cmd: c.cmd, env, timeoutMs: (c.timeout_min || 10) * 60 * 1000 });
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
