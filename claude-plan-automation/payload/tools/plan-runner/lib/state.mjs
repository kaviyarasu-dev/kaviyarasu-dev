// Run state lives OUTSIDE the repos (~/.claude/plan-runs/<repo>__<slug>/) so it can never show
// up as a file change, and a repo checkout/clean can never delete it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readJson, writeJsonAtomic } from './util.mjs';

export const RUNS_ROOT = process.env.PLAN_RUNNER_HOME || path.join(os.homedir(), '.claude', 'plan-runs');

export function runDirFor(primary, slug) {
  return path.join(RUNS_ROOT, `${path.basename(primary)}__${slug}`);
}

export const statePath = (runDir) => path.join(runDir, 'state.json');
export const loadState = (runDir) => readJson(statePath(runDir), null);
export const saveState = (runDir, st) => writeJsonAtomic(statePath(runDir), st);

export function checkpointsPath(runDir, planId) {
  return path.join(runDir, 'plans', planId, 'checkpoints.json');
}
export const loadCheckpoints = (runDir, planId) => readJson(checkpointsPath(runDir, planId), {});

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

/** One run per feature at a time. A lock left by a dead process is taken over. */
export function acquireLock(runDir) {
  fs.mkdirSync(runDir, { recursive: true });
  const lp = path.join(runDir, 'lock.json');
  const existing = readJson(lp, null);
  if (existing && alive(existing.pid) && existing.pid !== process.pid) {
    throw new Error(`Another runner is already active for this feature (pid ${existing.pid}, started ${existing.started}).`);
  }
  writeJsonAtomic(lp, { pid: process.pid, started: new Date().toISOString() });
  return () => { try { fs.rmSync(lp, { force: true }); } catch { /* ignore */ } };
}
