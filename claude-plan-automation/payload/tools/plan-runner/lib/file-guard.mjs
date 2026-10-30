// PreToolUse hook for unattended Claude sessions (passed with --settings, so the user's own settings are not needed).
// Claude's deny rules cannot say "everything in .claude/ except rules/" or ".env.* but not .env.example", and they
// cannot say "nothing outside the project". This hook can. It reads the tool call as JSON on stdin and the run's
// session file (PLAN_RUNNER_SESSION, written by run.mjs) for the project repos.
//   Write/Edit/MultiEdit/NotebookEdit: refused outside the project repos (the temp folder is allowed), on blocked files
//   and on files a finished plan froze (its tests and test config).
//   Read: refused on secret files.
// A refusal is exit code 2 with the reason on stderr; Claude shows that reason to the session.
// Fail closed: if anything goes wrong, the call is refused.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { blockedReason, ENV_EXAMPLES, frozenBy } from './gates.mjs';
import { matchesAny } from './util.mjs';

const WRITE = /^(?:Write|Edit|MultiEdit|NotebookEdit)$/;
const SECRET = ['**/.env', '**/.env.*', '**/*.pem', '**/*.key', '**/.ssh/**', '**/.aws/**', '**/.npmrc', '**/.netrc'];

const refuse = (why) => {
  process.stderr.write(`Refused by the plan runner: ${why}. This does NOT mean your tools are off. Do it another way if the plan allows it; if the plan cannot be done without it, list it under "not_done" in your final report (or write BLOCKED.md).`);
  process.exit(2);
};

const norm = (p) => path.resolve(p).split(path.sep).join('/');
const inside = (file, dir) => {
  const f = norm(file).toLowerCase();
  const d = norm(dir).toLowerCase().replace(/\/$/, '');
  return f === d || f.startsWith(`${d}/`);
};

/** { decision: 'allow' } or { decision: 'deny', reason }. Exported for the offline tests. */
export function decideFile(call, S) {
  const tool = String(call?.tool_name || '');
  const input = call?.tool_input || {};
  const raw = input.file_path || input.notebook_path;
  if (!raw) return { decision: 'allow' };
  const abs = path.isAbsolute(raw) ? raw : path.resolve(call?.cwd || process.cwd(), raw);
  const shown = norm(abs);
  if (tool === 'Read') {
    if (matchesAny(SECRET, shown.toLowerCase()) && !matchesAny(ENV_EXAMPLES, shown.toLowerCase())) return { decision: 'deny', reason: `${shown} is a secret file` };
    return { decision: 'allow' };
  }
  if (!WRITE.test(tool)) return { decision: 'allow' };
  const repo = Object.entries(S.repos).find(([, dir]) => inside(abs, dir));
  if (!repo) {
    if (inside(abs, os.tmpdir())) return { decision: 'allow' };
    return { decision: 'deny', reason: `${shown} is outside the project folders (${Object.values(S.repos).map(norm).join(', ')}); only files inside them may be changed` };
  }
  const rel = `${repo[0]}/${path.relative(repo[1], abs).split(path.sep).join('/')}`;
  const why = blockedReason(rel, { planDirRel: S.planDirRel, primaryName: S.primaryName });
  if (why) return { decision: 'deny', reason: `${rel}: ${why}` };
  const by = frozenBy(rel, S.frozen || [], S.unfreeze || []);
  return by ? { decision: 'deny', reason: `${rel} is frozen by plan ${by} (a finished plan's tests and test config may not change)` } : { decision: 'allow' };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    let raw = '';
    for await (const chunk of process.stdin) raw += chunk;
    const S = JSON.parse(fs.readFileSync(process.env.PLAN_RUNNER_SESSION, 'utf8'));
    const v = decideFile(JSON.parse(raw), S);
    if (v.decision === 'deny') refuse(v.reason);
    process.exit(0);
  } catch (e) {
    refuse(`its safety check could not run (${String(e.message).slice(0, 120)})`);
  }
}
