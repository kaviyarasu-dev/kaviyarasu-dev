// REAL end-to-end run: the actual runner and the actual agy on a tiny toy plan (one plan, one step, no final review).
// This spends Antigravity quota (one session, more if the model needs a retry). Run by hand: node tests/real-run.mjs
// It builds the toy repo under the temp folder, so no real project is touched.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUN = path.join(HERE, '..', 'payload', 'tools', 'plan-runner', 'run.mjs');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-real-run-'));
const repo = path.join(root, 'toyapp');
const dir = path.join(repo, 'docs', 'plans', 'feat');
const git = (...a) => spawnSync('git', a, { cwd: repo, encoding: 'utf8' });

fs.mkdirSync(path.join(dir, '_planning'), { recursive: true });
fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules/\n.env\n');
fs.writeFileSync(path.join(repo, 'check.js'), "const m=require('./src/a.js');if(m.add(1,2)!==3){console.error('wrong');process.exit(1)}\n");
fs.writeFileSync(path.join(repo, 'src', 'index.js'), 'module.exports={};\n');
git('init', '-q'); git('add', '-A'); git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init');

fs.writeFileSync(path.join(dir, '_planning', 'STATE.md'), 'phase: plans-approved\n');
fs.writeFileSync(path.join(dir, 'INSTRUCTIONS.md'), fs.readFileSync(path.join(HERE, '..', 'INSTRUCTIONS.md'), 'utf8'));
fs.writeFileSync(path.join(dir, 'HANDOFF.md'), '# Handoff\n');
fs.writeFileSync(path.join(dir, '001-add.md'), `# Plan 001: add a.js

## Goal
Create toyapp/src/a.js that exports a function add(a, b) returning a + b (CommonJS: exports.add = ...).

## Read first
- \`toyapp/src/index.js\`

## Steps
### Step 1: create a.js
Create toyapp/src/a.js with: exports.add = (a, b) => a + b;

## Do not touch
Every other file.

## Acceptance
Run: node check.js (in the toyapp folder). It must exit 0.

## If blocked
Write BLOCKED.md.

## Report back
One sentence: what you created.
`);
fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
  feature: 'feat',
  defaults: { max_attempts: 2, max_turns: 20, timeout_min: 15, idle_min: 8 },
  final_review: false,
  plans: [{
    id: '001', file: '001-add.md', repos: ['toyapp'], depends_on: [], est_turns: 8, allowed_paths: ['toyapp/src/a.js'],
    verify: ['node check.js', 'node "{{runner}}/assert.mjs" has src/a.js "exports\\.add"'],
    steps: [{ n: 1, title: 'create a.js', verify: ['node "{{runner}}/assert.mjs" exists src/a.js'] }],
  }],
}, null, 2));

console.log(`Toy workspace: ${root}\nRunning the real runner with the real agy ...\n`);
const child = spawn(process.execPath, [RUN, 'run', 'feat', '--repo', repo], {
  env: { ...process.env, PLAN_RUNNER_HOME: path.join(root, 'runs'), PLAN_RUNNER_QUIET: '1' }, stdio: 'inherit', windowsHide: true,
});
child.on('close', (code) => {
  const a = path.join(repo, 'src', 'a.js');
  console.log(`\nrunner exit code: ${code}`);
  console.log(`src/a.js exists: ${fs.existsSync(a)}${fs.existsSync(a) ? ` -> ${fs.readFileSync(a, 'utf8').trim()}` : ''}`);
  console.log(`commits in the toy repo: ${git('rev-list', '--count', 'HEAD').stdout.trim()} (must stay 1)`);
  console.log(`report: ${path.join(root, 'runs', 'toyapp__feat', 'REPORT.md')}`);
  process.exit(code);
});
