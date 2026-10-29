#!/usr/bin/env node
// Unattended plan runner for Claude Code.
//   node run.mjs run <slug> [--repo <path>] [--dry-run] [--reset]
//   node run.mjs status <slug> [--repo <path>]
// Run it from inside the main repo (or pass --repo). Plans live in <repo>/docs/plans/<slug>/.
// Rules: one fresh `claude -p` session per plan, never trust "done", no step is ever skipped (every step must be
// checkpointed, every check re-runs at the end, the session must report what it did not do), stop at the first
// failure, nothing is ever committed, everything is resumable.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateFolder } from './validate.mjs';
import { toplevel, isGitRepo, dirtyPaths, snapshot, restore, changedBetween, patchBetween, fileAt, branch } from './lib/git.mjs';
import { runClaude, findGitBash, killTree, activePids } from './lib/claude.mjs';
import {
  changedPaths, scopeCheck, runList, phpLintChanged, DEP_FILES, secretFingerprint, secretChanges, gitHeads, headChanges,
  otherRepos, repoFingerprints, fingerprintChanges, RUNNER_DIR,
} from './lib/gates.mjs';
import { REPORT_SCHEMA, reportInstructions, extractReport, checkReport, formatReport } from './lib/report.mjs';
import { runDirFor, loadState, saveState, loadCheckpoints, checkpointsPath, acquireLock } from './lib/state.mjs';
import { toast, keepAwake } from './lib/system.mjs';
import { log, setLogFile, sleep, readJson, writeJsonAtomic, toPosix, tail, fmtDuration } from './lib/util.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MAX_LIMIT_WAIT_MS = 12 * 3600 * 1000; // total time one run may wait for usage limits
const HALTED = ['failed', 'blocked', 'notdone']; // plan states a new start resumes from the kept checkpoints

class Halt extends Error {}

// ---------- args ----------
const argv = process.argv.slice(2);
const cmd = argv[0];
const flag = (n) => argv.includes(n);
const opt = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const slug = argv[1] && !argv[1].startsWith('--') ? argv[1] : undefined;
if (!['run', 'status'].includes(cmd) || !slug) {
  console.log('Usage:\n  node run.mjs run <slug> [--repo <path>] [--dry-run] [--reset]\n  node run.mjs status <slug> [--repo <path>]');
  process.exit(2);
}

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
  console.log('\nInterrupted. Stopping the claude session; the plan is rolled back to its last checkpoint on the next start.');
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
  const defaults = { max_attempts: 3, max_turns: 60, timeout_min: 45, idle_min: 10, model: 'sonnet', ...(manifest.defaults || {}) };
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

  const gitBash = findGitBash();
  if (process.platform === 'win32' && !gitBash && !process.env.PLAN_RUNNER_CLAUDE_CMD) refuse('Git Bash was not found. Install Git for Windows, or set CLAUDE_CODE_GIT_BASH_PATH.');

  // 5. state
  if (flag('--reset') && fs.existsSync(path.join(runDir, 'state.json'))) {
    fs.rmSync(path.join(runDir, 'state.json'));
    fs.rmSync(path.join(runDir, 'plans'), { recursive: true, force: true });
    log('System', 'Previous run state discarded (--reset).');
  }
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
      stoppedTrees: null, doneSinceSweep: 0, sweepPending: false, waitedMs: 0, plans: {}, repos };
    saveState(runDir, st);
    log('System', 'Fresh run. Both repos were clean.');
  } else {
    if (st.status === 'complete') { log('System', 'This run is already complete. Use --reset to run it again.'); return; }
    st.status = 'running'; st.haltReason = null;
    // a plan the last process died in is rolled back to its last checkpoint by executePlan
    const running = Object.entries(st.plans).find(([, p]) => p.status === 'running');
    if (running) log('System', `Plan ${running[0]} was interrupted. It will be rolled back to its last good point.`);
    else {
      // After a halt the files must be exactly as the runner left them. A resume rolls the stopped plan back to its
      // last checkpoint, so a hand edit made in between would be thrown away: refuse instead.
      const expect = st.stoppedTrees || st.lastGoodTrees;
      const cur = snapAll();
      for (const [n, d] of Object.entries(repos)) {
        const diff = changedBetween(d, expect[n], cur[n]).map((c) => c.path)
          .filter((p) => !(n === primaryName && p.startsWith(`${planDirRel}/`)));
        if (diff.length) refuse(`Files changed in ${n} since the runner stopped: ${diff.slice(0, 8).join(', ')}${diff.length > 8 ? ', ...' : ''}.\nThe runner will not resume over them: a resume rolls the stopped plan back to its last checkpoint and would throw these edits away. Undo them and put the fix into the plan file instead (plan-folder edits are fine), or commit them and start over with --reset.`);
      }
      if (!st.stoppedTrees) st.lastGoodTrees = cur; // only plan-folder edits differ; accept them
    }
    st.stoppedTrees = null;
    // a finished plan must still be the plan that was run
    for (const plan of manifest.plans) {
      const p = st.plans[plan.id];
      if (p?.status === 'done' && p.hash && p.hash !== planHash(plan)) refuse(`Plan ${plan.id} (${plan.file}) was changed after it finished, so the finished work no longer matches it. Put the plan back as it was, or start over with --reset.`);
    }
    for (const [id, p] of Object.entries(st.plans)) {
      if (!HALTED.includes(p.status)) continue;
      const plan = manifest.plans.find((x) => x.id === id);
      Object.assign(p, { status: 'running', tries: 0, tryStep: null, sessions: 0, continuations: 0, limitWaits: 0, recheck: true });
      if (plan && p.stepsHash && p.stepsHash !== stepsHash(plan)) p.restart = true;
    }
    saveState(runDir, st);
  }

  const others = otherRepos(path.dirname(primary), Object.values(repos));
  if (others.length) log('System', `Watching ${others.length} other repo(s) next to the project for changes: ${others.map((d) => path.basename(d)).join(', ')}.`);
  ctx = { st, repos, manifest, defaults, env, gitBash, snapAll, equalTrees, idxFile, every, secretsBefore: secretFingerprint(repos), others, othersBefore: repoFingerprints(others) };

  if (flag('--dry-run')) {
    log('System', 'Dry run. Order of plans:');
    for (const p of manifest.plans) log('System', `  ${p.id} ${p.file} [${p.repos.join(',')}] model=${p.model || defaults.model} est_turns=${p.est_turns} steps=${p.steps.length}`);
    return;
  }

  // 6. one-time setup (create the throwaway database, apply migrations, ...)
  if (!st.setupDone && (manifest.setup || []).length) {
    log('System', 'Running one-time setup commands.');
    const r = await runList(manifest.setup, { repos, defaultRepo: primaryName, env: gateEnv(), label: 'setup' });
    if (!r.ok) halt(`Setup failed.\n${r.failure}`);
    st.setupDone = true; saveState(runDir, st);
  }

  // 7. the plans, strictly in order
  if (st.sweepPending) await sweep(`before resuming`);
  for (const plan of manifest.plans) {
    const ps = (st.plans[plan.id] ||= { status: 'pending', attempts: 0, tries: 0, sessions: 0, continuations: 0, limitWaits: 0, turns: 0, patches: [], failures: [] });
    if (ps.status === 'done') continue;
    for (const d of plan.depends_on) if (st.plans[d]?.status !== 'done') halt(`Plan ${plan.id} depends on ${d}, which is not done.`);
    await executePlan(plan, ps);
  }

  // 8. finish
  await sweep('after the last plan');
  await finalReview();
  st.status = 'complete'; st.finished = new Date().toISOString(); saveState(runDir, st);
  writeReport('COMPLETE');
  const outside = Object.values(st.plans).reduce((a, p) => a + (p.outside || []).length, 0);
  const devs = Object.values(st.plans).reduce((a, p) => a + (p.deviations || []).length, 0);
  toast('Plan run complete', `${slug}: all ${manifest.plans.length} plans done.${devs ? ` ${devs} thing(s) done differently from the plan.` : ''}${outside ? ` ${outside} file(s) changed outside the plans.` : ''} Read the report, then commit.`);
  log('System', `All plans done. Report: ${path.join(runDir, 'REPORT.md')}`);
}

// ---------- executing one plan ----------
async function executePlan(plan, ps) {
  const { st, repos, manifest, defaults, snapAll, equalTrees } = ctx;
  const maxTries = plan.max_attempts ?? defaults.max_attempts;
  const maxTurns = plan.max_turns ?? defaults.max_turns;
  const hardSessions = (plan.steps.length + 1) * (maxTries + 2) + 6;
  const planRunDir = path.join(runDir, 'plans', plan.id);
  fs.mkdirSync(planRunDir, { recursive: true });
  ps.failures ||= []; ps.patches ||= [];
  log('System', `=== Plan ${plan.id}: ${plan.file} (${plan.steps.length} steps, est ${plan.est_turns} turns, ${plan.model || defaults.model}) ===`);

  if (ps.status === 'pending') {
    Object.assign(ps, { status: 'running', startedAt: new Date().toISOString(), startTrees: snapAll(), hash: planHash(plan), stepsHash: stepsHash(plan) });
    fs.rmSync(checkpointsPath(runDir, plan.id), { force: true });
    saveState(runDir, st);
    if (manifest.precheck !== false && plan.precheck !== false) await precheck(plan, ps, planRunDir);
  } else {
    if (ps.restart) restartPlan(plan, ps, planRunDir);
    if (ps.recheck) await recheckKept(plan, ps, planRunDir);
  }
  saveState(runDir, st);

  while (true) {
    const cps = loadCheckpoints(runDir, plan.id);
    const lastStep = lastOf(cps);
    const baseTrees = lastStep ? cps[lastStep].trees : ps.startTrees;

    // Make the files match the last good point exactly. A crash or failed try may have left debris.
    const cur = snapAll();
    if (!equalTrees(cur, baseTrees)) rollbackTo(baseTrees, cur, planRunDir, `partial-${ps.sessionNo || 0}`, ps);

    const curStep = lastStep < plan.steps.length ? lastStep + 1 : 'final';
    if (ps.tryStep !== curStep) { ps.tryStep = curStep; ps.tries = 0; }
    if (ps.tries >= maxTries) finalFail(plan, ps, `${stepName(curStep)} failed ${ps.tries} times`);
    if (ps.sessions >= hardSessions) finalFail(plan, ps, `it needed too many sessions (${ps.sessions})`);

    ps.sessions++;
    ps.sessionNo = (ps.sessionNo || 0) + 1;
    saveState(runDir, st);
    const sessionFile = path.join(runDir, 'session.json');
    const planRepos = plan.repos;
    writeJsonAtomic(sessionFile, {
      runDir, planId: plan.id, repos, defaultRepo: planRepos[0], env: ctx.env, allowed: plan.allowed_paths,
      extra: plan.allow_extra || [], planDirRel, primaryName, startTrees: ps.startTrees, steps: plan.steps,
      checkpointsPath: checkpointsPath(runDir, plan.id), resumeFrom: lastStep + 1,
    });

    const prompt = buildPrompt(plan, ps, lastStep);
    const perms = readJson(path.join(HERE, 'config', 'permissions.json'));
    const allow = [...perms.allow, ...(manifest.permissions?.allow || [])];
    const deny = [...perms.deny, ...(manifest.permissions?.deny || [])];
    const extraDirs = [...new Set([...Object.values(repos), planDir])].filter((d) => d !== repos[planRepos[0]]);
    // The file guard (writes only inside the project, never to blocked files) is a hook in a settings file of our own,
    // so it applies although the user's settings are switched off.
    const guard = { hooks: { PreToolUse: [{ matcher: 'Write|Edit|MultiEdit|NotebookEdit|Read', hooks: [{ type: 'command', command: `node "${toPosix(path.join(HERE, 'lib', 'file-guard.mjs'))}"` }] }] } };
    const args = ['-p', '--output-format', 'stream-json', '--verbose', '--no-session-persistence', '--strict-mcp-config',
      '--setting-sources', 'project,local', '--settings', JSON.stringify(guard), '--permission-mode', 'dontAsk', '--max-turns', String(maxTurns),
      '--model', plan.model || defaults.model, '--json-schema', JSON.stringify(REPORT_SCHEMA),
      '--add-dir', ...extraDirs, '--allowedTools', ...allow, '--disallowedTools', ...deny];

    log('System', `Starting claude for ${plan.file}... (session ${ps.sessionNo}, ${stepName(curStep)} try ${ps.tries + 1}/${maxTries}${lastStep ? `, resuming after step ${lastStep}` : ''})`);
    const headsBefore = gitHeads(repos);
    const t0 = Date.now();
    const facts = await runClaude({
      args, prompt, cwd: repos[planRepos[0]], env: sessionEnv(sessionFile),
      idleMs: (plan.idle_min ?? defaults.idle_min) * 60000, timeoutMs: (plan.timeout_min ?? defaults.timeout_min) * 60000,
      rawLog: path.join(planRunDir, `session-${ps.sessionNo}.jsonl`),
      stopAfterCheckpoint: (turns) => {
        const c = loadCheckpoints(runDir, plan.id);
        return turns > plan.est_turns * 1.5 && lastOf(c) < plan.steps.length;
      },
    });
    ps.turns += facts.result?.num_turns ?? facts.turns;
    ps.cost = (ps.cost || 0) + (facts.result?.total_cost_usd || 0);
    noteRefused(ps, facts.refused);
    log('System', `Session ended after ${fmtDuration(Date.now() - t0)}: exit ${facts.exitCode}, ${facts.result ? `${facts.result.subtype}${facts.result.is_error ? ' (error)' : ''}` : 'no result event'}${facts.killedFor ? `, stopped: ${facts.killedFor}` : ''}${facts.refused.length ? `, ${facts.refused.length} refused call(s)` : ''}.`);

    const after = lastOf(loadCheckpoints(runDir, plan.id));
    const progressed = after > lastStep;

    // (0) safety: a session must never commit or switch branch, and never touch another repo
    const moved = headChanges(headsBefore, gitHeads(repos));
    if (moved.length) safetyHalt(plan, ps, planRunDir, `changed git state (${moved.join('; ')}). The runner never commits and the session must not either. The files were rolled back to the last checkpoint, but undo the git change by hand`);
    const touched = fingerprintChanges(ctx.othersBefore, repoFingerprints(ctx.others));
    if (touched.length) safetyHalt(plan, ps, planRunDir, `changed files in another repo outside the project: ${touched.join(', ')}. The runner cannot roll that back. Check that repo and undo the change by hand`);
    // after every session, not only at the end: a session that changes .env and then fails must not slip through
    const sec = secretChanges(ctx.secretsBefore, secretFingerprint(repos));
    if (sec.length) safetyHalt(plan, ps, planRunDir, `changed secret files: ${sec.join(', ')}. Git ignores them, so the runner cannot restore them. Put them back by hand`);

    // (a) usage limit: wait, do not count a try
    if (isRateLimited(facts)) {
      if (++ps.limitWaits > 20) finalFail(plan, ps, 'it hit the usage limit too many times');
      await waitForLimit(facts);
      continue;
    }
    // (b) the session ran past its turn budget and was stopped at a green checkpoint: carry on fresh
    if (facts.sawCheckpointStop) {
      if (++ps.continuations > plan.steps.length + 6) finalFail(plan, ps, 'it needed too many continuation sessions');
      log('System', `Turn budget exceeded; continuing in a fresh session from step ${after + 1}.`);
      continue;
    }
    // (c) the session said it is blocked
    const blockedFile = path.join(planDir, 'BLOCKED.md');
    if (fs.existsSync(blockedFile)) {
      const reason = fs.readFileSync(blockedFile, 'utf8');
      fs.writeFileSync(path.join(planRunDir, `BLOCKED-${ps.sessionNo}.md`), reason);
      fs.rmSync(blockedFile, { force: true });
      const kept = rollbackToCheckpoint(plan, ps, planRunDir, `blocked-${ps.sessionNo}`);
      ps.status = 'blocked'; ps.lastFailure = reason;
      recordFailure(plan, ps, after < plan.steps.length ? after + 1 : 'final', `BLOCKED.md:\n${reason}`, []);
      saveState(runDir, st);
      halt(`Plan ${plan.id} is BLOCKED. The session wrote:\n${tail(reason, 1500)}\n\n${keptText(kept)} Fix the cause, then run the same command again.`);
    }
    // (d) did it really finish? Decide here, never from the session's own words.
    const rep = checkReport(extractReport(facts.result?.structured_output, facts.result?.result), { firstStep: Math.min(lastStep + 1, plan.steps.length + 1), stepCount: plan.steps.length });
    let failure = null;
    const finished = facts.result && facts.result.subtype === 'success' && !facts.result.is_error && facts.exitCode === 0 && !facts.killedFor;
    if (!finished) failure = describeFailure(facts);
    else if (rep.ok && blockingNotDone(rep, after, progressed, plan.steps.length).length) notDoneHalt(plan, ps, planRunDir, { ...rep, notDone: blockingNotDone(rep, after, progressed, plan.steps.length) });
    else if (after < plan.steps.length) {
      if (progressed) { // it stopped early but moved forward: a fresh session goes on from the next step, no try used
        if (++ps.continuations > plan.steps.length + 6) finalFail(plan, ps, 'it needed too many continuation sessions');
        if (rep.ok) keepReport(ps, rep);
        log('System', `The session ended with steps left (checkpointed up to step ${after} of ${plan.steps.length}). Continuing in a fresh session from step ${after + 1}; no try used.`);
        saveState(runDir, st);
        continue;
      }
      failure = `the session ended without finishing step ${after + 1}: it said it was done, but checkpoint ${after + 1} never passed`;
    } else if (!rep.ok) failure = rep.failure;
    else {
      const g = await acceptance(plan, ps);
      if (!g.ok) failure = g.failure;
    }

    if (!failure) {
      keepReport(ps, rep);
      ps.summary = rep.summary || String(facts.result?.result || '').trim();
      Object.assign(ps, { status: 'done', finishedAt: new Date().toISOString(), lastFailure: null, hash: planHash(plan) });
      writeHandoff(plan, ps, rep);
      st.lastGoodTrees = snapAll();
      st.doneSinceSweep++;
      saveState(runDir, st);
      log('System', `Plan ${plan.id} DONE.`);
      if (st.doneSinceSweep >= ctx.every) await sweep(`after plan ${plan.id}`);
      return;
    }

    // a failed try: it counts against the step the plan is on now, and the work goes back to the last checkpoint
    const failStep = after < plan.steps.length ? after + 1 : 'final';
    if (ps.tryStep !== failStep) { ps.tryStep = failStep; ps.tries = 0; }
    ps.tries++;
    ps.attempts = (ps.attempts || 0) + 1;
    ps.lastFailure = failure;
    const patches = rollbackTo(checkpointTrees(plan, ps), snapAll(), planRunDir, `failed-${ps.sessionNo}`, ps);
    recordFailure(plan, ps, failStep, failure, patches, maxTries);
    saveState(runDir, st);
    // loop: the next session retries the same step
  }
}

async function acceptance(plan, ps) {
  const { repos, manifest, snapAll } = ctx;
  const cur = snapAll();
  const changed = changedPaths(repos, ps.startTrees, cur);
  log('Gate', `${changed.length} file(s) changed by plan ${plan.id}.`);

  const sc = scopeCheck({ changed, allowed: plan.allowed_paths, extra: plan.allow_extra || [], planDirRel, primaryName });
  if (!sc.ok) return { ok: false, failure: `SCOPE GATE: the session changed blocked files (git, secrets, agent settings or the plan folder):\n${sc.violations.join('\n')}` };
  if (sc.outside.length) log('Gate', `${sc.outside.length} file(s) changed outside allowed_paths (allowed, listed in the report): ${sc.outside.slice(0, 5).join(', ')}${sc.outside.length > 5 ? ', ...' : ''}`);

  if (manifest.php_lint !== false) {
    const pl = phpLintChanged(repos, changed, gateEnv());
    if (!pl.ok) return { ok: false, failure: pl.failure };
  }
  let r = await runList(manifest.gates_each || [], { repos, defaultRepo: plan.repos[0], env: gateEnv(), changed, label: 'check' });
  if (!r.ok) return r;

  // every step's check again, not only the unchecked ones: a later step can break an earlier one
  for (const s of plan.steps) {
    r = await runList(s.verify || [], { repos, defaultRepo: plan.repos[0], env: gateEnv(), changed, label: `step ${s.n} re-check` });
    if (!r.ok) return r;
  }
  r = await runList(plan.verify, { repos, defaultRepo: plan.repos[0], env: gateEnv(), changed, label: `plan ${plan.id} verify` });
  if (!r.ok) return r;

  ps.deps = depChanges(ps.startTrees, cur);
  ps.changed = changed;
  ps.outside = sc.outside;
  return { ok: true };
}

/** Each step's check once before any work. A check that already passes cannot prove its step was done. */
async function precheck(plan, ps, planRunDir) {
  const { repos, snapAll, equalTrees } = ctx;
  log('Gate', `Pre-check: each step's check runs once before any work (failures here are expected; a check that already passes is weak).`);
  ps.weak = [];
  for (const s of plan.steps) {
    const r = await runList(s.verify || [], { repos, defaultRepo: plan.repos[0], env: gateEnv(), changed: [], label: `pre-check step ${s.n}` });
    if (r.ok) { ps.weak.push(s.n); log('Gate', `WARNING: step ${s.n}'s check already passes before any work. It may not prove the step was done (listed in the report).`); }
  }
  const cur = snapAll();
  if (!equalTrees(cur, ps.startTrees)) rollbackTo(ps.startTrees, cur, planRunDir, 'precheck', ps);
}

/** After a halt: the kept steps must still pass their checks. The first one that fails, and every step after it, is redone. */
async function recheckKept(plan, ps, planRunDir) {
  const { repos, snapAll, equalTrees } = ctx;
  ps.recheck = false;
  const cpPath = checkpointsPath(runDir, plan.id);
  const cps = loadCheckpoints(runDir, plan.id);
  const kept = Object.keys(cps).map(Number).sort((a, b) => a - b);
  if (!kept.length) return;
  try {
    const cur = snapAll();
    const last = cps[kept[kept.length - 1]].trees;
    if (!equalTrees(cur, last)) rollbackTo(last, cur, planRunDir, 'resume', ps);
  } catch (e) {
    log('System', `The kept steps of plan ${plan.id} could not be restored (${e.message}). The plan starts over.`);
    rollbackTo(ps.startTrees, snapAll(), planRunDir, 'resume', ps);
    fs.rmSync(cpPath, { force: true });
    return;
  }
  log('System', `Re-checking the ${kept.length} kept step(s) of plan ${plan.id} before continuing.`);
  for (const n of kept) {
    const s = plan.steps.find((x) => x.n === n);
    const r = s ? await runList(s.verify || [], { repos, defaultRepo: plan.repos[0], env: gateEnv(), changed: [], label: `re-check kept step ${n}` }) : { ok: false, failure: `step ${n} is no longer in the plan` };
    if (r.ok) continue;
    for (const k of kept) if (k >= n) delete cps[k];
    writeJsonAtomic(cpPath, cps);
    const patches = rollbackTo(n > 1 && cps[n - 1] ? cps[n - 1].trees : ps.startTrees, snapAll(), planRunDir, `recheck-step${n}`, ps);
    recordFailure(plan, ps, n, `kept step ${n} no longer passes its check, so steps ${n}-${plan.steps.length} are redone:\n${r.failure}`, patches);
    return;
  }
}

/** The plan's steps changed while it was stopped: the kept steps no longer match it, so it starts over. */
function restartPlan(plan, ps, planRunDir) {
  ps.restart = false; ps.recheck = false;
  log('System', `The steps of plan ${plan.id} changed while it was stopped. Its kept steps no longer match, so the plan starts over (the old work is saved as a .patch).`);
  rollbackTo(ps.startTrees, ctx.snapAll(), planRunDir, 'plan-changed', ps);
  fs.rmSync(checkpointsPath(runDir, plan.id), { force: true });
  Object.assign(ps, { hash: planHash(plan), stepsHash: stepsHash(plan) });
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
  const prompt = `You are a read-only reviewer. An unattended run just changed code in these repositories; the full diffs are in these patch files:${patchNote}\n\nReview ONLY those changes for security and privacy problems: who can call this code, whether identity comes from the server session, input validation, SQL injection, exposed personal data or secrets, and new dependencies in package.json. Use the security-reviewer subagent if it exists. Do not edit anything. Reply with a short list: severity, file, the problem, the fix. If nothing is wrong say "no findings".`;
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--no-session-persistence', '--strict-mcp-config',
    '--setting-sources', 'project,local', '--permission-mode', 'dontAsk', '--max-turns', '25', '--model', 'opus',
    '--add-dir', runDir, ...Object.values(repos).slice(1), '--allowedTools', 'Read', 'Glob', 'Grep', 'Task',
    '--disallowedTools', 'Edit', 'Write'];
  log('System', 'Starting claude for the final review...');
  const facts = await runClaude({ args, prompt, cwd: Object.values(repos)[0], env: sessionEnv(path.join(runDir, 'session.json')), idleMs: 10 * 60000, timeoutMs: 30 * 60000, rawLog: path.join(runDir, 'final-review.jsonl'), label: 'review' });
  const text = facts.result?.result;
  st.finalReview = text ? String(text) : `(the final review did not finish: ${facts.killedFor || describeFailure(facts)})`;
  saveState(runDir, st);
}

// ---------- helpers ----------
// (function declarations: main() runs at the top level before any const below would be initialised)
function lastOf(cps) { return Math.max(0, ...Object.keys(cps).map(Number)); }
function stepName(s) { return s === 'final' ? 'the final check' : `step ${s}`; }
function sha(s) { return crypto.createHash('sha256').update(s).digest('hex'); }
function planText(plan) { try { return fs.readFileSync(path.join(planDir, plan.file), 'utf8').replace(/\r\n/g, '\n'); } catch { return ''; } }
/** The plan as it was approved: its manifest entry and its plan file. */
function planHash(plan) { return sha(`${JSON.stringify(plan)}\n${planText(plan)}`); }
/** Only the steps: when these change, kept checkpoints no longer mean anything. */
function stepsHash(plan) { return sha(JSON.stringify(plan.steps)); }

/** Trees of the last checkpoint of this plan, or of its start. */
function checkpointTrees(plan, ps) {
  const cps = loadCheckpoints(runDir, plan.id);
  const last = lastOf(cps);
  return last ? cps[last].trees : ps.startTrees;
}

/** Puts the files back to the plan's last checkpoint (steps up to it are kept). Returns the last kept step. */
function rollbackToCheckpoint(plan, ps, planRunDir, tag) {
  rollbackTo(checkpointTrees(plan, ps), ctx.snapAll(), planRunDir, tag, ps);
  return lastOf(loadCheckpoints(runDir, plan.id));
}

function keptText(kept) { return kept ? `Steps 1-${kept} passed their checks and are kept; the rest was rolled back (saved as .patch files).` : 'No step was kept; the plan\'s work was rolled back (saved as .patch files).'; }

function rollbackTo(baseTrees, cur, planRunDir, tag, ps) {
  const { repos } = ctx;
  const saved = [];
  for (const [n, d] of Object.entries(repos)) {
    if (cur[n] === baseTrees[n]) continue;
    const patch = patchBetween(d, baseTrees[n], cur[n]);
    if (patch) {
      const f = path.join(planRunDir, `${tag}-${n}.patch`);
      fs.writeFileSync(f, patch);
      ps.patches.push(f);
      saved.push(f);
      log('System', `Saved the discarded work of ${n} as ${f}`);
    }
    const r = restore(d, baseTrees[n], ctx.idxFile(n));
    log('System', `Rolled back ${n}: ${r.removed} file(s) removed, ${r.restored} restored.`);
  }
  return saved;
}

/** Every failed try is kept in full in plans/<id>/failures.log; the log and the report show its first lines. */
function recordFailure(plan, ps, step, failure, patches = [], maxTries = null) {
  const at = new Date().toISOString();
  const text = String(failure || '').trim();
  const f = path.join(runDir, 'plans', plan.id, 'failures.log');
  const tryNote = maxTries ? `, try ${ps.tries} of ${maxTries}` : '';
  try {
    fs.appendFileSync(f, `=== ${at}  plan ${plan.id}, ${stepName(step)}${tryNote}, session ${ps.sessionNo || 0}\n${text}\n${patches.length ? `Discarded work: ${patches.join(', ')}\n` : ''}\n`);
  } catch (e) { log('System', `Could not write ${f}: ${e.message}`); }
  ps.failures.push({ at, step, try: maxTries ? ps.tries : null, session: ps.sessionNo || 0, reason: text.split('\n')[0].slice(0, 300) });
  ps.failures = ps.failures.slice(-100);
  log('System', `Plan ${plan.id}, ${stepName(step)}${maxTries ? `: try ${ps.tries} of ${maxTries} failed` : ''}. Reason:`);
  for (const line of text.split('\n').slice(0, 8)) log('System', `  ${line}`);
  log('System', `Full reason: ${f}`);
}

function keepReport(ps, rep) {
  if (!rep?.ok) return;
  const seen = (list, key) => new Set(list.map(key));
  ps.deviations ||= []; ps.person ||= [];
  const dk = seen(ps.deviations, (d) => `${d.step}|${d.what}`);
  for (const d of rep.deviations) if (!dk.has(`${d.step}|${d.what}`)) ps.deviations.push(d);
  const pk = seen(ps.person, (x) => x);
  for (const x of rep.person) if (!pk.has(x)) ps.person.push(x);
}

function noteRefused(ps, refused = []) {
  ps.refused = (ps.refused || 0) + refused.length;
  (ps.refusedLog ||= []).push(...refused.slice(0, 20).map((r) => `${r.tool}: ${r.what}`));
  ps.refusedLog = ps.refusedLog.slice(-40);
}

/**
 * The not-done items that stop the run. A session that moved forward and then stopped early may mark the steps it did
 * not reach as not done; those are simply continued in a fresh session. Everything else stops the run: an item about a
 * step that already passed its checkpoint, a whole-plan item once every step is checkpointed, and any item from a
 * session that did not move forward (it is saying it cannot do the step, so a blind retry would hit the same wall).
 */
function blockingNotDone(rep, after, progressed, stepCount) {
  if (after >= stepCount || !progressed) return rep.notDone;
  return rep.notDone.filter((x) => x.step >= 1 && x.step <= after);
}

/** The session listed work it did not do. Go back to before the first such step, keep the rest, and let a person decide. */
function notDoneHalt(plan, ps, planRunDir, rep) {
  const cpPath = checkpointsPath(runDir, plan.id);
  const cps = loadCheckpoints(runDir, plan.id);
  const last = lastOf(cps);
  const steps = rep.notDone.map((x) => x.step).filter((n) => n >= 1);
  const earliest = steps.length ? Math.min(...steps) : 0;
  const keep = earliest && earliest <= last ? earliest - 1 : last;
  if (keep < last) { for (const k of Object.keys(cps)) if (Number(k) > keep) delete cps[k]; writeJsonAtomic(cpPath, cps); }
  const patches = rollbackTo(keep ? cps[keep].trees : ps.startTrees, ctx.snapAll(), planRunDir, `notdone-${ps.sessionNo}`, ps);
  const text = rep.notDone.map((x) => `- ${x.step ? `step ${x.step}` : 'whole plan'}: ${x.item} (reason: ${x.reason})`).join('\n');
  keepReport(ps, rep);
  Object.assign(ps, { status: 'notdone', notDone: rep.notDone, lastFailure: `The session reported work it did not do:\n${text}` });
  recordFailure(plan, ps, earliest || 'final', ps.lastFailure, patches);
  saveState(runDir, ctx.st);
  halt(`Plan ${plan.id} STOPPED: the session reported work it did not do:\n${text}\n\n${keptText(keep)}\nDecide what to do: change the plan file (or the environment) so the work can be done, or take the item out of the plan if it is not needed. Do not fix the code by hand. Then run the same command again: it re-checks the kept steps and goes on from step ${keep + 1}.`);
}

/** A safety problem (git state, secrets, another repo): roll back to the last checkpoint and stop. */
function safetyHalt(plan, ps, planRunDir, what) {
  const kept = rollbackToCheckpoint(plan, ps, planRunDir, `safety-${ps.sessionNo || 0}`);
  Object.assign(ps, { status: 'failed', lastFailure: `the session ${what}.` });
  recordFailure(plan, ps, 'final', ps.lastFailure, []);
  saveState(runDir, ctx.st);
  halt(`Plan ${plan.id} ${what}, then run the same command again.\n${keptText(kept)}`);
}

function finalFail(plan, ps, why) {
  const kept = rollbackToCheckpoint(plan, ps, path.join(runDir, 'plans', plan.id), 'final');
  ps.status = 'failed'; saveState(runDir, ctx.st);
  const logFile = path.join(runDir, 'plans', plan.id, 'failures.log');
  halt(`Plan ${plan.id} FAILED: ${why}.\nLast reason:\n${tail(ps.lastFailure || '(none recorded)', 1500)}\n\nEvery reason is in ${logFile}.\n${keptText(kept)}\nFix the cause (usually the plan file, a check, or the environment), then run the same command again: it re-checks the kept steps and goes on from step ${kept + 1}.`);
}

function halt(reason) {
  const { st } = ctx;
  st.status = 'halted'; st.haltReason = reason;
  try { st.stoppedTrees = ctx.snapAll(); } catch { /* keep going: the reason matters more */ }
  saveState(runDir, st);
  log('System', `HALTED: ${reason}`);
  writeReport('HALTED');
  toast('Plan run stopped', `${slug}: ${reason.split('\n')[0].slice(0, 180)}`);
  const e = new Halt(reason); e.code = 1; throw e;
}

function refuse(msg) {
  console.log(`${new Date().toLocaleTimeString()} [System] REFUSED TO START: ${msg}`);
  const e = new Halt(msg); e.code = 2; throw e;
}

function isRateLimited(f) {
  if (f.result?.subtype === 'success' && !f.result.is_error) return false;
  if (f.rateLimit && !['allowed', 'allowed_warning'].includes(f.rateLimit.status)) return true;
  const r = f.result;
  if (r?.is_error) {
    if (r.api_error_status === 429) return true;
    if (/usage limit|rate limit|limit reached|too many requests/i.test(String(r.result || ''))) return true;
  }
  return /usage limit|rate limit|limit reached/i.test(f.stderrTail || '') && !f.result;
}

async function waitForLimit(f) {
  const { st } = ctx;
  const fast = !!process.env.PLAN_RUNNER_FAST; // tests only
  let ms = fast ? 1000 : 15 * 60000;
  if (f.rateLimit?.resetsAt) ms = Math.max(fast ? 1000 : 60000, f.rateLimit.resetsAt * 1000 - Date.now() + (fast ? 0 : 60000));
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
  if (f.spawnError) return `could not start claude: ${f.spawnError}`;
  if (f.killedFor) return `the session was stopped: ${f.killedFor}`;
  const r = f.result;
  if (!r) return `no result from claude (exit ${f.exitCode}). ${tail(f.stderrTail || '', 600)}`;
  if (r.subtype && r.subtype !== 'success') return `claude ended with ${r.subtype}${r.terminal_reason ? ` (${r.terminal_reason})` : ''}`;
  if (r.is_error) return `claude reported an error: ${tail(String(r.result || ''), 600)}`;
  return `claude exited with code ${f.exitCode}`;
}

function buildPrompt(plan, ps, lastStep) {
  const { repos } = ctx;
  const n = plan.steps.length;
  const cp = toPosix(path.join(HERE, 'checkpoint.mjs'));
  const folders = Object.entries(repos).map(([name, d]) => `- ${name}: ${toPosix(d)}`).join('\n');
  const resume = lastStep >= n
    ? `\nALL ${n} steps are ALREADY DONE and checkpointed. Do not redo them and do not run the checkpoint command again. The runner's final check failed (the reason is below): fix only that, run the Acceptance commands, then give your final report.\n`
    : lastStep
      ? `\nSteps 1-${lastStep} are ALREADY DONE and verified. Their changes are in the files now. Do not redo them. Start at step ${lastStep + 1}, after reading the current state of the files.\n`
      : '';
  const fail = ps.lastFailure
    ? `\nAn earlier try of this plan failed. Reason (do not repeat it):\n${tail(ps.lastFailure, 2500)}\n`
    : '';
  return `You are running plan ${plan.id} of feature "${slug}" in an UNATTENDED automated run. Nobody can answer questions.

Plan file: ${toPosix(path.join(planDir, plan.file))}
Workspace folders:
${folders}

Read, in this order: ${toPosix(path.join(planDir, 'INSTRUCTIONS.md'))}, ${toPosix(path.join(planDir, 'HANDOFF.md'))}, then the plan file. Do exactly that plan and nothing else.

CHECKPOINTS: after you finish each numbered step, run this exact command:
  node "${cp}" <step number>
It runs that step's own checks and records a restore point. Go to the next step only when it prints "CHECKPOINT <n> OK". If it refuses, fix the problem and run it again. Never skip a step: the runner checks that every step was checkpointed, and runs every step's check again at the end. Never edit checkpoint or state files.
${resume}${fail}
Shell: use any build, test or language tool the project needs. Run ONE command per Bash call: do not start a command with cd (the working folder is already ${toPosix(repos[plan.repos[0]])}; use paths), do not chain commands with && or ;, and do not redirect output into files with > (create and edit files with the Write and Edit tools). A Bash call can be refused for a deny rule (git changes, network, deploy, publish, secret files). A refusal does NOT mean Bash is off: try the plain one-command form once, then do the work another way. Never drop a task because a command was refused: if the plan truly cannot be done without it, write BLOCKED.md.

Files: you may change any file in the workspace folders except .git/, .env and .env.* (the .env.example family is fine), this plan folder (only BLOCKED.md), and agent settings (.claude/settings*.json, .claude/hooks, .claude/agents, .claude/skills, .claude/commands, .agents/hooks.json, .agents/hooks, .agents/skills). Never change files outside the workspace folders.

If a command from the plan contains {{runner}}, that stands for ${RUNNER_DIR}: put that path in when you run it yourself.

Reminders (the full rules are in INSTRUCTIONS.md): never ask the user a question; never commit, push or change git state; if you truly cannot continue, write BLOCKED.md in ${toPosix(planDir)} with the reason and what you tried, then stop. When every step is checkpointed, run the Acceptance commands, then give the final report.

${reportInstructions(Math.min(lastStep + 1, n + 1), n)}`;
}

function writeHandoff(plan, ps, rep) {
  const f = path.join(planDir, 'HANDOFF.md');
  const old = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '# Handoff\n';
  const files = (ps.changed || []).slice(0, 60).map((p) => `  - ${p}`).join('\n');
  const dep = (ps.deps || []).length ? `\nNew or changed dependencies: ${ps.deps.join(', ')}\n` : '';
  const out = (ps.outside || []).length ? `\nChanged outside allowed_paths: ${ps.outside.join(', ')}\n` : '';
  const lists = formatReport({ deviations: ps.deviations, person: ps.person });
  fs.writeFileSync(f, `${old.trimEnd()}\n\n## Plan ${plan.id} (${plan.file}) - done ${new Date().toLocaleString()}\nFiles changed:\n${files || '  (none)'}\n${dep}${out}\nSession report:\n${ps.summary || '(no summary)'}\n${lists.length ? `\n${lists.join('\n')}\n` : ''}`);
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

function baseEnv() {
  const e = { ...process.env };
  for (const k of ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SSE_PORT', 'CLAUDE_CODE_SESSION_ID']) delete e[k];
  return e;
}
function gateEnv() { return { ...baseEnv(), ...ctx.env, PLAN_RUNNER: '1' }; }
function sessionEnv(sessionFile) {
  const e = { ...gateEnv(), PLAN_RUNNER_SESSION: sessionFile };
  if (process.platform === 'win32') {
    // The PowerShell tool ignores allow rules in dontAsk mode on this setup; Git Bash honours them.
    e.CLAUDE_CODE_USE_POWERSHELL_TOOL = '0';
    if (ctx.gitBash) e.CLAUDE_CODE_GIT_BASH_PATH = ctx.gitBash;
  }
  return e;
}

// ---------- report and status ----------
function writeReport(outcome) {
  try {
    const { st, manifest, repos } = ctx;
    const plans = manifest.plans.map((p) => [p, st.plans[p.id] || {}]);
    const L = [];
    L.push(`# Plan run report: ${slug}`, '', `Result: **${outcome}**`, `Started: ${st.created}`, st.finished ? `Finished: ${st.finished}` : '', st.haltReason ? `\nStopped because:\n\n\`\`\`\n${st.haltReason}\n\`\`\`` : '', '');

    const dev = plans.flatMap(([p, s]) => (s.deviations || []).map((d) => `- **Plan ${p.id}, step ${d.step}:** ${d.what}\n  Why: ${d.reason}`));
    L.push('## 1. Read this: done differently from the plan', '', dev.length ? `A session can call a skipped task "done differently", so read each one.\n\n${dev.join('\n')}` : 'Nothing. Every step was done the way the plan says.', '');
    const out = plans.filter(([, s]) => (s.outside || []).length).map(([p, s]) => `**Plan ${p.id}** (${s.outside.length} file(s)):\n${s.outside.slice(0, 80).map((f) => `- ${f}`).join('\n')}${s.outside.length > 80 ? `\n- ... and ${s.outside.length - 80} more` : ''}`);
    L.push("## 2. Changed outside the plan's allowed_paths", '', out.length ? `Not a failure, but check these: the plan did not say they would change.\n\n${out.join('\n\n')}` : 'Nothing.', '');
    const person = plans.filter(([, s]) => s.status === 'done').flatMap(([p, s]) => [...(p.human_check ? [`- Plan ${p.id}: ${p.human_check}`] : []), ...(s.person || []).map((x) => `- Plan ${p.id}: ${x}`)]);
    L.push('## 3. Needs a person to check (a machine could not)', '', person.length ? person.join('\n') : 'Nothing listed.', '');

    const nd = plans.filter(([, s]) => s.status === 'notdone').flatMap(([p, s]) => (s.notDone || []).map((x) => `- Plan ${p.id}, ${x.step ? `step ${x.step}` : 'whole plan'}: ${x.item} (reason: ${x.reason})`));
    if (nd.length) L.push('## Not done (the run stopped for this)', '', nd.join('\n'), '');
    const weak = plans.filter(([, s]) => (s.weak || []).length).map(([p, s]) => `- Plan ${p.id}: step(s) ${s.weak.join(', ')}`);
    if (weak.length) L.push('## Weak checks (they passed before any work was done)', '', "These checks cannot prove their step was done. Look at those steps' changes yourself.", '', ...weak, '');

    L.push('## Plans', '', '| id | file | status | failed tries | sessions | turns | refused calls |', '|---|---|---|---|---|---|---|');
    for (const [p, s] of plans) L.push(`| ${p.id} | ${p.file} | ${s.status || 'pending'} | ${s.attempts ?? 0} | ${s.sessions ?? 0} | ${s.turns ?? 0} | ${s.refused ?? 0} |`);
    const fl = plans.flatMap(([p, s]) => (s.failures || []).map((f) => `- ${f.at} plan ${p.id}, ${stepName(f.step)}${f.try ? `, try ${f.try}` : ''}: ${f.reason}`));
    L.push('', '## Failed tries', '', fl.length ? `Full reasons: \`plans/<id>/failures.log\` in ${toPosix(runDir)}\n\n${fl.join('\n')}` : 'None.', '');
    const refused = plans.flatMap(([p, s]) => (s.refusedLog || []).map((x) => `- plan ${p.id}: ${x}`));
    L.push('## Refused tool calls', '', refused.length ? refused.slice(-40).join('\n') : 'Nothing was refused.', '');

    const cur = ctx.snapAll();
    L.push('## Files changed (uncommitted, review before you commit)', '');
    for (const [n, d] of Object.entries(repos)) {
      const ch = changedBetween(d, st.baseTrees[n], cur[n]).filter((c) => !(n === primaryName && c.path.startsWith(`${planDirRel}/`)));
      L.push(`**${n}** (branch ${branch(d)}): ${ch.length} file(s)`);
      for (const c of ch.slice(0, 80)) L.push(`- ${c.status} ${c.path}`);
      if (ch.length > 80) L.push(`- ... and ${ch.length - 80} more`);
      L.push('');
    }
    const deps = Object.values(st.plans).flatMap((p) => p.deps || []);
    L.push('## NEW DEPENDENCIES', '', deps.length ? deps.map((d) => `- ${d}`).join('\n') : 'None.', '');
    L.push('## Session reports', '');
    for (const [p, s] of plans) if (s.summary) L.push(`### Plan ${p.id}`, '', s.summary, '');
    L.push('## Final security review', '', st.finalReview || '(not run)', '');
    L.push('## How to continue', '', outcome === 'HALTED' ? `Fix the cause (the plan file, a check or the environment; not the code by hand), then run \`node ${toPosix(path.join(HERE, 'run.mjs'))} run ${slug}\` again. It re-checks the kept steps and goes on from where it stopped. Discarded work is in \`${toPosix(path.join(runDir, 'plans'))}\` as .patch files.` : 'Read sections 1 to 3, review the diff in each repo, then commit it yourself.', '');
    const text = L.filter((x) => x !== undefined).join('\n');
    fs.writeFileSync(path.join(runDir, 'REPORT.md'), text);
    try { fs.writeFileSync(path.join(planDir, 'REPORT.md'), text); } catch { /* ignore */ }
  } catch (e) { log('System', `Could not write the report: ${e.message}`); }
}

function printStatus() {
  const st = loadState(runDir);
  if (!st) { console.log(`No run state for "${slug}" in ${runDir}`); return; }
  console.log(`Run "${slug}": ${st.status}${st.haltReason ? `\n  reason: ${st.haltReason.split('\n')[0]}` : ''}`);
  for (const [id, p] of Object.entries(st.plans)) {
    const cps = loadCheckpoints(runDir, id);
    console.log(`  ${id}: ${p.status}  steps checkpointed=${lastOf(cps)} failed tries=${p.attempts ?? 0}${p.tryStep ? ` (${stepName(p.tryStep)}: ${p.tries ?? 0})` : ''} sessions=${p.sessions} turns=${p.turns}${p.lastFailure ? `\n      last failure: ${p.lastFailure.split('\n')[0]}` : ''}`);
  }
  console.log(`State folder: ${runDir}`);
}
