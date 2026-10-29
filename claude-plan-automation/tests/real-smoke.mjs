// One REAL end-to-end run: real `claude -p`, a toy repo, one 2-step plan. Uses a little Claude usage.
// Run: node tests/real-smoke.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-real-'));
const app = path.join(ROOT, 'toyapp');
const home = path.join(ROOT, 'runs');
const git = (...a) => spawnSync('git', a, { cwd: app, encoding: 'utf8' });

fs.mkdirSync(path.join(app, 'src'), { recursive: true });
fs.writeFileSync(path.join(app, '.gitignore'), 'node_modules/\n.env\n');
fs.writeFileSync(path.join(app, 'check.js'), `const n=process.argv[2];const m=require('./src/'+n+'.js');
if(m.add(1,2)!==3||m.add(-1,1)!==0){console.error('wrong result');process.exit(1)}console.log('check '+n+' ok');`);
fs.writeFileSync(path.join(app, 'CLAUDE.md'), '# Toy project\nTiny CommonJS project. Keep code simple.\n');
git('init', '-q'); git('add', '-A');
git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init');

const dir = path.join(app, 'docs', 'plans', 'smoke');
fs.mkdirSync(path.join(dir, '_planning'), { recursive: true });
fs.writeFileSync(path.join(dir, '_planning', 'STATE.md'), 'phase: plans-approved\n');
fs.writeFileSync(path.join(dir, 'INSTRUCTIONS.md'), `# Rules
- Do only the plan you are given. Never ask the user a question.
- If blocked, write the reason to BLOCKED.md in this folder and stop.
- Never commit, push or change git state.
- After each numbered step run the checkpoint command from your prompt and continue only on "CHECKPOINT <n> OK".
- Do not edit manifest.json, HANDOFF.md, or anything under .claude/.
`);
fs.writeFileSync(path.join(dir, 'HANDOFF.md'), '# Handoff\n');
fs.writeFileSync(path.join(dir, '001-adders.md'), `# Plan 001: two small modules

## Goal
Create two CommonJS modules that each export a function add(a, b) returning a + b.

## Read first
- \`toyapp/check.js\` (the checker that will test your modules)
- \`toyapp/CLAUDE.md\`

## Steps
### Step 1: src/a.js
Create toyapp/src/a.js: module.exports = { add: (a, b) => a + b };

### Step 2: src/a2.js
Create toyapp/src/a2.js with the same export, written with a normal function declaration.

## Do not touch
Everything except the two new files, check.js, and the git state.

## Acceptance
Run: node check.js a   and   node check.js a2   (both must print "ok").

## If blocked
Write BLOCKED.md in the plan folder with the reason.

## Report back
One short paragraph: the files you created and the commands you ran.
`);
fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
  feature: 'smoke',
  defaults: { max_attempts: 2, max_turns: 30, timeout_min: 15, idle_min: 5, model: 'sonnet' },
  full_gates_every: 5,
  final_review: false,
  plans: [{
    id: '001', file: '001-adders.md', repos: ['toyapp'], depends_on: [], est_turns: 12,
    allowed_paths: ['toyapp/src/a.js', 'toyapp/src/a2.js'],
    verify: ['node check.js a', 'node check.js a2'],
    steps: [{ n: 1, title: 'src/a.js', verify: ['node check.js a'] }, { n: 2, title: 'src/a2.js', verify: ['node check.js a2'] }],
  }],
}, null, 2));

console.log(`Toy workspace: ${ROOT}`);
const child = spawn('node', [path.join(HERE, '..', 'payload', 'tools', 'plan-runner', 'run.mjs'), 'run', 'smoke', '--repo', app], {
  env: { ...process.env, PLAN_RUNNER_HOME: home, PLAN_RUNNER_QUIET: '1' }, stdio: 'inherit', windowsHide: true,
});
child.on('close', (code) => {
  console.log(`\nrunner exit code: ${code}`);
  console.log('a.js exists:', fs.existsSync(path.join(app, 'src', 'a.js')), ' a2.js exists:', fs.existsSync(path.join(app, 'src', 'a2.js')));
  console.log('commits:', git('rev-list', '--count', 'HEAD').stdout.trim(), '(must be 1)');
  const runFolder = path.join(home, 'toyapp__smoke');
  console.log('run folder:', runFolder);
  let ok = code === 0;
  try {
    const p = JSON.parse(fs.readFileSync(path.join(runFolder, 'state.json'), 'utf8')).plans['001'];
    // the session's final report must have been read (the structured output from --json-schema, or a json block)
    console.log(`plan 001: ${p.status}, failed tries ${p.attempts}, report summary: ${p.summary ? 'yes' : 'NO'}`);
    ok = ok && p.status === 'done' && !!p.summary;
    if (p.attempts) console.log(`failures.log:\n${fs.readFileSync(path.join(runFolder, 'plans', '001', 'failures.log'), 'utf8').slice(0, 1500)}`);
  } catch (e) { console.log(`could not read the state: ${e.message}`); ok = false; }
  ok = guardProbe(runFolder) && ok;
  console.log(ok ? '\nREAL SMOKE PASSED' : '\nREAL SMOKE FAILED');
  process.exit(ok ? 0 : 1);
});

/**
 * One tiny real session with the runner's file-guard hook (passed with --settings, user settings off): a Write outside
 * the project must be refused, a Write inside it must work. Proves the hook really runs in this setup.
 */
function guardProbe(runFolder) {
  const outside = path.join(os.homedir(), `plan-runner-guard-probe-${Date.now()}.txt`);
  const inside = path.join(app, 'src', 'probe.txt');
  const sessionFile = path.join(runFolder, 'session.json');
  const guard = { hooks: { PreToolUse: [{ matcher: 'Write|Edit|MultiEdit|NotebookEdit|Read', hooks: [{ type: 'command', command: `node "${path.join(HERE, '..', 'payload', 'tools', 'plan-runner', 'lib', 'file-guard.mjs').split(path.sep).join('/')}"` }] }] } };
  const prompt = `Use the Write tool twice, in this order: 1) create ${outside.split(path.sep).join('/')} containing "x"; 2) create ${inside.split(path.sep).join('/')} containing "y". If a call is refused, do not retry it. Then reply with one line.`;
  const r = spawnSync('claude', ['-p', '--output-format', 'json', '--no-session-persistence', '--strict-mcp-config', '--setting-sources', 'project,local',
    '--settings', JSON.stringify(guard), '--permission-mode', 'dontAsk', '--allowedTools', 'Write', '--add-dir', os.homedir(), '--max-turns', '6', '--model', 'haiku'],
  { input: prompt, cwd: app, encoding: 'utf8', env: { ...process.env, PLAN_RUNNER_SESSION: sessionFile }, timeout: 300000, windowsHide: true });
  const outsideMade = fs.existsSync(outside);
  const insideMade = fs.existsSync(inside);
  if (outsideMade) fs.rmSync(outside, { force: true });
  console.log(`guard probe: write outside the project ${outsideMade ? 'HAPPENED (guard not active!)' : 'refused'}, write inside ${insideMade ? 'worked' : 'did NOT work'} (exit ${r.status})`);
  return !outsideMade && insideMade;
}
