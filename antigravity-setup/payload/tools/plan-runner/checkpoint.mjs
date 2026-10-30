#!/usr/bin/env node
// Called BY the plan session after it finishes each numbered step:
//   node checkpoint.mjs <step number>
// It runs that step's own verify commands and the blocked-file check. Only if both pass does it record
// a snapshot (no commit). A failed attempt later rolls back to the last checkpoint, not to the
// start of the plan. It prints "CHECKPOINT n OK" or the reason it refused.
import path from 'node:path';
import { snapshot } from './lib/git.mjs';
import { changedPaths, runList, scopeCheck } from './lib/gates.mjs';
import { readJson, writeJsonAtomic } from './lib/util.mjs';

const sessionFile = process.env.PLAN_RUNNER_SESSION;
const n = Number(process.argv[2]);
if (!sessionFile) { console.log('CHECKPOINT REFUSED: not running under the plan runner (PLAN_RUNNER_SESSION is not set).'); process.exit(1); }
const S = readJson(sessionFile);
const step = S.steps.find((s) => s.n === n);
if (!step && n === S.steps.length + 1) { console.log(`CHECKPOINT REFUSED: there is no step ${n}. All ${S.steps.length} steps are already checkpointed; do not run the checkpoint again. Do the Acceptance section and give your final report.`); process.exit(1); }
if (!step) { console.log(`CHECKPOINT REFUSED: there is no step ${n}. Steps are 1..${S.steps.length}.`); process.exit(1); }

const cps = readJson(S.checkpointsPath, {});
const done = Object.keys(cps).map(Number);
const last = done.length ? Math.max(...done) : S.resumeFrom - 1;
if (n !== last + 1) { console.log(`CHECKPOINT REFUSED: the next step to check is ${last + 1}, not ${n}.`); process.exit(1); }

const idx = (name) => path.join(S.runDir, 'index', name);
const cur = {};
for (const [name, dir] of Object.entries(S.repos)) cur[name] = snapshot(dir, idx(name));

const changed = changedPaths(S.repos, S.startTrees, cur);
const sc = scopeCheck({ changed, allowed: S.allowed, extra: S.extra, planDirRel: S.planDirRel, primaryName: S.primaryName, frozen: S.frozen || [], unfreeze: S.unfreeze || [] });
if (!sc.ok) {
  console.log(`CHECKPOINT REFUSED: blocked files were changed (git, secrets, agent settings, the plan folder or a frozen test):\n${sc.violations.join('\n')}\nRevert those changes, then run the checkpoint again.`);
  process.exit(1);
}

if (!(step.verify || []).length) { console.log(`CHECKPOINT REFUSED: step ${n} has no check in the manifest, so it cannot be proven. Write BLOCKED.md: the plan must be fixed.`); process.exit(1); }
const r = await runList(step.verify, { repos: S.repos, defaultRepo: S.defaultRepo, env: { ...process.env, ...S.env }, changed, label: `step ${n} verify` });
if (!r.ok) {
  console.log(`CHECKPOINT REFUSED: step ${n} verify failed.\n${r.failure}\nFix the problem, then run the checkpoint again.`);
  process.exit(1);
}

cps[n] = { trees: cur, at: new Date().toISOString() };
writeJsonAtomic(S.checkpointsPath, cps);
console.log(`CHECKPOINT ${n} OK (steps 1-${n} verified).${n < S.steps.length ? ` Continue with step ${n + 1}.` : ' All steps done. Now do the Acceptance section and give your final report.'}`);
