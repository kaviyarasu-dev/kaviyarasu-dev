#!/usr/bin/env node
// Unattended plan runner for Antigravity CLI (agy). Same plan folders and manifest as the Claude Code runner.
//   node run.mjs run <slug> [--repo <path>] [--dry-run] [--reset] [--no-isolation] [--from <plan id>]
//   node run.mjs status <slug> [--repo <path>]
// Run it from inside the main repo (or pass --repo). Plans live in <repo>/docs/plans/<slug>/.
// Rules: one fresh `agy -p` session per plan, never trust "done", no step is ever skipped (every step must be
// checkpointed, every check re-runs at the end, the session must report what it did not do), stop at the first
// failure, nothing is ever committed, everything is resumable.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateFolder } from './validate.mjs';
import { toplevel, isGitRepo, dirtyPaths, snapshot, restore, changedBetween, patchBetween, fileAt, branch } from './lib/git.mjs';
import { runAgy, agyCommand, killTree, activePids, quotaError, retryAfterMs } from './lib/agy.mjs';
import { buildSessionHome, sessionEnv, scrubEnv, selfTestGuard, probeAgy } from './lib/home.mjs';
import {
  changedPaths, scopeCheck, runList, phpLintChanged, DEP_FILES, secretFingerprint, secretChanges, gitHeads, headChanges,
  otherRepos, repoFingerprints, fingerprintChanges, RUNNER_DIR,
} from './lib/gates.mjs';
import { REPORT_SCHEMA, REVIEW_SCHEMA, reportInstructions, extractReport, checkReport, checkReview, formatReport } from './lib/report.mjs';
import { runDirFor, loadState, saveState, loadCheckpoints, checkpointsPath, acquireLock } from './lib/state.mjs';
import { toast, keepAwake } from './lib/system.mjs';
import { log, setLogFile, sleep, readJson, writeJsonAtomic, toPosix, tail, fmtDuration, scrubEnv as scrubSecrets } from './lib/util.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = path.join(HERE, 'lib');
const DEFAULT_LIMIT_WAIT_H = 7 * 24; // the longest ONE usage-limit wait may be (weekly limits reset within a week)
const CONTEXT_MAX = 300; // entries kept in CONTEXT.md (the oldest are dropped)
// agy counts every tool call, Claude counts assistant turns. The manifest's turn numbers (est_turns, max_turns) are
// Claude turns, so they are multiplied by this to get tool calls.
const TOOL_CALLS_PER_TURN = 3;
const HALTED = ['failed', 'blocked', 'notdone']; // plan states a new start resumes from the kept checkpoints

class Halt extends Error {}

// ---------- args ----------
const argv = process.argv.slice(2);
const cmd = argv[0];
const flag = (n) => argv.includes(n);
const opt = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const slug = argv[1] && !argv[1].startsWith('--') ? argv[1] : undefined;
if (!['run', 'status'].includes(cmd) || !slug) {
  console.log('Usage:\n  node run.mjs run <slug> [--repo <path>] [--dry-run] [--reset] [--no-isolation] [--from <plan id>]\n  node run.mjs status <slug> [--repo <path>]');
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
  console.log('\nInterrupted. Stopping the agy session; the plan is rolled back to its last checkpoint on the next start.');
  for (const pid of activePids) killTree(pid);
  try { if (ctx?.st) { ctx.st.status = 'halted'; ctx.st.haltReason = 'interrupted by user (Ctrl+C)'; saveState(runDir, ctx.st); } } catch { /* ignore */ }
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
  const from = opt('--from');
  if (from && st) refuse('--from only works on a fresh run. Add --reset (the repos must be clean: commit the work you keep first).');
  const fromIdx = from ? manifest.plans.findIndex((p) => p.id === from) : -1;
  if (from && fromIdx < 0) refuse(`--from: there is no plan "${from}" in the manifest.`);

  if (!st) {
    for (const [n, d] of Object.entries(repos)) {
      const dirty = dirtyPaths(d, { ignorePrefixes: n === primaryName ? ['docs/plans/'] : [] });
      if (dirty.length) refuse(`${n} has uncommitted changes (${dirty.slice(0, 5).join(', ')}${dirty.length > 5 ? ', ...' : ''}). Commit or stash them first, so a rollback can never lose your work.`);
    }
    const trees = snapAll();
    st = { feature: slug, primary, created: new Date().toISOString(), status: 'running', setupDone: false, baseTrees: trees, lastGoodTrees: trees,
      stoppedTrees: null, doneSinceSweep: 0, sweepPending: false, e2ePending: false, sinceSweep: [], pausesDone: [], waitedMs: 0, plans: {}, repos,
      isolation: noIsolation ? 'none' : 'throwaway HOME', archHash: archHash() };
    // --from: the plans before it were finished in an earlier run and their work is committed. They count as done.
    for (const p of manifest.plans.slice(0, Math.max(0, fromIdx))) {
      st.plans[p.id] = { status: 'done', adopted: true, hash: planHash(p), stepsHash: stepsHash(p), endTrees: trees, finishedAt: st.created, attempts: 0, tries: 0, sessions: 0, turns: 0, refused: 0, patches: [], failures: [] };
    }
    saveState(runDir, st);
    log('System', `Fresh run. Both repos were clean.${fromIdx > 0 ? ` Plans before ${from} (${fromIdx}) count as done (--from).` : ''}`);
  } else {
    if (st.status === 'complete') { log('System', 'This run is already complete. Use --reset to run it again.'); return; }
    st.status = 'running'; st.haltReason = null;
    st.waitedMs = 0; // the usage-limit wait budget is per start, never carried over
    st.sinceSweep ||= []; st.pausesDone ||= [];
    const ah = archHash();
    if (st.archHash && ah !== st.archHash) {
      log('System', 'WARNING: ARCHITECTURE.md changed since the run started. The plans still to run will follow the new version; the finished ones were built on the old one.');
      (st.archChanges ||= []).push(new Date().toISOString());
    }
    st.archHash = ah;
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
  const big = ['L', 'XL'].includes(manifest.size);
  Object.assign(ctx, { st, snapAll, equalTrees, idxFile, every, secretsBefore: secretFingerprint(repos), others, othersBefore: repoFingerprints(others),
    planReview: manifest.plan_review ?? big, reviewBlocks: manifest.final_review_blocks ?? big });
  if (ctx.planReview) log('System', 'Every plan is read by a separate read-only reviewer before it counts as done (plan_review).');

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
  writeReport('RUNNING');

  // 8. the plans, strictly in order. A failed full or end-to-end check is repeated before the next normal plan, so
  // the run never builds on a broken base; "repair" plans (added after such a failure) run before that repeat.
  for (const plan of manifest.plans) {
    const ps = (st.plans[plan.id] ||= { status: 'pending', attempts: 0, tries: 0, sessions: 0, continuations: 0, limitWaits: 0, turns: 0, refused: 0, patches: [], failures: [] });
    if (ps.status === 'done') continue;
    if (!plan.repair) {
      if (st.sweepPending) await sweep(`before plan ${plan.id}`);
      if (st.e2ePending) await e2e(`before plan ${plan.id}`);
    }
    for (const d of plan.depends_on) if (st.plans[d]?.status !== 'done') halt(`Plan ${plan.id} depends on ${d}, which is not done.`);
    await executePlan(plan, ps);
  }

  // 9. finish: the whole suite, the app end to end, then the read-only review of everything
  await sweep('after the last plan');
  await e2e('at the end');
  await finalReview();
  st.status = 'complete'; st.finished = new Date().toISOString(); saveState(runDir, st);
  writeReport('COMPLETE');
  const outside = Object.values(st.plans).reduce((a, p) => a + (p.outside || []).length, 0);
  const devs = Object.values(st.plans).reduce((a, p) => a + (p.deviations || []).length, 0);
  toast('Plan run complete', `${slug}: all ${manifest.plans.length} plans done.${devs ? ` ${devs} thing(s) done differently from the plan.` : ''}${outside ? ` ${outside} file(s) changed outside the plans.` : ''} Read the report, then commit.`);
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

/** What the guard needs to keep file writes inside the project and out of the plan folder. */
function guardScope(review = false) {
  return { roots: Object.values(ctx.repos), planDir, allowWrite: [os.tmpdir(), homeDir(review)] };
}

/** True when the run starts read-only review sessions (the final review, or a review of every plan). */
function reviews(m) { return m.final_review !== false || (m.plan_review ?? ['L', 'XL'].includes(m.size)); }

/** Everything that can be checked without spending model usage. Refuses to start when something is wrong. */
function preflight() {
  const { manifest, perms } = ctx;
  try { agyCommand(); } catch (e) { refuse(e.message); }
  let env;
  if (noIsolation) {
    log('System', 'WARNING: --no-isolation. The session uses your own agy settings, plugins and permissions and is NOT restricted by the deny rules. Only the runner-side checks protect your files.');
    env = { ...scrubEnv(process.env), ...ctx.env };
  } else {
    const built = buildSessionHome({ dir: homeDir(), permissions: perms, manifestDeny: manifest.permissions?.deny || [], libDir: LIB, scope: guardScope() });
    const bad = selfTestGuard(built.cfgDir);
    if (bad) refuse(`The safety guard failed its self-test: ${bad}`);
    log('System', 'Safety guard self-test passed (it refuses git changes, secret files and writes outside the project, and lets normal commands through).');
    env = sessionEnv(process.env, ctx.env, homeDir());
    if (reviews(manifest)) { // the read-only home of the reviews is checked now too, so a bad one cannot surprise the end of a long run
      const rev = buildSessionHome({ dir: homeDir(true), permissions: perms, manifestDeny: manifest.permissions?.deny || [], libDir: LIB, readOnly: true, scope: guardScope(true) });
      const badRev = selfTestGuard(rev.cfgDir, { readOnly: true });
      if (badRev) refuse(`The read-only guard of the final review failed its self-test: ${badRev}`);
    }
  }
  const probe = probeAgy(env, primary);
  if (!probe.ok) refuse(`agy could not start${noIsolation ? '' : ' in its isolated HOME'}: ${probe.error}${noIsolation ? '' : '\nIf agy cannot sign in from the isolated HOME on this computer, run with --no-isolation (then the session itself is not restricted).'}`);
  const need = new Set([...(reviews(manifest) ? [reviewModel()] : []), ...manifest.plans.map(modelFor)]);
  for (const m of need) if (!probe.slugs.includes(m)) refuse(`The model "${m}" is not available in agy. Run "agy models" and fix config/models.json or the manifest (model / agy_model). Available: ${probe.slugs.join(', ')}`);
  log('System', `agy OK. Models in use: ${[...need].join(', ')}.${noIsolation ? '' : ' Each session runs in its own throwaway HOME.'}`);
}

/** One agy session. review=true gives it read access only. */
async function agySession(o) {
  const { perms, manifest } = ctx;
  const vars = { ...passEnv(), ...ctx.env, PLAN_RUNNER: '1', PLAN_RUNNER_SESSION: o.sessionFile };
  let env;
  let deniedLog = null;
  if (noIsolation) env = { ...scrubEnv(process.env), ...vars };
  else {
    const built = buildSessionHome({ dir: homeDir(o.review), permissions: perms, manifestDeny: manifest.permissions?.deny || [], libDir: LIB, readOnly: !!o.review, scope: guardScope(o.review) });
    deniedLog = built.deniedLog;
    fs.rmSync(deniedLog, { force: true });
    env = sessionEnv(process.env, vars, homeDir(o.review));
  }
  const args = ['--model', o.model];
  if (o.schemaFile) args.push('--json-schema', o.schemaFile);
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
  const maxTries = plan.max_attempts ?? defaults.max_attempts;
  const maxToolSteps = (plan.max_turns ?? defaults.max_turns) * TOOL_CALLS_PER_TURN;
  const hardSessions = (plan.steps.length + 1) * (maxTries + 2) + 6;
  const planRunDir = path.join(runDir, 'plans', plan.id);
  fs.mkdirSync(planRunDir, { recursive: true });
  ps.failures ||= []; ps.patches ||= [];
  const schemaFile = path.join(runDir, 'report-schema.json');
  writeJsonAtomic(schemaFile, REPORT_SCHEMA);
  log('System', `=== Plan ${plan.id}: ${plan.file} (${plan.steps.length} steps, est ${plan.est_turns} turns, ${modelFor(plan)}) ===`);

  if (ps.status === 'pending') {
    Object.assign(ps, { status: 'running', startedAt: new Date().toISOString(), startTrees: snapAll(), hash: planHash(plan), stepsHash: stepsHash(plan) });
    fs.rmSync(checkpointsPath(runDir, plan.id), { force: true });
    saveState(runDir, st);
    if (manifest.precheck !== false && plan.precheck !== false) { await prepareEnv('pre-check'); await precheck(plan, ps, planRunDir); }
  } else {
    if (ps.restart) restartPlan(plan, ps, planRunDir);
    if (ps.recheck) { await prepareEnv('re-check'); await recheckKept(plan, ps, planRunDir); }
  }
  saveState(runDir, st);

  while (true) {
    const cps = loadCheckpoints(runDir, plan.id);
    const lastStep = lastOf(cps);
    const baseTrees = lastStep ? cps[lastStep].trees : ps.startTrees;

    // Make the files match the last good point exactly. A crash or failed try may have left debris.
    const cur = snapAll();
    if (!equalTrees(cur, baseTrees)) rollbackTo(baseTrees, cur, planRunDir, `partial-${ps.sessionNo || 0}`, ps);
    // ...and the test database (and installed packages) match those files: a rolled-back try must not leave its
    // migrations or rows behind for the next one.
    await prepareEnv(`plan ${plan.id}`);

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
      frozen: frozenFor(plan), unfreeze: plan.unfreeze || [],
    });

    const prompt = buildPrompt(plan, ps, lastStep);
    const extraDirs = [...new Set([...Object.values(repos), planDir])].filter((d) => d !== repos[planRepos[0]]);

    log('System', `Starting agy for ${plan.file}... (session ${ps.sessionNo}, ${stepName(curStep)} try ${ps.tries + 1}/${maxTries}${lastStep ? `, resuming after step ${lastStep}` : ''})`);
    const headsBefore = gitHeads(repos);
    const t0 = Date.now();
    const facts = await agySession({
      prompt, model: modelFor(plan), cwd: repos[planRepos[0]], extraDirs, sessionFile, schemaFile,
      idleMs: (plan.idle_min ?? defaults.idle_min) * 60000, timeoutMs: (plan.timeout_min ?? defaults.timeout_min) * 60000,
      maxToolSteps, rawLog: path.join(planRunDir, `session-${ps.sessionNo}.jsonl`),
      stopAfterCheckpoint: (toolSteps) => {
        const c = loadCheckpoints(runDir, plan.id);
        return toolSteps > plan.est_turns * TOOL_CALLS_PER_TURN * 1.5 && lastOf(c) < plan.steps.length;
      },
    });
    ps.turns += facts.toolSteps;
    noteRefused(ps, facts.refused);
    const r = facts.result;
    log('System', `Session ended after ${fmtDuration(Date.now() - t0)}: exit ${facts.exitCode}, ${r ? `${r.status}${r.error ? ' (error)' : ''}` : 'no result event'}, ${facts.toolSteps} tool call(s)${facts.killedFor ? `, stopped: ${facts.killedFor}` : ''}.`);

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

    // (a) usage limit or spent credits: wait, do not count a try
    if (quotaError(facts)) {
      ps.limitWaits = (ps.limitWaits || 0) + 1; // no count limit: agy gives no reset time, so waitForLimit caps the total wait
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
    // agy exits 0 and says SUCCESS even when a tool call was refused, so only the gates below mean anything.
    const rep = checkReport(extractReport(r?.structured_output, r?.response), { firstStep: Math.min(lastStep + 1, plan.steps.length + 1), stepCount: plan.steps.length });
    let failure = null;
    const finished = r && r.status === 'SUCCESS' && !r.error && (facts.exitCode === 0 || facts.lingered) && !facts.killedFor;
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
      else if (ctx.planReview && plan.review !== false) {
        const rv = await planReview(plan, ps, rep, planRunDir);
        if (!rv.ok) failure = rv.failure;
      }
    }

    if (!failure) {
      keepReport(ps, rep);
      ps.summary = rep.summary || String(r?.response || '').trim();
      Object.assign(ps, { status: 'done', finishedAt: new Date().toISOString(), lastFailure: null, hash: planHash(plan) });
      writeHandoff(plan, ps);
      writeContext(plan, rep);
      st.lastGoodTrees = snapAll();
      ps.endTrees = st.lastGoodTrees;
      st.doneSinceSweep++;
      st.sinceSweep.push(plan.id);
      saveState(runDir, st);
      log('System', `Plan ${plan.id} DONE.`);
      writeReport('RUNNING');
      if (st.doneSinceSweep >= ctx.every) await sweep(`after plan ${plan.id}`);
      if ((manifest.pause_after || []).includes(plan.id) && !st.pausesDone.includes(plan.id)) await milestone(plan);
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

  const sc = scopeCheck({ changed, allowed: plan.allowed_paths, extra: plan.allow_extra || [], planDirRel, primaryName, frozen: frozenFor(plan), unfreeze: plan.unfreeze || [] });
  if (!sc.ok) return { ok: false, failure: `SCOPE GATE: the session changed blocked files (git, secrets, agent settings, the plan folder or a frozen test):\n${sc.violations.join('\n')}` };
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

/** Before every session and every whole-app check: reinstall packages a rollback changed, then reset the test database. */
async function prepareEnv(label) {
  const { st, manifest, repos } = ctx;
  if (st.depsDirty) {
    const list = manifest.deps_install || [];
    if (list.length) {
      log('System', 'A rollback changed package files. Reinstalling (deps_install).');
      const r = await runList(list, { repos, defaultRepo: primaryName, env: gateEnv(), label: 'deps_install' });
      if (!r.ok) halt(`deps_install failed (${label}). Fix the environment, then run the same command again.\n${r.failure}`);
    } else log('System', 'WARNING: a rollback changed package files, so installed packages (node_modules, vendor ...) may not match them. Add "deps_install" to the manifest to reinstall them automatically.');
    st.depsDirty = false; saveState(runDir, st);
  }
  const reset = manifest.reset || [];
  if (!reset.length) return;
  const r = await runList(reset, { repos, defaultRepo: primaryName, env: gateEnv(), label: 'reset' });
  if (!r.ok) halt(`The reset commands failed (${label}). They must rebuild the throwaway test database from the current files. Fix them or the environment, then run the same command again.\n${r.failure}`);
}

/** What to do after a whole-app check or the final review fails. */
function repairHint() {
  const last = [...ctx.manifest.plans].reverse().find((p) => ctx.st.plans[p.id]?.status === 'done');
  return `Fix it with a REPAIR plan, not by hand: run /plan-replan ${slug} (it writes one), or add a plan to manifest.json right after plan ${last?.id ?? '(the last finished one)'} with "repair": true and a step whose check is the failing command. Then run the same command again: repair plans run first, then this check is repeated before any other plan.`;
}

async function sweep(when) {
  const { st, manifest, repos } = ctx;
  const list = manifest.full_gates || [];
  if (!list.length) { st.doneSinceSweep = 0; st.sweepPending = false; st.sinceSweep = []; saveState(runDir, st); return; }
  log('System', `Full check ${when}.`);
  st.sweepPending = true; saveState(runDir, st);
  await prepareEnv('full check');
  const r = await runList(list, { repos, defaultRepo: primaryName, env: gateEnv(), changed: [], label: 'full check' });
  if (!r.ok) {
    const culprit = await bisect(list, 'full check');
    halt(`The full check failed ${when}. Nothing after this ran.\n${culprit}${r.failure}\n\n${repairHint()}`);
  }
  st.doneSinceSweep = 0; st.sweepPending = false; st.sinceSweep = []; saveState(runDir, st);
}

/** The app end to end (start it, run the user journeys). At every milestone and at the end. */
async function e2e(when) {
  const { st, manifest, repos } = ctx;
  const list = manifest.e2e_gates || [];
  if (!list.length) { if (st.e2ePending) { st.e2ePending = false; saveState(runDir, st); } return; }
  log('System', `End-to-end check ${when}.`);
  st.e2ePending = true; saveState(runDir, st);
  await prepareEnv('end-to-end check');
  const r = await runList(list, { repos, defaultRepo: primaryName, env: gateEnv(), changed: [], label: 'end-to-end check' });
  if (!r.ok) halt(`The end-to-end check failed ${when}. Every plan passed its own checks, but the app does not work as a whole.\n${r.failure}\n\n${repairHint()}`);
  st.e2ePending = false; saveState(runDir, st);
}

/**
 * The full check failed: find the first plan since the last green check after which it fails, by putting the files back
 * to each candidate's finished state (a binary search). It assumes the check passed before those plans. The files are
 * always put back as they were. Returns a line for the halt message ('' when it cannot tell).
 */
async function bisect(list, label) {
  const { st, manifest, repos, snapAll } = ctx;
  const ids = (st.sinceSweep || []).filter((id) => st.plans[id]?.endTrees);
  if (!ids.length) return '';
  let found = ids[0];
  if (ids.length > 1 && manifest.bisect !== false) {
    log('System', `Finding which of plans ${ids.join(', ')} broke the ${label} (the files are put back afterwards).`);
    const cur = snapAll();
    try {
      let lo = 0, hi = ids.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        for (const [n, d] of Object.entries(repos)) restore(d, st.plans[ids[mid]].endTrees[n], ctx.idxFile(n));
        st.depsDirty = true;
        await prepareEnv(`finding the plan that broke the ${label}`);
        const r = await runList(list, { repos, defaultRepo: primaryName, env: gateEnv(), changed: [], label: `${label} after plan ${ids[mid]}` });
        if (r.ok) lo = mid + 1; else hi = mid;
      }
      found = ids[lo];
    } catch (e) {
      log('System', `Could not finish the search (${e.message}).`);
      found = null;
    } finally {
      for (const [n, d] of Object.entries(repos)) restore(d, cur[n], ctx.idxFile(n));
      st.depsDirty = true; saveState(runDir, st);
    }
  }
  if (!found) return '';
  st.bisect = { at: new Date().toISOString(), label, plan: found, candidates: ids };
  saveState(runDir, st);
  return `It first fails after plan ${found}${ids.length > 1 ? ` (checked plans ${ids.join(', ')}; assumes the check passed before them)` : ''}.\n`;
}

/** A milestone in "pause_after": check the whole app, then stop so a person can look at it. */
async function milestone(plan) {
  const { st } = ctx;
  if (st.doneSinceSweep > 0) await sweep(`at milestone ${plan.id}`);
  await e2e(`at milestone ${plan.id}`);
  st.pausesDone.push(plan.id);
  const devs = Object.values(st.plans).reduce((a, p) => a + (p.deviations || []).length, 0);
  pause(`Milestone after plan ${plan.id}: the full and end-to-end checks passed. Look at the app now (run it, try the journeys of the finished plans), and read REPORT.md.${devs ? ` ${devs} thing(s) were done differently from the plan: if a later plan relies on them, run /plan-replan ${slug} first.` : ''} Then run the same command again to continue.`);
}

/** One read-only agy session that answers in REVIEW_SCHEMA. Returns the checked answer. */
async function reviewSession({ prompt, rawLog, maxToolSteps }) {
  const { repos } = ctx;
  const schemaFile = path.join(runDir, 'review-schema.json');
  writeJsonAtomic(schemaFile, REVIEW_SCHEMA);
  let facts;
  try {
    facts = await agySession({
      review: true, prompt, model: reviewModel(), cwd: Object.values(repos)[0], extraDirs: [runDir, planDir, ...Object.values(repos).slice(1)], schemaFile,
      sessionFile: path.join(runDir, 'session.json'), idleMs: 10 * 60000, timeoutMs: 30 * 60000, maxToolSteps, rawLog,
    });
  } catch (e) { return { ok: false, failure: `the review could not run safely (${e.message})` }; }
  if (quotaError(facts)) { await waitForLimit(facts); return reviewSession({ prompt, rawLog, maxToolSteps }); }
  const r = facts.result;
  const rv = checkReview(extractReport(r?.structured_output, r?.response, 'verdict'));
  return rv.ok ? rv : { ...rv, failure: `${rv.failure}${facts.killedFor || !r ? ` (${describeFailure(facts)})` : ''}` };
}

/** Diffs of a plan's work, one patch file per changed repo. Returns the list of "- repo: file" lines. */
function writePatches(fromTrees, cur, dir, tag) {
  let note = '';
  for (const [n, d] of Object.entries(ctx.repos)) {
    const p = patchBetween(d, fromTrees[n], cur[n]);
    if (!p) continue;
    const f = path.join(dir, `${tag}-${n}.patch`);
    fs.writeFileSync(f, p);
    note += `\n- ${n}: ${toPosix(f)}`;
  }
  return note;
}

function docList() { return ['ARCHITECTURE.md', 'CONTEXT.md'].filter((f) => fs.existsSync(path.join(planDir, f))).map((f) => toPosix(path.join(planDir, f))); }

/**
 * A separate read-only session reads the plan's diff against the plan and the architecture. The checks only prove that
 * commands exit 0; this asks whether they prove the right thing (a test that passes when the code is wrong, a stub,
 * a contradiction with the architecture). A critical or high problem is a failed try with the problems as the reason.
 */
async function planReview(plan, ps, rep, planRunDir) {
  const patches = writePatches(ps.startTrees, ctx.snapAll(), planRunDir, `review-${ps.sessionNo}`);
  if (!patches) return { ok: true };
  const docs = docList();
  log('System', `Plan review of ${plan.id} (read-only).`);
  const prompt = `You are a strict, read-only REVIEWER of one plan of an unattended build. You did not write this code. Nobody can answer questions. You can only read files: do not try to run commands or edit anything.

Plan file: ${toPosix(path.join(planDir, plan.file))}
${docs.length ? `Project documents the code must follow: ${docs.join(', ')}\n` : ''}The plan's changes (diffs): ${patches}
The checks the runner ran (all passed): ${JSON.stringify([...plan.steps.flatMap((s) => s.verify || []), ...plan.verify])}
What the session reported: ${JSON.stringify({ different_from_plan: rep.deviations, summary: rep.summary }).slice(0, 4000)}

Read the plan, the documents and the diffs (open the changed files when you need more). Then answer:
1. Do the tests and checks really prove every Acceptance item and every item of every step? Name each test or check that would still pass if the code were wrong: trivial asserts, mocking the very thing under test, hard-coded expected values, skipped or deleted tests, assertions weakened, a check that only greps for a name.
2. Is anything the plan asks for missing, stubbed, faked or hard-coded (TODO, "not implemented", a fixed return value)?
3. Does the code contradict the architecture document (stack, data model, API contracts, auth, error format, conventions), or duplicate something CONTEXT.md says already exists?
4. Security in this diff: who can call it, identity from the server session, input validation, injection, secrets, money or prices in floating point.

Severity: "critical" or "high" ONLY when the plan's goal is not really met, a check proves nothing, or the code is unsafe. Style, naming and nice-to-haves are "medium" or "low". "verdict" is "fail" when there is any critical or high problem, else "pass". Give the file and a concrete fix for each problem. End with the JSON answer only.`;
  const run = () => reviewSession({ prompt, rawLog: path.join(planRunDir, `review-${ps.sessionNo}.jsonl`), maxToolSteps: 90 });
  let rv = await run();
  if (!rv.ok) { log('System', `The plan review gave no valid answer (${rv.failure}). Trying it once more.`); rv = await run(); }
  if (!rv.ok) {
    ps.review = `(the plan review did not finish: ${rv.failure})`;
    log('System', `WARNING: ${ps.review} Plan ${plan.id} is judged by its checks only (listed in the report).`);
    return { ok: true };
  }
  ps.review = rv.text;
  if (!rv.blocking.length) { log('System', `Plan review of ${plan.id}: pass${rv.problems.length ? ` (${rv.problems.length} minor finding(s), in the report)` : ''}.`); return { ok: true }; }
  return { ok: false, failure: `PLAN REVIEW: a read-only reviewer read the diff and found problems that must be fixed (the checks passed, but they do not prove the work is right):\n${rv.text}` };
}

async function finalReview() {
  const { st, manifest, snapAll } = ctx;
  if (manifest.final_review === false) return;
  const patchNote = writePatches(st.baseTrees, snapAll(), runDir, 'final');
  if (!patchNote) return;
  log('System', 'Final security review (read-only).');
  const docs = docList();
  const prompt = `You are a read-only REVIEWER. An unattended run just built or changed code in these repositories; the full diffs are in these patch files:${patchNote}
${docs.length ? `The architecture and the map of what was built: ${docs.join(', ')}\n` : ''}
The diff may be large: search it for what matters instead of reading it all. You can only read files: do not try to run commands or edit anything. Review the changes for security, privacy and production problems: who can call each endpoint, whether identity comes from the server session, authorization on every object, input validation, injection, exposed personal data or secrets, money handled in floating point, missing rate limits on login and money movements, missing idempotency on payments and orders, missing audit logs, and new dependencies. "critical" or "high" only for a real exploitable or data-losing problem. "verdict" is "fail" when there is any critical or high problem. End with the JSON answer only.`;
  log('System', 'Starting agy for the final review...');
  const rv = await reviewSession({ prompt, rawLog: path.join(runDir, 'final-review.jsonl'), maxToolSteps: 120 });
  st.finalReview = rv.ok ? rv.text : `(the final review did not finish: ${rv.failure})`;
  saveState(runDir, st);
  if (!ctx.reviewBlocks) return;
  if (!rv.ok) halt(`The final review did not finish (${rv.failure}), and final_review_blocks is on. Run the same command again to repeat it.`);
  if (rv.blocking.length) halt(`The final review found ${rv.blocking.length} critical or high problem(s):\n${rv.text}\n\n${repairHint()}\n(To accept them instead, set "final_review_blocks": false in the manifest.)`);
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
function archHash() { try { return sha(fs.readFileSync(path.join(planDir, 'ARCHITECTURE.md'), 'utf8').replace(/\r\n/g, '\n')); } catch { return null; } }

/** The files finished plans froze (their tests and test config), which this plan may not change. */
function frozenFor(plan) {
  const { st, manifest } = ctx;
  return manifest.plans.filter((p) => p.id !== plan.id && st.plans[p.id]?.status === 'done')
    .flatMap((p) => (p.freeze || []).map((glob) => ({ glob, by: p.id })));
}

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
    if (changedBetween(d, baseTrees[n], cur[n]).some((c) => DEP_FILES.includes(path.posix.basename(c.path)))) ctx.st.depsDirty = true;
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

function halt(reason) { stop('halted', 'HALTED', reason, 1); }

/** A planned stop (a milestone): exit code 0, the same resume rules as a halt. */
function pause(reason) { stop('paused', 'PAUSED', reason, 0); }

function stop(status, outcome, reason, code) {
  const { st } = ctx;
  st.status = status; st.haltReason = reason;
  try { st.stoppedTrees = ctx.snapAll(); } catch { /* keep going: the reason matters more */ }
  saveState(runDir, st);
  log('System', `${outcome}: ${reason}`);
  writeReport(outcome);
  toast(code ? 'Plan run stopped' : 'Plan run paused for review', `${slug}: ${reason.split('\n')[0].slice(0, 180)}`);
  const e = new Halt(reason); e.code = code; throw e;
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
  // agy gives no reset time, so the cap is on the total wait since this start (a resume starts a new budget)
  const capH = ctx.manifest.max_limit_wait_hours ?? DEFAULT_LIMIT_WAIT_H;
  if (st.waitedMs + ms > capH * 3600000) halt(`Waited ${fmtDuration(st.waitedMs)} for the usage limit since this start, the most max_limit_wait_hours (${capH}) allows. Run the same command again after the reset.`);
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
  const shell = process.platform === 'win32'
    ? 'Your shell is Windows PowerShell: join commands with ";" (not "&&"), and create or edit files with the file tools, not with ">" redirects (PowerShell writes those as UTF-16).'
    : 'Create and edit files with the file tools.';
  return `You are running plan ${plan.id} of feature "${slug}" in an UNATTENDED automated run. Nobody can answer questions.

Plan file: ${toPosix(path.join(planDir, plan.file))}
Workspace folders:
${folders}

${readOrder(plan)}

CHECKPOINTS: after you finish each numbered step, run this exact command:
  node "${cp}" <step number>
It runs that step's own checks and records a restore point. Go to the next step only when it prints "CHECKPOINT <n> OK". If it refuses, fix the problem and run it again. Never skip a step: the runner checks that every step was checkpointed, and runs every step's check again at the end. Never edit checkpoint or state files.
${resume}${fail}
Shell: use any build, test or language tool the project needs. ${shell} A tool call can be refused by a rule (git changes, network, deploy, publish, secret files, recursive deletes, files outside the project). A refusal does NOT mean the shell is off. Do not retry the same command: do the same work another way (for example with the file tools; the runner does all git work itself, so a refused git command needs no replacement). Never drop a task because a command was refused: if the plan truly cannot be done without it, write BLOCKED.md.

Files: you may change any file in the workspace folders except .git/, .env and .env.* (the .env.example family is fine), this plan folder (only BLOCKED.md), and agent settings (.agents/hooks.json, .agents/hooks, .agents/skills, .agents/workflows, .gemini/, .claude/settings*.json, .claude/hooks, .claude/agents, .claude/skills, .claude/commands). Never change files outside the workspace folders.

If a command from the plan contains {{runner}}, that stands for ${RUNNER_DIR}: put that path in when you run it yourself.

Reminders (the full rules are in INSTRUCTIONS.md): never ask the user a question; never commit, push or change git state; if you truly cannot continue, write BLOCKED.md in ${toPosix(planDir)} with the reason and what you tried, then stop. When every step is checkpointed, run the Acceptance commands, then give the final report.

${reportInstructions(Math.min(lastStep + 1, n + 1), n)}`;
}

/**
 * What a session reads before its plan. ARCHITECTURE.md holds the decisions every plan must follow; CONTEXT.md is the
 * short, kept-current map of what earlier plans built. HANDOFF.md is the full history and grows with every plan, so it
 * is searched, not read whole.
 */
function readOrder(plan) {
  const f = (n) => toPosix(path.join(planDir, n));
  const has = (n) => fs.existsSync(path.join(planDir, n));
  const list = [f('INSTRUCTIONS.md'), ...(has('ARCHITECTURE.md') ? [f('ARCHITECTURE.md')] : []), ...(has('CONTEXT.md') ? [f('CONTEXT.md')] : [])];
  const frozen = frozenFor(plan);
  return `Read, in this order: ${list.join(', ')}, then the plan file. Do exactly that plan and nothing else.${has('ARCHITECTURE.md') ? '\nARCHITECTURE.md is locked: follow its stack, data model, API contracts, auth and conventions exactly. If the plan seems to need something different, do it the architecture\'s way and list it under "different_from_plan"; if that is impossible, write BLOCKED.md.' : ''}${has('CONTEXT.md') ? '\nCONTEXT.md lists what earlier plans built. Reuse it; never write a second version of something listed there.' : ''}
${toPosix(path.join(planDir, 'HANDOFF.md'))} is the full history of earlier plans. It is long: search it (grep_search) when you need an older detail instead of reading all of it.${frozen.length ? `\nFrozen (tests and test config of finished plans; you may not change them${(plan.unfreeze || []).length ? `, except ${plan.unfreeze.join(', ')}` : ''}): ${frozen.map((x) => x.glob).join(', ')}. If one fails, fix the code, not the test.` : ''}`;
}

/** Merges the session's "context" entries into the plan folder's CONTEXT.md (and context.json, its source). */
function writeContext(plan, rep) {
  const jf = path.join(planDir, 'context.json');
  const map = readJson(jf, {});
  let seq = Math.max(0, ...Object.values(map).map((v) => v.seq || 0));
  for (const c of rep.context || []) map[c.key] = { text: c.text, plan: plan.id, seq: ++seq };
  const keys = Object.keys(map).sort((a, b) => map[b].seq - map[a].seq).slice(0, CONTEXT_MAX);
  const kept = Object.fromEntries(keys.map((k) => [k, map[k]]));
  writeJsonAtomic(jf, kept);
  const handoff = fs.existsSync(path.join(planDir, 'HANDOFF.md')) ? fs.readFileSync(path.join(planDir, 'HANDOFF.md'), 'utf8') : '';
  const recent = handoff.split(/^(?=## Plan )/m).filter((s) => s.startsWith('## Plan ')).slice(-3).map((s) => s.trim().replace(/^## /, '### '));
  const lines = Object.keys(kept).sort().map((k) => `- **${k}** (plan ${kept[k].plan}): ${kept[k].text}`);
  fs.writeFileSync(path.join(planDir, 'CONTEXT.md'), `# Context\n\nWritten by the plan runner from each finished plan's report. Read it before you start, and reuse what is listed here instead of writing it again.\n\n## What exists (by area)\n\n${lines.length ? lines.join('\n') : '(nothing yet)'}\n\n## The last ${recent.length} finished plan(s)\n\n${recent.join('\n\n') || '(none yet)'}\n`);
}

function writeHandoff(plan, ps) {
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

// The commands the runner itself runs (gates, setup) use the normal environment plus the manifest's env.
// Secret-looking variables of the user's own shell (exchange, cloud, payment keys ...) are removed, so a project test
// can never use a real key; the manifest's "pass_env" names exceptions. Sessions get the same exceptions (lib/home.mjs
// removes the rest).
function gateEnv() { return { ...scrubSecrets(process.env, { keep: /^PLAN_RUNNER\w*$/, pass: ctx.manifest.pass_env || [] }), ...ctx.env, PLAN_RUNNER: '1' }; }
function passEnv() { return Object.fromEntries((ctx.manifest.pass_env || []).filter((k) => k in process.env).map((k) => [k, process.env[k]])); }

// ---------- report and status ----------
function writeReport(outcome) {
  try {
    const { st, manifest, repos } = ctx;
    const plans = manifest.plans.map((p) => [p, st.plans[p.id] || {}]);
    const L = [];
    const pr = progressOf(plans);
    L.push(`# Plan run report: ${slug}`, '', `Result: **${outcome}**`, `Started: ${st.created}`, st.finished ? `Finished: ${st.finished}` : '', `Session isolation: ${st.isolation || 'unknown'}${st.isolation === 'none' ? ' (the session itself was NOT restricted)' : ''}`,
      `Progress: ${pr.done} of ${plans.length} plans done. Running for ${fmtDuration(Date.now() - Date.parse(st.created))}.${pr.eta ? ` About ${fmtDuration(pr.eta)} of plan work left (the average so far).` : ''}`,
      st.haltReason ? `\nStopped because:\n\n\`\`\`\n${st.haltReason}\n\`\`\`` : '', '');
    if (st.bisect) L.push(`The last failed ${st.bisect.label} first failed after plan **${st.bisect.plan}** (searched plans ${st.bisect.candidates.join(', ')}).`, '');
    if ((st.archChanges || []).length) L.push(`ARCHITECTURE.md was changed during the run (${st.archChanges.join(', ')}). Plans finished before that were built on the old version.`, '');

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

    const reviews = plans.filter(([, s]) => s.review && s.review !== 'No findings.').map(([p, s]) => `### Plan ${p.id}\n\n${s.review}`);
    if (reviews.length) L.push('## Plan reviews (findings that did not block)', '', ...reviews, '');

    L.push('## Plans', '', '| id | file | status | time | failed tries | sessions | tool calls | refused |', '|---|---|---|---|---|---|---|---|');
    for (const [p, s] of plans) L.push(`| ${p.id}${p.repair ? ' (repair)' : ''} | ${p.file} | ${s.adopted ? 'done (earlier run)' : s.status || 'pending'} | ${planTime(s) ? fmtDuration(planTime(s)) : ''} | ${s.attempts ?? 0} | ${s.sessions ?? 0} | ${s.turns ?? 0} | ${s.refused ?? 0} |`);
    const fl = plans.flatMap(([p, s]) => (s.failures || []).map((f) => `- ${f.at} plan ${p.id}, ${stepName(f.step)}${f.try ? `, try ${f.try}` : ''}: ${f.reason}`));
    L.push('', '## Failed tries', '', fl.length ? `Full reasons: \`plans/<id>/failures.log\` in ${toPosix(runDir)}\n\n${fl.join('\n')}` : 'None.', '');
    const refused = plans.flatMap(([p, s]) => (s.refusedLog || []).map((x) => `- plan ${p.id}: ${x}`));
    L.push('## Refused by the guard', '', refused.length ? refused.slice(-40).join('\n') : 'Nothing was refused.', '');

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
    const again = `node ${toPosix(path.join(HERE, 'run.mjs'))} run ${slug}`;
    const how = {
      HALTED: `Fix the cause (the plan file, a check or the environment; not the code by hand), then run \`${again}\` again. It re-checks the kept steps and goes on from where it stopped. A failed full check, end-to-end check or final review is fixed with a repair plan (\`/plan-replan ${slug}\`). Discarded work is in \`${toPosix(path.join(runDir, 'plans'))}\` as .patch files.`,
      PAUSED: `Milestone review. Look at the app, read sections 1 to 3. If later plans rely on something done differently, run \`/plan-replan ${slug}\`. You may commit the work so far. Then run \`${again}\` to continue.`,
      RUNNING: 'The run is still going. This report is rewritten after every plan.',
    };
    L.push('## How to continue', '', how[outcome] || 'Read sections 1 to 3, review the diff in each repo, then commit it yourself.', '');
    const text = L.filter((x) => x !== undefined).join('\n');
    fs.writeFileSync(path.join(runDir, 'REPORT.md'), text);
    try { fs.writeFileSync(path.join(planDir, 'REPORT.md'), text); } catch { /* ignore */ }
  } catch (e) { log('System', `Could not write the report: ${e.message}`); }
}

function planTime(s) { return s.startedAt && s.finishedAt && !s.adopted ? Date.parse(s.finishedAt) - Date.parse(s.startedAt) : 0; }

/** Plans done and a rough time left from the average plan so far. (agy reports no cost.) */
function progressOf(plans) {
  const done = plans.filter(([, s]) => s.status === 'done').length;
  const times = plans.map(([, s]) => planTime(s)).filter(Boolean);
  const eta = times.length ? (times.reduce((a, b) => a + b, 0) / times.length) * (plans.length - done) : 0;
  return { done, eta };
}

function printStatus() {
  const st = loadState(runDir);
  if (!st) { console.log(`No run state for "${slug}" in ${runDir}`); return; }
  console.log(`Run "${slug}": ${st.status}, ${Object.values(st.plans).filter((p) => p.status === 'done').length} plan(s) done${st.haltReason ? `\n  reason: ${st.haltReason.split('\n')[0]}` : ''}`);
  for (const [id, p] of Object.entries(st.plans)) {
    const cps = loadCheckpoints(runDir, id);
    console.log(`  ${id}: ${p.status}  steps checkpointed=${lastOf(cps)} failed tries=${p.attempts ?? 0}${p.tryStep ? ` (${stepName(p.tryStep)}: ${p.tries ?? 0})` : ''} sessions=${p.sessions} tool calls=${p.turns} refused=${p.refused ?? 0}${p.lastFailure ? `\n      last failure: ${p.lastFailure.split('\n')[0]}` : ''}`);
  }
  console.log(`State folder: ${runDir}`);
}
