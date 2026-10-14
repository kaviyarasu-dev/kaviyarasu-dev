#!/usr/bin/env node
// Unattended plan runner for Antigravity CLI (agy). Same plan folders and manifest as the Claude Code runner.
//   node run.mjs run <slug> [--repo <path>] [--dry-run] [--reset] [--no-isolation]
//   node run.mjs status <slug> [--repo <path>]
// Run it from inside the main repo (or pass --repo). Plans live in <repo>/docs/plans/<slug>/.
// Rules: one fresh `agy -p` session per plan, never trust "done", stop at the first failure,
// nothing is ever committed, everything is resumable.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateFolder } from './validate.mjs';
import { toplevel, isGitRepo, dirtyPaths, snapshot, restore, changedBetween, patchBetween, fileAt, branch } from './lib/git.mjs';
import { runAgy, agyCommand, killTree, activePids, quotaError, retryAfterMs } from './lib/agy.mjs';
import { buildSessionHome, sessionEnv, scrubEnv, selfTestGuard, probeAgy } from './lib/home.mjs';
import { changedPaths, scopeCheck, runList, phpLintChanged, DEP_FILES, secretFingerprint, secretChanges, gitHeads, headChanges, RUNNER_DIR } from './lib/gates.mjs';
import { runDirFor, loadState, saveState, loadCheckpoints, checkpointsPath, acquireLock } from './lib/state.mjs';
import { toast, keepAwake } from './lib/system.mjs';
import { log, setLogFile, sleep, readJson, writeJsonAtomic, toPosix, tail, fmtDuration } from './lib/util.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = path.join(HERE, 'lib');
const MAX_LIMIT_WAIT_MS = 12 * 3600 * 1000; // total time one run may wait for usage limits
// agy counts every tool call, Claude counts assistant turns. The manifest's turn numbers (est_turns, max_turns) are
// Claude turns, so they are multiplied by this to get tool calls.
const TOOL_CALLS_PER_TURN = 3;

class Halt extends Error {}

// ---------- args ----------
const argv = process.argv.slice(2);
const cmd = argv[0];
const flag = (n) => argv.includes(n);
const opt = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const slug = argv[1] && !argv[1].startsWith('--') ? argv[1] : undefined;
if (!['run', 'status'].includes(cmd) || !slug) {
  console.log('Usage:\n  node run.mjs run <slug> [--repo <path>] [--dry-run] [--reset] [--no-isolation]\n  node run.mjs status <slug> [--repo <path>]');
  process.exit(2);
}
const noIsolation = flag('--no-isolation');

const primary = toplevel(path.resolve(opt('--repo') || process.cwd()));
if (!primary) { console.log('Not inside a git repository. Run from the main repo or pass --repo <path>.'); process.exit(2); }
const primaryName = path.basename(primary);
const planDir = path.join(primary, 'docs', 'plans', slug);
const planDirRel = `docs/plans/${slug}`;
const runDir = runDirFor(primary, slug);

if (cmd === 'status') { printStatus(); process.exit(0); }

// ---------- main ----------
let releaseLock = () => {};
let stopAwake = () => {};
let ctx = null;

process.on('SIGINT', () => {
  console.log('\nInterrupted. Stopping the agy session; the plan is rolled back on the next start.');
  for (const pid of activePids) killTree(pid);
  try { if (ctx) { ctx.st.status = 'halted'; ctx.st.haltReason = 'interrupted by user (Ctrl+C)'; saveState(runDir, ctx.st); } } catch { /* ignore */ }
  stopAwake(); releaseLock();
  process.exit(130);
});

try {
  await main();
  process.exitCode = 0;
} catch (e) {
  if (e instanceof Halt) { process.exitCode = e.code ?? 1; }
  else { log('System', `Runner crashed: ${e.stack || e.message}`); process.exitCode = 1; }
} finally {
  stopAwake(); releaseLock();
}

async function main() {
  fs.mkdirSync(runDir, { recursive: true });
  setLogFile(path.join(runDir, 'run.log'));
  log('System', `Plan runner for "${slug}" in ${primary} (branch ${branch(primary)})`);

  // 1. plan folder must be valid and approved
  if (!fs.existsSync(planDir)) refuse(`Plan folder not found: ${planDir}`);
  const v = validateFolder(planDir, { workspace: path.dirname(primary) });
  for (const w of v.warnings) log('Validate', `WARN ${w}`);
  if (v.errors.length) { for (const e of v.errors) log('Validate', `ERROR ${e}`); refuse(`The plan folder is invalid (${v.errors.length} error(s)). Fix it first.`); }
  const statePlanning = path.join(planDir, '_planning', 'STATE.md');
  if (!fs.existsSync(statePlanning) || !/phase:\s*plans-approved/i.test(fs.readFileSync(statePlanning, 'utf8'))) {
    refuse('docs/plans/<slug>/_planning/STATE.md must say "phase: plans-approved". Finish /plan-split first.');
  }
  const manifest = readJson(path.join(planDir, 'manifest.json'));
  const modelsCfg = readJson(path.join(HERE, 'config', 'models.json'));
  const defaults = { max_attempts: 3, max_turns: 60, timeout_min: 45, idle_min: 15, model: modelsCfg.default, ...(manifest.defaults || {}) };
  const every = manifest.full_gates_every ?? 5;

  // 2. repos
  const names = [...new Set(manifest.plans.flatMap((p) => p.repos))];
  if (!names.includes(primaryName) && !manifest.plans.every((p) => p.repos.length)) refuse('No repos named in the manifest.');
  const repos = {};
  for (const n of names) {
    const dir = n === primaryName ? primary : path.join(path.dirname(primary), n);
    if (!fs.existsSync(dir) || !isGitRepo(dir)) refuse(`Repo folder "${n}" (${dir}) is missing or not a git repository.`);
    repos[n] = path.normalize(toplevel(dir));
  }
  if (!repos[primaryName]) repos[primaryName] = primary; // the plan folder lives here, so it is always guarded

  // 3. test-database guard: the test values must differ from the project's real ones
  const env = { ...manifest.env };
  for (const key of manifest.isolate || []) {
    const val = env[key];
    if (!val) refuse(`isolate key ${key} has no value in manifest "env".`);
    if (process.env[key] === val) refuse(`${key}="${val}" equals the value already in your shell environment.`);
    for (const [n, dir] of Object.entries(repos)) {
      const real = readEnvFile(path.join(dir, '.env'))[key];
      if (real !== undefined && real === val) refuse(`${key}="${val}" is the REAL value in ${n}/.env. Unattended runs must use a separate throwaway value.`);
    }
    log('System', `Isolation OK: ${key}=${val} differs from the real project value.`);
  }

  // 4. lock + keep awake
  try { releaseLock = acquireLock(runDir); } catch (e) { refuse(e.message); }
  stopAwake = keepAwake();

  // 5. agy, its models and the throwaway HOME (no model usage)
  if (flag('--reset') && fs.existsSync(path.join(runDir, 'state.json'))) {
    fs.rmSync(path.join(runDir, 'state.json'));
    for (const d of ['plans', 'agy-home', 'agy-home-review']) fs.rmSync(path.join(runDir, d), { recursive: true, force: true });
    log('System', 'Previous run state discarded (--reset).');
  }
  const perms = readJson(path.join(HERE, 'config', 'permissions.json'));
  ctx = { st: null, repos, manifest, defaults, env, modelsCfg, perms };
  preflight();

  // 6. state
  let st = loadState(runDir);
  const idxFile = (n) => path.join(runDir, 'index', n);
  const snapAll = () => Object.fromEntries(Object.entries(repos).map(([n, d]) => [n, snapshot(d, idxFile(n))]));
  const equalTrees = (a, b) => Object.keys(repos).every((n) => a?.[n] === b?.[n]);

  if (!st) {
    for (const [n, d] of Object.entries(repos)) {
      const dirty = dirtyPaths(d, { ignorePrefixes: n === primaryName ? ['docs/plans/'] : [] });
      if (dirty.length) refuse(`${n} has uncommitted changes (${dirty.slice(0, 5).join(', ')}${dirty.length > 5 ? ', ...' : ''}). Commit or stash them first, so a rollback can never lose your work.`);
    }
    const trees = snapAll();
    st = { feature: slug, primary, created: new Date().toISOString(), status: 'running', setupDone: false, baseTrees: trees, lastGoodTrees: trees,
      doneSinceSweep: 0, sweepPending: false, waitedMs: 0, plans: {}, repos, isolation: noIsolation ? 'none' : 'throwaway HOME' };
    saveState(runDir, st);
    log('System', 'Fresh run. Both repos were clean.');
  } else {
    if (st.status === 'complete') { log('System', 'This run is already complete. Use --reset to run it again.'); return; }
    st.status = 'running'; st.haltReason = null;
    // finish a plan the last process died in
    const running = Object.entries(st.plans).find(([, p]) => p.status === 'running');
    if (running) log('System', `Plan ${running[0]} was interrupted. It will be rolled back to its last good point.`);
    else {
      const cur = snapAll();
      for (const [n, d] of Object.entries(repos)) {
        const diff = changedBetween(d, st.lastGoodTrees[n], cur[n]).map((c) => c.path)
          .filter((p) => !(n === primaryName && p.startsWith(`${planDirRel}/`)));
        if (diff.length) refuse(`Files changed in ${n} since the runner last stopped: ${diff.slice(0, 8).join(', ')}. Undo those edits, or run with --reset.`);
      }
      st.lastGoodTrees = cur; // only plan-folder edits differ; accept them
    }
    for (const p of Object.values(st.plans)) if (p.status === 'failed' || p.status === 'blocked') { p.status = 'pending'; p.attempts = 0; p.sessions = 0; p.continuations = 0; p.limitWaits = 0; }
    saveState(runDir, st);
  }

  Object.assign(ctx, { st, snapAll, equalTrees, idxFile, every, secretsBefore: secretFingerprint(repos) });

  if (flag('--dry-run')) {
    log('System', 'Dry run. agy, the models and the guard are OK. Order of plans:');
    for (const p of manifest.plans) log('System', `  ${p.id} ${p.file} [${p.repos.join(',')}] model=${modelFor(p)} est_turns=${p.est_turns} steps=${p.steps.length}`);
    return;
  }

  // 7. one-time setup (create the throwaway database, apply migrations, ...)
  if (!st.setupDone && (manifest.setup || []).length) {
    log('System', 'Running one-time setup commands.');
    const r = await runList(manifest.setup, { repos, defaultRepo: primaryName, env: gateEnv(), label: 'setup' });
    if (!r.ok) halt(`Setup failed.\n${r.failure}`);
    st.setupDone = true; saveState(runDir, st);
  }

  // 8. the plans, strictly in order
  if (st.sweepPending) await sweep(`before resuming`);
  for (const plan of manifest.plans) {
    const ps = (st.plans[plan.id] ||= { status: 'pending', attempts: 0, sessions: 0, continuations: 0, limitWaits: 0, turns: 0, refused: 0, patches: [] });
    if (ps.status === 'done') continue;
    for (const d of plan.depends_on) if (st.plans[d]?.status !== 'done') halt(`Plan ${plan.id} depends on ${d}, which is not done.`);
    await executePlan(plan, ps);
  }

  // 9. finish
  await sweep('after the last plan');
  await finalReview();
  st.status = 'complete'; st.finished = new Date().toISOString(); saveState(runDir, st);
  writeReport('COMPLETE');
  toast('Plan run complete', `${slug}: all ${manifest.plans.length} plans done. Review the report, then commit.`);
  log('System', `All plans done. Report: ${path.join(runDir, 'REPORT.md')}`);
}

// ---------- agy, models, the throwaway HOME ----------
function modelFor(plan) {
  const { modelsCfg, defaults } = ctx;
  const name = plan.agy_model || plan.model || defaults.agy_model || defaults.model;
  return modelsCfg.models[name] || name;
}
function reviewModel() { return ctx.modelsCfg.models[ctx.modelsCfg.review] || ctx.modelsCfg.review; }

function homeDir(review = false) { return path.join(runDir, review ? 'agy-home-review' : 'agy-home'); }

/** Everything that can be checked without spending model usage. Refuses to start when something is wrong. */
function preflight() {
  const { manifest, perms } = ctx;
  try { agyCommand(); } catch (e) { refuse(e.message); }
  let env;
  if (noIsolation) {
    log('System', 'WARNING: --no-isolation. The session uses your own agy settings, plugins and permissions and is NOT restricted by the deny rules. Only the runner-side checks protect your files.');
    env = { ...scrubEnv(process.env), ...ctx.env };
  } else {
    const built = buildSessionHome({ dir: homeDir(), permissions: perms, manifestDeny: manifest.permissions?.deny || [], libDir: LIB });
    const bad = selfTestGuard(built.cfgDir);
    if (bad) refuse(`The safety guard failed its self-test: ${bad}`);
    log('System', 'Safety guard self-test passed (it refuses git changes and secret files, and lets normal commands through).');
    env = sessionEnv(process.env, ctx.env, homeDir());
    if (manifest.final_review !== false) { // the read-only home of the final review is checked now too, so a bad one cannot surprise the end of a long run
      const rev = buildSessionHome({ dir: homeDir(true), permissions: perms, manifestDeny: manifest.permissions?.deny || [], libDir: LIB, readOnly: true });
      const badRev = selfTestGuard(rev.cfgDir, { readOnly: true });
      if (badRev) refuse(`The read-only guard of the final review failed its self-test: ${badRev}`);
    }
  }
  const probe = probeAgy(env, primary);
  if (!probe.ok) refuse(`agy could not start${noIsolation ? '' : ' in its isolated HOME'}: ${probe.error}${noIsolation ? '' : '\nIf agy cannot sign in from the isolated HOME on this computer, run with --no-isolation (then the session itself is not restricted).'}`);
  const need = new Set([...(manifest.final_review === false ? [] : [reviewModel()]), ...manifest.plans.map(modelFor)]);
  for (const m of need) if (!probe.slugs.includes(m)) refuse(`The model "${m}" is not available in agy. Run "agy models" and fix config/models.json or the manifest (model / agy_model). Available: ${probe.slugs.join(', ')}`);
  log('System', `agy OK. Models in use: ${[...need].join(', ')}.${noIsolation ? '' : ' Each session runs in its own throwaway HOME.'}`);
}

/** One agy session. review=true gives it read access only. */
async function agySession(o) {
  const { perms, manifest } = ctx;
  const vars = { ...ctx.env, PLAN_RUNNER: '1', PLAN_RUNNER_SESSION: o.sessionFile };
  let env;
  let deniedLog = null;
  if (noIsolation) env = { ...scrubEnv(process.env), ...vars };
  else {
    const built = buildSessionHome({ dir: homeDir(o.review), permissions: perms, manifestDeny: manifest.permissions?.deny || [], libDir: LIB, readOnly: !!o.review });
    deniedLog = built.deniedLog;
    fs.rmSync(deniedLog, { force: true });
    env = sessionEnv(process.env, vars, homeDir(o.review));
  }
  const args = ['--model', o.model];
  for (const d of o.extraDirs) args.push('--add-dir', d);
  const facts = await runAgy({ args, prompt: o.prompt, cwd: o.cwd, env, idleMs: o.idleMs, timeoutMs: o.timeoutMs, maxToolSteps: o.maxToolSteps, rawLog: o.rawLog, stopAfterCheckpoint: o.stopAfterCheckpoint });
  facts.refused = [];
  if (deniedLog && fs.existsSync(deniedLog)) {
    facts.refused = fs.readFileSync(deniedLog, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  }
  if (facts.refused.length) log('System', `The guard refused ${facts.refused.length} call(s) in this session.`);
  return facts;
}

// ---------- executing one plan ----------
async function executePlan(plan, ps) {
  const { st, repos, manifest, defaults, snapAll, equalTrees } = ctx;
  const maxAttempts = plan.max_attempts ?? defaults.max_attempts;
  const maxToolSteps = (plan.max_turns ?? defaults.max_turns) * TOOL_CALLS_PER_TURN;
  const hardSessions = maxAttempts * 4;
  const cpPath = checkpointsPath(runDir, plan.id);
  const planRunDir = path.join(runDir, 'plans', plan.id);
  fs.mkdirSync(planRunDir, { recursive: true });

  if (ps.status !== 'running') {
    ps.status = 'running'; ps.startedAt = new Date().toISOString();
    ps.startTrees = snapAll();
    fs.rmSync(cpPath, { force: true });
  }
  saveState(runDir, st);
  log('System', `=== Plan ${plan.id}: ${plan.file} (${plan.steps.length} steps, est ${plan.est_turns} turns, ${modelFor(plan)}) ===`);

  while (true) {
    const cps = loadCheckpoints(runDir, plan.id);
    const lastStep = Math.max(0, ...Object.keys(cps).map(Number));
    const baseTrees = lastStep ? cps[lastStep].trees : ps.startTrees;

    // Make the files match the last good point exactly. A crash or failed attempt may have left debris.
    const cur = snapAll();
    if (!equalTrees(cur, baseTrees)) rollbackTo(baseTrees, cur, planRunDir, `partial-${ps.sessions}`, ps);

    if (ps.attempts >= maxAttempts || ps.sessions >= hardSessions) {
      finalFail(plan, ps, planRunDir, ps.lastFailure || 'too many attempts');
    }

    ps.sessions++;
    saveState(runDir, st);
    const sessionFile = path.join(runDir, 'session.json');
    const planRepos = plan.repos;
    writeJsonAtomic(sessionFile, {
      runDir, planId: plan.id, repos, defaultRepo: planRepos[0], env: ctx.env, allowed: plan.allowed_paths,
      extra: plan.allow_extra || [], planDirRel, primaryName, startTrees: ps.startTrees, steps: plan.steps,
      checkpointsPath: cpPath, resumeFrom: lastStep + 1,
    });

    const prompt = buildPrompt(plan, ps, lastStep);
    const extraDirs = [...new Set([...Object.values(repos), planDir])].filter((d) => d !== repos[planRepos[0]]);

    log('System', `Starting agy for ${plan.file}... (session ${ps.sessions}, attempt ${ps.attempts + 1}/${maxAttempts}${lastStep ? `, resuming after step ${lastStep}` : ''})`);
    const headsBefore = gitHeads(repos);
    const t0 = Date.now();
    const facts = await agySession({
      prompt, model: modelFor(plan), cwd: repos[planRepos[0]], extraDirs, sessionFile,
      idleMs: (plan.idle_min ?? defaults.idle_min) * 60000, timeoutMs: (plan.timeout_min ?? defaults.timeout_min) * 60000,
      maxToolSteps, rawLog: path.join(planRunDir, `session-${ps.sessions}.jsonl`),
      stopAfterCheckpoint: (toolSteps) => {
        const c = loadCheckpoints(runDir, plan.id);
        const last = Math.max(0, ...Object.keys(c).map(Number));
        return toolSteps > plan.est_turns * TOOL_CALLS_PER_TURN * 1.5 && last < plan.steps.length;
      },
    });
    ps.turns += facts.toolSteps;
    ps.refused = (ps.refused || 0) + facts.refused.length;
    (ps.refusedLog ||= []).push(...facts.refused.slice(0, 20).map((r) => `${r.tool}: ${r.what}`));
    ps.refusedLog = ps.refusedLog.slice(-40);
    const r = facts.result;
    log('System', `Session ended after ${fmtDuration(Date.now() - t0)}: exit ${facts.exitCode}, ${r ? `${r.status}${r.error ? ' (error)' : ''}` : 'no result event'}, ${facts.toolSteps} tool call(s)${facts.killedFor ? `, stopped: ${facts.killedFor}` : ''}.`);

    // (0) a session must never commit, switch branch or reset, even through a program it runs
    const moved = headChanges(headsBefore, gitHeads(repos));
    if (moved.length) {
      rollbackTo(ps.startTrees, snapAll(), planRunDir, 'git-moved', ps);
      ps.status = 'failed'; ps.lastFailure = `git state changed: ${moved.join('; ')}`; saveState(runDir, st);
      halt(`Plan ${plan.id} changed git state (${moved.join('; ')}). The runner never commits and the session must not either. The files were rolled back, but undo the git change by hand, then run the same command again.`);
    }

    const after = Math.max(0, ...Object.keys(loadCheckpoints(runDir, plan.id)).map(Number));
    const progressed = after > lastStep;

    // (a) usage limit: wait, do not count an attempt
    if (quotaError(facts)) {
      if (++ps.limitWaits > 20) finalFail(plan, ps, planRunDir, 'hit the usage limit too many times');
      await waitForLimit(facts);
      continue;
    }
    // (b) the session ran past its turn budget and was stopped at a green checkpoint: carry on fresh
    if (facts.sawCheckpointStop) {
      if (++ps.continuations > 6) finalFail(plan, ps, planRunDir, 'needed too many continuation sessions');
      log('System', `Turn budget exceeded; continuing in a fresh session from step ${after}.`);
      continue;
    }
    // (c) the session said it is blocked
    const blockedFile = path.join(planDir, 'BLOCKED.md');
    if (fs.existsSync(blockedFile)) {
      const reason = fs.readFileSync(blockedFile, 'utf8');
      fs.writeFileSync(path.join(planRunDir, `BLOCKED-${ps.sessions}.md`), reason);
      fs.rmSync(blockedFile, { force: true });
      rollbackTo(ps.startTrees, snapAll(), planRunDir, 'blocked', ps);
      ps.status = 'blocked'; ps.lastFailure = reason; saveState(runDir, st);
      halt(`Plan ${plan.id} is BLOCKED. The session wrote:\n${tail(reason, 1500)}`);
    }
    // (d) did it really finish? Decide here, never from the session's own words.
    // agy exits 0 and says SUCCESS even when a tool call was refused, so only the gates below mean anything.
    let failure = null;
    const finished = r && r.status === 'SUCCESS' && !r.error && (facts.exitCode === 0 || facts.lingered) && !facts.killedFor;
    if (!finished) failure = describeFailure(facts);
    else {
      const g = await acceptance(plan, ps);
      if (!g.ok) failure = g.failure;
    }

    if (!failure) {
      ps.status = 'done'; ps.finishedAt = new Date().toISOString(); ps.lastFailure = null;
      writeHandoff(plan, ps, facts);
      st.lastGoodTrees = snapAll();
      st.doneSinceSweep++;
      saveState(runDir, st);
      log('System', `Plan ${plan.id} DONE.`);
      if (st.doneSinceSweep >= ctx.every) await sweep(`after plan ${plan.id}`);
      return;
    }

    ps.lastFailure = failure;
    if (progressed) log('System', `Attempt failed, but steps advanced to ${after}, so it does not count against the limit.`);
    else ps.attempts++;
    saveState(runDir, st);
    log('System', `Plan ${plan.id} attempt failed: ${failure.split('\n')[0]}`);
    // loop: the top of the loop rolls back to the last checkpoint and retries
  }
}

async function acceptance(plan, ps) {
  const { repos, manifest, snapAll } = ctx;
  const cur = snapAll();
  const changed = changedPaths(repos, ps.startTrees, cur);
  log('Gate', `${changed.length} file(s) changed by plan ${plan.id}.`);

  const sc = scopeCheck({ changed, allowed: plan.allowed_paths, extra: plan.allow_extra || [], planDirRel, primaryName });
  if (!sc.ok) return { ok: false, failure: `SCOPE GATE: the session changed files it must not touch:\n${sc.violations.join('\n')}` };

  const sec = secretChanges(ctx.secretsBefore, secretFingerprint(repos));
  if (sec.length) {
    rollbackTo(ps.startTrees, cur, path.join(runDir, 'plans', plan.id), 'secrets', ps);
    ps.status = 'failed'; ps.lastFailure = `secret files changed: ${sec.join(', ')}`; saveState(runDir, ctx.st);
    halt(`Plan ${plan.id} changed secret files: ${sec.join(', ')}. Git ignores them, so the runner cannot restore them. Put them back by hand, then run the same command again.`);
  }

  if (manifest.php_lint !== false) {
    const pl = phpLintChanged(repos, changed, gateEnv());
    if (!pl.ok) return { ok: false, failure: pl.failure };
  }
  let r = await runList(manifest.gates_each || [], { repos, defaultRepo: plan.repos[0], env: gateEnv(), changed, label: 'check' });
  if (!r.ok) return r;

  const cps = loadCheckpoints(runDir, plan.id);
  for (const s of plan.steps) {
    if (cps[s.n]) continue; // already verified at its checkpoint
    r = await runList(s.verify || [], { repos, defaultRepo: plan.repos[0], env: gateEnv(), changed, label: `step ${s.n} verify` });
    if (!r.ok) return r;
  }
  r = await runList(plan.verify, { repos, defaultRepo: plan.repos[0], env: gateEnv(), changed, label: `plan ${plan.id} verify` });
  if (!r.ok) return r;

  ps.deps = depChanges(ps.startTrees, cur);
  ps.changed = changed;
  return { ok: true };
}

async function sweep(when) {
  const { st, manifest, repos } = ctx;
  const list = manifest.full_gates || [];
  if (!list.length) { st.doneSinceSweep = 0; st.sweepPending = false; saveState(runDir, st); return; }
  log('System', `Full check ${when}.`);
  st.sweepPending = true; saveState(runDir, st);
  const r = await runList(list, { repos, defaultRepo: primaryName, env: gateEnv(), changed: [], label: 'full check' });
  if (!r.ok) halt(`The full check failed ${when}. Nothing after this ran.\n${r.failure}`);
  st.doneSinceSweep = 0; st.sweepPending = false; saveState(runDir, st);
}

async function finalReview() {
  const { st, repos, manifest, snapAll } = ctx;
  if (manifest.final_review === false) return;
  const cur = snapAll();
  let any = false;
  let patchNote = '';
  for (const [n, d] of Object.entries(repos)) {
    const p = patchBetween(d, st.baseTrees[n], cur[n]);
    if (!p) continue;
    any = true;
    const f = path.join(runDir, `final-${n}.patch`);
    fs.writeFileSync(f, p);
    patchNote += `\n- ${n}: ${toPosix(f)}`;
  }
  if (!any) return;
  log('System', 'Final security review (read-only).');
  const prompt = `You are a read-only reviewer. An unattended run just changed code in these repositories; the full diffs are in these patch files:${patchNote}\n\nReview ONLY those changes for security and privacy problems: who can call this code, whether identity comes from the server session, input validation, SQL injection, exposed personal data or secrets, and new dependencies in package.json. You can only read files: do not try to run commands or edit anything. Reply with a short list: severity, file, the problem, the fix. If nothing is wrong say "no findings".`;
  log('System', 'Starting agy for the final review...');
  let facts;
  try {
    facts = await agySession({
      review: true, prompt, model: reviewModel(), cwd: Object.values(repos)[0], extraDirs: [runDir, ...Object.values(repos).slice(1)],
      sessionFile: path.join(runDir, 'session.json'), idleMs: 10 * 60000, timeoutMs: 30 * 60000, maxToolSteps: 100, rawLog: path.join(runDir, 'final-review.jsonl'),
    });
  } catch (e) { // a review that cannot run safely is skipped, and the report says so
    st.finalReview = `(the final review did not run: ${e.message})`;
    saveState(runDir, st);
    return;
  }
  const text = facts.result?.status === 'SUCCESS' ? facts.result.response : null;
  st.finalReview = text ? String(text) : `(the final review did not finish: ${facts.killedFor || describeFailure(facts)})`;
  saveState(runDir, st);
}

// ---------- helpers ----------
function rollbackTo(baseTrees, cur, planRunDir, tag, ps) {
  const { repos } = ctx;
  for (const [n, d] of Object.entries(repos)) {
    if (cur[n] === baseTrees[n]) continue;
    const patch = patchBetween(d, baseTrees[n], cur[n]);
    if (patch) {
      const f = path.join(planRunDir, `${tag}-${n}.patch`);
      fs.writeFileSync(f, patch);
      ps.patches.push(f);
      log('System', `Saved the discarded work of ${n} as ${f}`);
    }
    const r = restore(d, baseTrees[n], ctx.idxFile(n));
    log('System', `Rolled back ${n}: ${r.removed} file(s) removed, ${r.restored} restored.`);
  }
}

function finalFail(plan, ps, planRunDir, why) {
  rollbackTo(ps.startTrees, ctx.snapAll(), planRunDir, 'final', ps);
  ps.status = 'failed'; saveState(runDir, ctx.st);
  halt(`Plan ${plan.id} FAILED and was rolled back: ${why}\nFailed work is saved as .patch files in ${planRunDir}`);
}

function halt(reason) {
  const { st } = ctx;
  st.status = 'halted'; st.haltReason = reason; saveState(runDir, st);
  log('System', `HALTED: ${reason}`);
  writeReport('HALTED');
  toast('Plan run stopped', `${slug}: ${reason.split('\n')[0].slice(0, 180)}`);
  const e = new Halt(reason); e.code = 1; throw e;
}

function refuse(msg) {
  console.log(`${new Date().toLocaleTimeString()} [System] REFUSED TO START: ${msg}`);
  const e = new Halt(msg); e.code = 2; throw e;
}

async function waitForLimit(f) {
  const { st } = ctx;
  const fast = !!process.env.PLAN_RUNNER_FAST; // tests only
  // agy does not report a reset time the runner can read, so wait the server's retry delay when there is one, else 15 minutes.
  let ms = fast ? 1000 : (retryAfterMs(f) ?? 15 * 60000);
  if (!fast) ms = Math.max(60000, ms);
  if (st.waitedMs + ms > MAX_LIMIT_WAIT_MS) halt('Waited too long for the usage limit to reset.');
  const until = new Date(Date.now() + ms).toLocaleTimeString();
  log('System', `Usage limit reached. Waiting until ${until} (${fmtDuration(ms)}), then retrying the same plan.`);
  toast('Plan run paused', `Usage limit. Resumes about ${until}.`);
  const end = Date.now() + ms;
  let n = 0;
  while (Date.now() < end) { await sleep(Math.min(30000, end - Date.now())); if (++n % 20 === 0) log('System', `Still waiting for the usage limit (${fmtDuration(end - Date.now())} left).`); }
  st.waitedMs += ms; saveState(runDir, st);
}

function describeFailure(f) {
  if (f.spawnError) return `could not start agy: ${f.spawnError}`;
  if (f.killedFor) return `the session was stopped: ${f.killedFor}`;
  const r = f.result;
  if (!r) return `no result from agy (exit ${f.exitCode}). ${tail(f.stderrTail || '', 600)}`;
  if (r.status !== 'SUCCESS') return `agy ended with ${r.status}${r.error ? `: ${tail(String(r.error), 600)}` : ''}`;
  if (r.error) return `agy reported an error: ${tail(String(r.error), 600)}`;
  return `agy exited with code ${f.exitCode}`;
}

function buildPrompt(plan, ps, lastStep) {
  const { repos } = ctx;
  const cp = toPosix(path.join(HERE, 'checkpoint.mjs'));
  const folders = Object.entries(repos).map(([n, d]) => `- ${n}: ${toPosix(d)}`).join('\n');
  const resume = lastStep
    ? `\nSteps 1-${lastStep} are ALREADY DONE and verified. Their changes are in the files now. Do not redo them. Start at step ${lastStep + 1}, after reading the current state of the files.\n`
    : '';
  const fail = ps.lastFailure
    ? `\nAn earlier attempt of this plan failed. Reason (do not repeat it):\n${tail(ps.lastFailure, 2500)}\n`
    : '';
  const shell = process.platform === 'win32'
    ? 'Your shell is Windows PowerShell: join commands with ";" (not "&&"), and create or edit files with the file tools, not with ">" redirects (PowerShell writes those as UTF-16).'
    : 'Create and edit files with the file tools.';
  return `You are running plan ${plan.id} of feature "${slug}" in an UNATTENDED automated run. Nobody can answer questions.

Plan file: ${toPosix(path.join(planDir, plan.file))}
Workspace folders:
${folders}

Read, in this order: ${toPosix(path.join(planDir, 'INSTRUCTIONS.md'))}, ${toPosix(path.join(planDir, 'HANDOFF.md'))}, then the plan file. Do exactly that plan and nothing else.

CHECKPOINTS: after you finish each numbered step, run this exact command:
  node "${cp}" <step number>
It runs that step's own checks and records a restore point. Go to the next step only when it prints "CHECKPOINT <n> OK". If it refuses, fix the problem and run it again. Never skip a step and never edit checkpoint or state files.
${resume}${fail}
Shell: use any build, test or language tool the project needs. ${shell} A tool call can be refused by a rule (git changes, network, deploy, publish, secret files, recursive deletes). A refusal does NOT mean the shell is off, and the refusal message may tell you not to retry: do not retry that command, skip it (the runner does git work itself) and carry on with the rest of the plan. Write BLOCKED.md for a refusal only when the plan truly cannot be done without that command.

If a command from the plan contains {{runner}}, that stands for ${RUNNER_DIR}: put that path in when you run it yourself.

Reminders (the full rules are in INSTRUCTIONS.md): never ask the user a question; never commit, push or change git state; if you truly cannot continue, write BLOCKED.md in ${toPosix(planDir)} with the reason and what you tried, then stop. When every step is checkpointed, run the Acceptance commands, then reply with the "Report back" section.`;
}

function writeHandoff(plan, ps, facts) {
  const f = path.join(planDir, 'HANDOFF.md');
  const old = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '# Handoff\n';
  const files = (ps.changed || []).slice(0, 60).map((p) => `  - ${p}`).join('\n');
  const dep = (ps.deps || []).length ? `\nNew or changed dependencies: ${ps.deps.join(', ')}\n` : '';
  const summary = tail(String(facts.result?.response || '(no summary)'), 1800);
  fs.writeFileSync(f, `${old.trimEnd()}\n\n## Plan ${plan.id} (${plan.file}) - done ${new Date().toLocaleString()}\nFiles changed:\n${files || '  (none)'}\n${dep}\nSession report:\n${summary}\n`);
}

function depChanges(startTrees, cur) {
  const out = [];
  for (const [n, d] of Object.entries(ctx.repos)) {
    const a = parseDeps(fileAt(d, startTrees[n], 'package.json'));
    const b = parseDeps(fileAt(d, cur[n], 'package.json'));
    if (!b) continue;
    for (const [k, v] of Object.entries(b)) if (!a || !(k in a)) out.push(`${n}: +${k}@${v}`); else if (a[k] !== v) out.push(`${n}: ~${k} ${a[k]} -> ${v}`);
    if (a) for (const k of Object.keys(a)) if (!(k in b)) out.push(`${n}: -${k}`);
  }
  for (const [n, d] of Object.entries(ctx.repos)) {
    for (const f of DEP_FILES.filter((x) => x !== 'package.json' && x !== 'package-lock.json')) {
      if (fileAt(d, startTrees[n], f) !== fileAt(d, cur[n], f)) out.push(`${n}: ${f} changed`);
    }
  }
  return out;
}
function parseDeps(text) {
  if (!text) return null;
  try { const j = JSON.parse(text); return { ...(j.dependencies || {}), ...(j.devDependencies || {}) }; } catch { return null; }
}

function readEnvFile(p) {
  const out = {};
  try {
    for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
      const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
      if (!m) continue;
      let v = m[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      else v = v.replace(/\s+#.*$/, '');
      out[m[1]] = v;
    }
  } catch { /* no .env */ }
  return out;
}

// The commands the runner itself runs (gates, setup) use the normal environment plus the manifest's env.
function gateEnv() { return { ...process.env, ...ctx.env, PLAN_RUNNER: '1' }; }

// ---------- report and status ----------
function writeReport(outcome) {
  try {
    const { st, manifest, repos } = ctx;
    const L = [];
    L.push(`# Plan run report: ${slug}`, '', `Result: **${outcome}**`, `Started: ${st.created}`, st.finished ? `Finished: ${st.finished}` : '', `Session isolation: ${st.isolation || 'unknown'}${st.isolation === 'none' ? ' (the session itself was NOT restricted)' : ''}`, st.haltReason ? `\nStopped because:\n\n\`\`\`\n${st.haltReason}\n\`\`\`` : '', '');
    L.push('## Plans', '', '| id | file | status | attempts | sessions | tool calls | refused |', '|---|---|---|---|---|---|---|');
    for (const p of manifest.plans) {
      const s = st.plans[p.id] || {};
      L.push(`| ${p.id} | ${p.file} | ${s.status || 'pending'} | ${s.attempts ?? 0} | ${s.sessions ?? 0} | ${s.turns ?? 0} | ${s.refused ?? 0} |`);
    }
    const cur = ctx.snapAll();
    L.push('', '## Files changed (uncommitted, review before you commit)', '');
    for (const [n, d] of Object.entries(repos)) {
      const ch = changedBetween(d, st.baseTrees[n], cur[n]).filter((c) => !(n === primaryName && c.path.startsWith(`${planDirRel}/`)));
      L.push(`**${n}** (branch ${branch(d)}): ${ch.length} file(s)`);
      for (const c of ch.slice(0, 80)) L.push(`- ${c.status} ${c.path}`);
      if (ch.length > 80) L.push(`- ... and ${ch.length - 80} more`);
      L.push('');
    }
    const refused = Object.entries(st.plans).flatMap(([id, p]) => (p.refusedLog || []).map((x) => `- plan ${id}: ${x}`));
    L.push('## Refused by the guard', '', refused.length ? refused.slice(-40).join('\n') : 'Nothing was refused.', '');
    const deps = Object.values(st.plans).flatMap((p) => p.deps || []);
    L.push('## NEW DEPENDENCIES', '', deps.length ? deps.map((d) => `- ${d}`).join('\n') : 'None.', '');
    const hc = manifest.plans.filter((p) => p.human_check && st.plans[p.id]?.status === 'done');
    L.push('## Please check by hand (a machine could not)', '', hc.length ? hc.map((p) => `- Plan ${p.id}: ${p.human_check}`).join('\n') : 'Nothing listed.', '');
    L.push('## Final security review', '', st.finalReview || '(not run)', '');
    L.push('## How to continue', '', outcome === 'HALTED' ? `Fix the cause, then run \`node ${toPosix(path.join(HERE, 'run.mjs'))} run ${slug}\` again. It resumes from the plan that stopped. Discarded work is in \`${toPosix(path.join(runDir, 'plans'))}\` as .patch files.` : 'Review the diff in each repo, then commit it yourself.', '');
    const text = L.filter((x) => x !== undefined).join('\n');
    fs.writeFileSync(path.join(runDir, 'REPORT.md'), text);
    try { fs.writeFileSync(path.join(planDir, 'REPORT.md'), text); } catch { /* ignore */ }
  } catch (e) { log('System', `Could not write the report: ${e.message}`); }
}

function printStatus() {
  const st = loadState(runDir);
  if (!st) { console.log(`No run state for "${slug}" in ${runDir}`); return; }
  console.log(`Run "${slug}": ${st.status}${st.haltReason ? `\n  reason: ${st.haltReason.split('\n')[0]}` : ''}`);
  for (const [id, p] of Object.entries(st.plans)) console.log(`  ${id}: ${p.status}  attempts=${p.attempts} sessions=${p.sessions} tool calls=${p.turns} refused=${p.refused ?? 0}${p.lastFailure ? `\n      last failure: ${p.lastFailure.split('\n')[0]}` : ''}`);
  console.log(`State folder: ${runDir}`);
}
