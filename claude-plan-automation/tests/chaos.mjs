// Chaos tests: the runner against a fake claude that lies, hangs, crashes and trips limits.
// Uses no Claude usage. Run: node tests/chaos.mjs [name-filter]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateFolder } from '../payload/tools/plan-runner/validate.mjs';
import { decideFile } from '../payload/tools/plan-runner/lib/file-guard.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUNNER = path.join(HERE, '..', 'payload', 'tools', 'plan-runner');
const RUN = path.join(RUNNER, 'run.mjs');
const ASSERT = path.join(RUNNER, 'assert.mjs');
const FAKE = path.join(HERE, 'fake-claude.mjs');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-chaos-'));
const filter = process.argv[2];

const results = [];
const sh = (cwd, args) => spawnSync('git', args, { cwd, encoding: 'utf8' });
const GOOD = 'exports.add=(a,b)=>a+b;';
const CHECK = `const n=process.argv[2];let m;try{m=require('./src/'+n+'.js')}catch(e){console.error('missing '+n);process.exit(1)}
if(m.add(1,2)!==3){console.error('wrong');process.exit(1)}`;

function mkRepo(dir, extra = {}) {
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\n.env\n');
  fs.writeFileSync(path.join(dir, 'check.js'), CHECK);
  fs.writeFileSync(path.join(dir, 'src', 'index.js'), 'module.exports={};');
  for (const [k, v] of Object.entries(extra)) fs.writeFileSync(path.join(dir, k), v);
  sh(dir, ['init', '-q']);
  sh(dir, ['add', '-A']);
  sh(dir, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init']);
}

function planMd(id, steps) {
  const st = steps.map((s) => `### Step ${s.n}: ${s.title}\nDo it.\n`).join('\n');
  return `# Plan ${id}\n\n## Goal\nGoal.\n\n## Read first\n- \`toyapp/src/index.js\`\n\n## Steps\n${st}\n## Do not touch\nNothing else.\n\n## Acceptance\nRun the verify.\n\n## If blocked\nWrite BLOCKED.md.\n\n## Report back\nSay what you did.\n`;
}

/** Build a toy workspace. opts.plans overrides the default three plans. */
function build(name, opts = {}) {
  const ws = path.join(ROOT, name);
  const app = path.join(ws, 'toyapp');
  const api = path.join(ws, 'toyapi');
  mkRepo(app, { '.env': 'DB_NAME=real_db\n' });
  mkRepo(api);
  if (opts.otherRepo) mkRepo(path.join(ws, 'otherrepo'));
  const dir = path.join(app, 'docs', 'plans', 'feat');
  fs.mkdirSync(path.join(dir, '_planning'), { recursive: true });
  fs.writeFileSync(path.join(dir, '_planning', 'STATE.md'), 'phase: plans-approved\n');
  fs.writeFileSync(path.join(dir, 'INSTRUCTIONS.md'), 'Rules.\n');
  fs.writeFileSync(path.join(dir, 'HANDOFF.md'), '# Handoff\n');
  const two = opts.twoSteps;
  const steps1 = two ? [{ n: 1, title: 'a', verify: ['node check.js a'] }, { n: 2, title: 'a2', verify: ['node check.js a2'] }] : [{ n: 1, title: 'a', verify: ['node check.js a'] }];
  const plans = opts.plans || [
    { id: '001', file: '001-a.md', repos: ['toyapp'], depends_on: [], allowed_paths: two ? ['toyapp/src/a.js', 'toyapp/src/a2.js'] : ['toyapp/src/a.js'], verify: two ? ['node check.js a', 'node check.js a2'] : ['node check.js a'], est_turns: opts.est1 ?? 10, steps: steps1 },
    { id: '002', file: '002-b.md', repos: ['toyapi'], depends_on: [], allowed_paths: ['toyapi/src/b.js'], verify: ['node check.js b'], est_turns: 10, steps: [{ n: 1, title: 'b', verify: ['node check.js b'] }] },
    { id: '003', file: '003-c.md', repos: ['toyapp'], depends_on: ['001'], allowed_paths: ['toyapp/src/c.js'], verify: ['node check.js c'], est_turns: 10, steps: [{ n: 1, title: 'c', verify: ['node check.js c'] }] },
  ];
  const manifest = { feature: 'feat', defaults: { max_attempts: 3, max_turns: 60, timeout_min: 3, idle_min: 1, ...(opts.defaults || {}) }, full_gates_every: opts.every ?? 5, ...(opts.manifest || {}), plans };
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  for (const p of plans) fs.writeFileSync(path.join(dir, p.file), planMd(p.id, p.steps || []));
  const files = {
    '001': { modes: ['ok'], files: two ? [['toyapp/src/a.js', GOOD], ['toyapp/src/a2.js', GOOD]] : [['toyapp/src/a.js', GOOD]] },
    '002': { modes: ['ok'], files: [['toyapi/src/b.js', GOOD]] },
    '003': { modes: ['ok'], files: [['toyapp/src/c.js', GOOD]] },
  };
  const cfg = path.join(ws, 'fake.json');
  const merged = { ...files };
  for (const [k, v] of Object.entries(opts.cfg || {})) merged[k] = { ...files[k], ...v };
  fs.writeFileSync(cfg, JSON.stringify(merged));
  return { ws, app, api, dir, cfg, home: path.join(ws, 'runs'), runDir: path.join(ws, 'runs', 'toyapp__feat') };
}

const envFor = (w) => ({ ...process.env, PLAN_RUNNER_CLAUDE_CMD: JSON.stringify(['node', FAKE]), FAKE_CFG: w.cfg, PLAN_RUNNER_HOME: w.home, PLAN_RUNNER_QUIET: '1', PLAN_RUNNER_FAST: '1' });
function runRunner(w, extra = []) {
  return new Promise((resolve) => {
    const child = spawn('node', [RUN, 'run', 'feat', '--repo', w.app, ...extra], { env: envFor(w), windowsHide: true });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    const to = setTimeout(() => { spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F']); }, 900000);
    child.on('close', (code) => { clearTimeout(to); resolve({ code, out }); });
  });
}
const state = (w) => JSON.parse(fs.readFileSync(path.join(w.runDir, 'state.json'), 'utf8'));
const has = (p) => fs.existsSync(p);
const commits = (repo) => Number(sh(repo, ['rev-list', '--count', 'HEAD']).stdout.trim());
const dirty = (repo) => sh(repo, ['status', '--porcelain', '--untracked-files=all', '--', '.', ':!docs/plans']).stdout.trim();

const queue = [];
async function t(name, fn) {
  if (filter && !name.includes(filter)) return;
  queue.push(() => runOne(name, fn));
}
async function runOne(name, fn) {
  const fails = [];
  const check = (cond, msg) => { if (!cond) fails.push(msg); };
  try { await fn(check); } catch (e) { fails.push(`threw: ${e.stack || e.message}`); }
  results.push({ name, fails });
  console.log(`${fails.length ? 'FAIL' : 'PASS'}  ${name}${fails.length ? `\n      - ${fails.join('\n      - ')}` : ''}`);
}

await t('01 happy path: 3 plans done, nothing committed, logs look right', async (c) => {
  const w = build('happy');
  const r = await runRunner(w);
  c(r.code === 0, `exit ${r.code}\n${r.out.slice(-1500)}`);
  const s = state(w);
  c(s.status === 'complete', `status ${s.status}`);
  c(['001', '002', '003'].every((id) => s.plans[id]?.status === 'done'), 'not all plans done');
  c(has(path.join(w.app, 'src', 'a.js')) && has(path.join(w.api, 'src', 'b.js')) && has(path.join(w.app, 'src', 'c.js')), 'work files missing');
  c(commits(w.app) === 1 && commits(w.api) === 1, 'the runner committed something');
  c((fs.readFileSync(path.join(w.dir, 'HANDOFF.md'), 'utf8').match(/## Plan 00/g) || []).length === 3, 'HANDOFF.md has no 3 sections');
  c(has(path.join(w.runDir, 'REPORT.md')), 'REPORT.md missing');
  c(/^\[\d{1,2}:\d{2}:\d{2}/m.test(r.out), 'no local timestamps in output');
  c(r.out.includes('[System] Starting claude for 001-a.md...'), 'missing "Starting claude for" line');
  c(/-> Progress: Write/.test(r.out), 'missing live progress line');
  c(r.out.includes('[CLI Internal] fake claude'), 'stderr not forwarded as [CLI Internal]');
  const args = fs.readFileSync(`${w.cfg}.args.log`, 'utf8');
  c(args.includes('dontAsk') && args.includes('--strict-mcp-config') && args.includes('project,local'), 'permission/isolation flags missing');
});

await t('02 lying session (says done, did nothing): halts, later plans never start', async (c) => {
  const w = build('lie', { cfg: { '001': { modes: ['lie'] } } });
  const r = await runRunner(w);
  c(r.code === 1, `exit ${r.code}`);
  const s = state(w);
  c(s.status === 'halted' && s.plans['001'].status === 'failed', 'plan 001 should be failed and run halted');
  c(!s.plans['002'] && !s.plans['003'], 'a later plan started');
  c(s.plans['001'].attempts === 3, `attempts ${s.plans['001'].attempts}`);
});

await t('03 blocked file (.claude/settings.json) edited: caught, rolled back, saved as patch', async (c) => {
  const w = build('scope', { cfg: { '001': { modes: ['scope'] } } });
  const r = await runRunner(w);
  c(r.code === 1, `exit ${r.code}`);
  c(!has(path.join(w.app, '.claude', 'settings.json')), 'blocked file was not rolled back');
  c(fs.readdirSync(path.join(w.runDir, 'plans', '001')).some((f) => f.endsWith('.patch')), 'no patch file saved');
  c(r.out.includes('SCOPE GATE'), 'scope gate did not report');
});

await t('04 hang: idle watchdog kills it, second attempt succeeds', async (c) => {
  const w = build('hang', { cfg: { '001': { modes: ['hang', 'ok'] } }, defaults: { idle_min: 0.25 } });
  const r = await runRunner(w);
  c(r.code === 0, `exit ${r.code}\n${r.out.slice(-800)}`);
  c(/idle for/.test(r.out), 'watchdog did not fire');
  c(state(w).plans['001'].attempts === 1, `attempts ${state(w).plans['001'].attempts}`);
});

await t('05 crash x3: halts at plan 001', async (c) => {
  const w = build('crash', { cfg: { '001': { modes: ['crash'] } } });
  const r = await runRunner(w);
  c(r.code === 1 && state(w).plans['001'].status === 'failed', 'should fail');
  c(!state(w).plans['002'], 'plan 002 started');
});

await t('06 garbage lines in the stream are ignored', async (c) => {
  const w = build('badjson', { cfg: { '001': { modes: ['badjson'] } } });
  const r = await runRunner(w);
  c(r.code === 0, `exit ${r.code}\n${r.out.slice(-600)}`);
  c(r.out.includes('non-JSON stdout'), 'garbage was not reported');
});

await t('07 usage limit: waits, retries, no attempt used', async (c) => {
  const w = build('limit', { cfg: { '001': { modes: ['limit', 'ok'] } } });
  const r = await runRunner(w);
  c(r.code === 0, `exit ${r.code}\n${r.out.slice(-800)}`);
  c(/Usage limit reached\. Waiting/.test(r.out), 'did not wait');
  c(state(w).plans['001'].attempts === 0, `attempts ${state(w).plans['001'].attempts}`);
});

await t('08 BLOCKED.md: halts, plan marked blocked, tree restored', async (c) => {
  const w = build('blocked', { cfg: { '001': { modes: ['blocked'] } } });
  const r = await runRunner(w);
  c(r.code === 1 && state(w).plans['001'].status === 'blocked', `exit ${r.code} status ${state(w).plans['001']?.status}`);
  c(!has(path.join(w.dir, 'BLOCKED.md')), 'BLOCKED.md left in plan folder');
  c(r.out.includes('spec contradicts itself'), 'reason not shown');
});

await t('09 turn overrun: stopped at green checkpoint, continued fresh', async (c) => {
  const w = build('overrun', { twoSteps: true, est1: 2, cfg: { '001': { modes: ['overrun', 'ok'] } } });
  const r = await runRunner(w);
  c(r.code === 0, `exit ${r.code}\n${r.out.slice(-900)}`);
  const p = state(w).plans['001'];
  c(p.continuations === 1 && p.attempts === 0, `continuations ${p.continuations} attempts ${p.attempts}`);
  c(has(path.join(w.app, 'src', 'a2.js')), 'step 2 never ran');
});

await t('10 crash after step 1: resumes at step 2; the crash counts as a try of step 2, not of step 1', async (c) => {
  const w = build('progress', { twoSteps: true, cfg: { '001': { modes: ['crash_after_step1', 'ok'] } } });
  const r = await runRunner(w);
  c(r.code === 0, `exit ${r.code}\n${r.out.slice(-900)}`);
  c(state(w).plans['001'].attempts === 1, `attempts ${state(w).plans['001'].attempts}`);
  c(/step 2: try 1 of 3 failed/.test(r.out), 'the failed try was not charged to step 2');
  c(/resuming after step 1/.test(r.out), 'second session did not resume after step 1');
});

await t('11 dirty tree at start: refuses, spawns nothing', async (c) => {
  const w = build('dirty');
  fs.writeFileSync(path.join(w.app, 'src', 'index.js'), 'changed');
  const r = await runRunner(w);
  c(r.code === 2 && r.out.includes('uncommitted changes'), `exit ${r.code}`);
  c(!has(`${w.cfg}.args.log`), 'claude was started');
});

await t('12 isolation guard: test DB name equals the real one -> refuses', async (c) => {
  const w = build('isolate', { manifest: { env: { DB_NAME: 'real_db' }, isolate: ['DB_NAME'] } });
  const r = await runRunner(w);
  c(r.code === 2 && r.out.includes('REAL value'), `exit ${r.code}\n${r.out.slice(-400)}`);
});

await t('13 resume after halt: finished plans are not re-run', async (c) => {
  const w = build('resume', { cfg: { '002': { modes: ['lie'] } } });
  const r1 = await runRunner(w);
  c(r1.code === 1 && state(w).plans['001'].status === 'done', 'first run should halt after 001');
  const cfg = JSON.parse(fs.readFileSync(w.cfg, 'utf8'));
  cfg['002'].modes = ['ok'];
  fs.writeFileSync(w.cfg, JSON.stringify(cfg));
  const r2 = await runRunner(w);
  c(r2.code === 0, `second run exit ${r2.code}\n${r2.out.slice(-800)}`);
  c(fs.readFileSync(`${w.cfg}.cnt.001`, 'utf8') === '1', '001 was run again');
  c(state(w).status === 'complete', 'not complete');
});

await t('14 second runner while one is active: refuses', async (c) => {
  const w = build('lock');
  fs.mkdirSync(w.runDir, { recursive: true });
  fs.writeFileSync(path.join(w.runDir, 'lock.json'), JSON.stringify({ pid: process.pid, started: 'now' }));
  const r = await runRunner(w);
  c(r.code === 2 && r.out.includes('already active'), `exit ${r.code}\n${r.out.slice(-300)}`);
});

await t('15 runner killed mid-plan: next start rolls back and finishes', async (c) => {
  const w = build('killed', { cfg: { '001': { modes: ['hang', 'ok'] } }, defaults: { idle_min: 5 } });
  const child = spawn('node', [RUN, 'run', 'feat', '--repo', w.app], { env: envFor(w), stdio: 'ignore', windowsHide: true });
  const t0 = Date.now();
  while (!has(`${w.cfg}.cnt.001`) && Date.now() - t0 < 30000) await new Promise((r) => setTimeout(r, 200));
  await new Promise((r) => setTimeout(r, 1500));
  spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F']);
  await new Promise((r) => setTimeout(r, 500));
  c(state(w).plans['001'].status === 'running', `state after kill: ${state(w).plans['001']?.status}`);
  const r = await runRunner(w);
  c(r.code === 0, `exit ${r.code}\n${r.out.slice(-800)}`);
  c(/was interrupted/.test(r.out), 'recovery not announced');
});

await t('16 file edited by someone between runs: refuses to resume', async (c) => {
  const w = build('tamper', { cfg: { '002': { modes: ['lie'] } } });
  await runRunner(w);
  fs.writeFileSync(path.join(w.app, 'src', 'tamper.js'), 'x');
  const r = await runRunner(w);
  c(r.code === 2 && r.out.includes('Files changed'), `exit ${r.code}\n${r.out.slice(-300)}`);
});

await t('17 deleted tracked file + junk, then failure: restored exactly', async (c) => {
  const w = build('delete', { cfg: { '001': { modes: ['delete'] } } });
  await runRunner(w);
  c(has(path.join(w.app, 'src', 'index.js')), 'deleted file not restored');
  c(!has(path.join(w.app, 'src', 'junk.js')), 'junk file left behind');
  c(dirty(w.app) === '', `tree not clean: ${dirty(w.app)}`);
});

await t('18 session asks a question instead of working: fails the gates', async (c) => {
  const w = build('question', { cfg: { '001': { modes: ['question'] } } });
  const r = await runRunner(w);
  c(r.code === 1 && state(w).plans['001'].status === 'failed', `exit ${r.code}`);
});

await t('19 error_max_turns is a failed attempt, never success', async (c) => {
  const w = build('maxturns', { cfg: { '001': { modes: ['maxturns'] } } });
  const r = await runRunner(w);
  c(r.code === 1 && /error_max_turns/.test(r.out), `exit ${r.code}`);
});

await t('20 full check failing halts the run even though plans pass', async (c) => {
  const w = build('sweep', { every: 1, manifest: { full_gates: ['node -e "process.exit(1)"'] } });
  const r = await runRunner(w);
  c(r.code === 1 && state(w).status === 'halted', `exit ${r.code}`);
  c(!state(w).plans['002'], 'plan 002 started after a failed full check');
});

await t('21 validator catches bad manifests', async (c) => {
  const w = build('validate', { plans: [
    { id: '001', file: '001-a.md', repos: ['toyapp'], depends_on: ['002'], allowed_paths: ['toyapp/src/a.js'], verify: [], est_turns: 10, gate: 'manual', steps: [{ n: 1, title: 'a' }] },
    { id: '002', file: 'missing.md', repos: ['toyapp'], depends_on: [], allowed_paths: ['toyapp/src/x.js'], verify: ['node nothing_test.php'], est_turns: 99, steps: [{ n: 2, title: 'x' }] },
    { id: '003', file: '003-c.md', repos: ['toyapp'], depends_on: [], allowed_paths: ['**'], verify: ['node check.js a'], est_turns: 5, steps: [{ n: 1, title: 'c' }] },
  ] });
  fs.rmSync(path.join(w.dir, 'missing.md'), { force: true });
  fs.writeFileSync(path.join(w.dir, '001-a.md'), planMd('001', [{ n: 1, title: 'a' }]));
  const { errors } = validateFolder(w.dir, { workspace: w.ws });
  const text = errors.join('\n');
  for (const needle of ['"gate" is not supported', 'not an EARLIER plan id', 'verify must be a non-empty', 'does not exist', 'too broad', 'steps must be numbered', 'nothing_test.php']) {
    c(text.includes(needle), `validator missed: ${needle}`);
  }
});

await t('22 secret file (git-ignored .env) changed: run halts, later plans never start', async (c) => {
  const w = build('secret', { cfg: { '001': { modes: ['secret'] } } });
  const r = await runRunner(w);
  c(r.code === 1, `exit ${r.code}`);
  const s = state(w);
  c(s.status === 'halted', `status ${s.status}`);
  c(!s.plans['002'], 'a later plan started');
  c(/secret files/i.test(r.out) && r.out.includes('.env'), 'halt message does not name the secret file');
});

await t('23 lock files of any ecosystem (Cargo.lock, go.sum) pass the scope gate and are reported', async (c) => {
  const w = build('lockfile', { cfg: { '001': { modes: ['lockfile'] } } });
  const r = await runRunner(w);
  c(r.code === 0, `exit ${r.code} ${r.out.slice(-1200)}`);
  c(state(w).plans['001'].status === 'done', 'plan 001 not done');
  const h = fs.readFileSync(path.join(w.dir, 'HANDOFF.md'), 'utf8');
  c(h.includes('Cargo.lock changed') && h.includes('go.sum changed'), 'dependency report missing the lock files');
});

await t('24 validator checks the permissions section', async (c) => {
  const w = build('perms', { manifest: { permissions: { allow: ['Bash(make *)'], deny: [5] } } });
  const { errors } = validateFolder(w.dir, { workspace: w.ws });
  c(errors.join('\n').includes('permissions.deny'), 'bad permissions.deny not caught');
  const w2 = build('perms2', { manifest: { permissions: { allow: ['Bash(make *)'], deny: ['Bash(rm *)'] } } });
  c(!validateFolder(w2.dir, { workspace: w2.ws }).errors.join('\n').includes('permissions'), 'valid permissions were rejected');
});

// ---------- no step may be skipped ----------
const cpsOf = (w, id = '001') => { try { return Object.keys(JSON.parse(fs.readFileSync(path.join(w.runDir, 'plans', id, 'checkpoints.json'), 'utf8'))).map(Number).sort(); } catch { return []; } };
const reportOf = (w) => fs.readFileSync(path.join(w.runDir, 'REPORT.md'), 'utf8');
const failuresOf = (w, id = '001') => { try { return fs.readFileSync(path.join(w.runDir, 'plans', id, 'failures.log'), 'utf8'); } catch { return ''; } };
const setModes = (w, id, modes) => { const cfg = JSON.parse(fs.readFileSync(w.cfg, 'utf8')); cfg[id].modes = modes; fs.writeFileSync(w.cfg, JSON.stringify(cfg)); };
const BAD = 'exports.add=()=>0;';
/** One plan with n steps; step i writes src/<names[i]>.js and checks it. */
function onePlan(n, over = {}) {
  const names = ['a', 'a2', 'a3'].slice(0, n);
  return [{ id: '001', file: '001-a.md', repos: ['toyapp'], depends_on: [], allowed_paths: names.map((x) => `toyapp/src/${x}.js`), verify: names.map((x) => `node check.js ${x}`), est_turns: 10,
    steps: names.map((x, i) => ({ n: i + 1, title: x, verify: [`node check.js ${x}`] })), ...over }];
}
const filesFor = (n) => ['a', 'a2', 'a3'].slice(0, n).map((x) => [`toyapp/src/${x}.js`, GOOD]);

await t('S01 session does one step and says "done": a fresh session continues, every step gets done, no try used', async (c) => {
  const w = build('s01', { plans: onePlan(3), cfg: { '001': { modes: ['partial'], files: filesFor(3) } } });
  const r = await runRunner(w);
  c(r.code === 0, `exit ${r.code}\n${r.out.slice(-900)}`);
  const p = state(w).plans['001'];
  c(p.status === 'done' && p.attempts === 0 && p.sessions === 3, `status ${p.status} attempts ${p.attempts} sessions ${p.sessions}`);
  c(['a', 'a2', 'a3'].every((x) => has(path.join(w.app, 'src', `${x}.js`))), 'a step was skipped');
  c(/ended with steps left/.test(r.out), 'continuation not announced');
  // the same without any report: the steps still all get done; only the last session, which must report, uses a try
  const w2 = build('s01b', { plans: onePlan(3), cfg: { '001': { modes: ['partial_silent', 'partial_silent', 'partial_silent', 'ok'], files: filesFor(3) } } });
  const r2 = await runRunner(w2);
  const p2 = state(w2).plans['001'];
  c(r2.code === 0 && p2.attempts === 1 && ['a', 'a2', 'a3'].every((x) => has(path.join(w2.app, 'src', `${x}.js`))), `silent: exit ${r2.code} attempts ${p2.attempts}`);
});

await t('S03 if_changed in a step check is refused by the validator (it would skip the check when the work was skipped)', async (c) => {
  const w = build('s03', { plans: onePlan(2, { steps: [{ n: 1, title: 'a', verify: ['node check.js a'] }, { n: 2, title: 'a2', verify: [{ cmd: 'node check.js a2', if_changed: ['toyapp/src/a2.js'] }] }] }) });
  const r = await runRunner(w);
  c(r.code === 2 && /if_changed/.test(r.out), `exit ${r.code}\n${r.out.slice(-600)}`);
});

await t('S04 a later step breaks an earlier step: the re-check at the end catches it, plan fails, nothing is skipped', async (c) => {
  const w = build('s04', { plans: onePlan(3, { verify: ['node check.js a3'] }), cfg: { '001': { modes: ['ok'], files: [['toyapp/src/a.js', GOOD], ['toyapp/src/a2.js', GOOD], ['toyapp/src/a3.js', GOOD]] } } });
  // step 3 also breaks a.js (step 1's work)
  const m = JSON.parse(fs.readFileSync(w.cfg, 'utf8')); m['001'].files[2] = ['toyapp/src/a.js', BAD]; fs.writeFileSync(w.cfg, JSON.stringify(m));
  const man = JSON.parse(fs.readFileSync(path.join(w.dir, 'manifest.json'), 'utf8')); man.plans[0].steps[2].verify = ['node check.js a2']; man.plans[0].verify = ['node check.js a2']; fs.writeFileSync(path.join(w.dir, 'manifest.json'), JSON.stringify(man));
  const r = await runRunner(w);
  c(r.code === 1 && state(w).plans['001'].status === 'failed', `exit ${r.code} status ${state(w).plans['001']?.status}`);
  c(/step 1 re-check failed/.test(failuresOf(w)), `failures.log does not name the step 1 re-check:\n${failuresOf(w).slice(0, 500)}`);
});

await t('S05 a step gets 3 tries; every reason is stored; a new start keeps the passed steps, re-checks them and goes on', async (c) => {
  const w = build('s05', { plans: onePlan(2), cfg: { '001': { modes: ['crash_after_step1', 'crash', 'crash'], files: filesFor(2) } } });
  const r = await runRunner(w);
  c(r.code === 1, `exit ${r.code}`);
  const p = state(w).plans['001'];
  c(p.status === 'failed' && p.attempts === 3, `status ${p.status} attempts ${p.attempts}`);
  c(JSON.stringify(cpsOf(w)) === '[1]', `checkpoints ${JSON.stringify(cpsOf(w))}`);
  const fl = failuresOf(w);
  c(['try 1 of 3', 'try 2 of 3', 'try 3 of 3'].every((x) => fl.includes(`step 2, ${x}`)), `failures.log:\n${fl.slice(0, 900)}`);
  c(has(path.join(w.app, 'src', 'a.js')) && !has(path.join(w.app, 'src', 'a2.js')), 'step 1 work was not kept, or step 2 debris was left');
  c(/step 2 failed 3 times/.test(r.out), 'halt message does not say which step failed');
  setModes(w, '001', ['ok']);
  const r2 = await runRunner(w);
  c(r2.code === 0, `second run exit ${r2.code}\n${r2.out.slice(-900)}`);
  c(/Re-checking the 1 kept step/.test(r2.out) && /resuming after step 1/.test(r2.out), 'the kept step was not re-checked, or the run did not resume after it');
  c(has(path.join(w.app, 'src', 'a2.js')), 'step 2 never done');
});

await t('S06 "not done" on the last step: halts, keeps the steps before it, rolls that step back; a new start finishes it', async (c) => {
  const w = build('s06', { plans: onePlan(2), cfg: { '001': { modes: ['notdone_last'], files: filesFor(2) } } });
  const r = await runRunner(w);
  c(r.code === 1 && state(w).plans['001'].status === 'notdone', `exit ${r.code} status ${state(w).plans['001']?.status}`);
  c(JSON.stringify(cpsOf(w)) === '[1]', `checkpoints ${JSON.stringify(cpsOf(w))}`);
  c(has(path.join(w.app, 'src', 'a.js')) && !has(path.join(w.app, 'src', 'a2.js')), 'wrong rollback point');
  c(/the second half of the last step/.test(reportOf(w)) && /Not done \(the run stopped for this\)/.test(reportOf(w)), 'the report does not list the not-done item');
  c(state(w).plans['001'].sessions === 1, 'it retried instead of halting');
  setModes(w, '001', ['ok']);
  const r2 = await runRunner(w);
  c(r2.code === 0 && has(path.join(w.app, 'src', 'a2.js')), `second run exit ${r2.code}\n${r2.out.slice(-700)}`);
});

await t('S07 "not done" on step 1 although every step was checkpointed: goes back to before step 1', async (c) => {
  const w = build('s07', { plans: onePlan(2), cfg: { '001': { modes: ['notdone_first'], files: filesFor(2) } } });
  const r = await runRunner(w);
  c(r.code === 1 && state(w).plans['001'].status === 'notdone', `exit ${r.code}`);
  c(cpsOf(w).length === 0 && !has(path.join(w.app, 'src', 'a.js')), `checkpoints ${JSON.stringify(cpsOf(w))}`);
});

await t('S07b a session that moved forward but says a checkpointed step is not done: halts (no blind continue)', async (c) => {
  const w = build('s07b', { plans: onePlan(3), cfg: { '001': { modes: ['partial_notdone'], files: filesFor(3) } } });
  const r = await runRunner(w);
  c(r.code === 1 && state(w).plans['001'].status === 'notdone', `exit ${r.code} status ${state(w).plans['001']?.status}`);
  c(/half of it is missing/.test(r.out) && !/not reached/.test(state(w).haltReason), 'wrong items in the halt (steps not reached must not be listed)');
  c(cpsOf(w).length === 0, `checkpoints ${JSON.stringify(cpsOf(w))}`);
});

await t('S08 no final report: a failed try (not a halt), the next try passes', async (c) => {
  const w = build('s08', { plans: onePlan(1), cfg: { '001': { modes: ['noreport', 'ok'], files: filesFor(1) } } });
  const r = await runRunner(w);
  c(r.code === 0 && state(w).plans['001'].attempts === 1, `exit ${r.code} attempts ${state(w).plans['001']?.attempts}`);
  c(/final report is missing or not valid/.test(failuresOf(w)), 'reason not stored');
});

await t('S09 the report as a json block in the final text is accepted', async (c) => {
  const w = build('s09', { plans: onePlan(1), cfg: { '001': { modes: ['textreport'], files: filesFor(1) } } });
  const r = await runRunner(w);
  c(r.code === 0 && state(w).plans['001'].attempts === 0, `exit ${r.code}\n${r.out.slice(-600)}`);
});

await t('S10 "done differently" with a reason: plan done, first section of the report; without a reason: a failed try', async (c) => {
  const w = build('s10', { plans: onePlan(1), cfg: { '001': { modes: ['deviation'], files: filesFor(1) } } });
  const r = await runRunner(w);
  c(r.code === 0, `exit ${r.code}`);
  const rep = reportOf(w);
  const s1 = rep.indexOf('## 1. Read this: done differently from the plan');
  c(s1 > 0 && rep.indexOf('imagedestroy') > s1 && rep.indexOf('imagedestroy') < rep.indexOf('## 2.'), 'deviation not in section 1');
  c(/## 3\. Needs a person to check[\s\S]*open the page in a browser/.test(rep), 'person check not in section 3');
  const w2 = build('s10b', { plans: onePlan(1), cfg: { '001': { modes: ['deviation_noreason', 'ok'], files: filesFor(1) } } });
  const r2 = await runRunner(w2);
  c(r2.code === 0 && state(w2).plans['001'].attempts === 1 && /has no reason/.test(failuresOf(w2)), `exit ${r2.code} attempts ${state(w2).plans['001']?.attempts}`);
});

await t('S11 files outside allowed_paths (also .claude/rules) are allowed and listed in the report', async (c) => {
  const w = build('s11', { plans: onePlan(1), cfg: { '001': { modes: ['outside'], files: filesFor(1) } } });
  const r = await runRunner(w);
  c(r.code === 0, `exit ${r.code}\n${r.out.slice(-800)}`);
  const rep = reportOf(w);
  const s2 = rep.indexOf("## 2. Changed outside the plan's allowed_paths");
  c(s2 > 0 && rep.indexOf('toyapp/notes/extra.txt', s2) > 0 && rep.indexOf('toyapp/.claude/rules/new-rule.md', s2) > 0, 'outside files not in section 2');
  c(fs.readFileSync(path.join(w.dir, 'HANDOFF.md'), 'utf8').includes('Changed outside allowed_paths'), 'HANDOFF does not list them');
});

await t('S13 a finished plan changed afterwards: refuses to resume', async (c) => {
  const w = build('s13', { cfg: { '002': { modes: ['lie'] } } });
  await runRunner(w);
  fs.appendFileSync(path.join(w.dir, '001-a.md'), '\nOne more thing.\n');
  const r = await runRunner(w);
  c(r.code === 2 && /was changed after it finished/.test(r.out), `exit ${r.code}\n${r.out.slice(-400)}`);
});

await t('S14 the steps of a stopped plan changed: it starts over instead of trusting old checkpoints', async (c) => {
  const w = build('s14', { plans: onePlan(2), cfg: { '001': { modes: ['notdone_last'], files: filesFor(2) } } });
  await runRunner(w);
  const man = JSON.parse(fs.readFileSync(path.join(w.dir, 'manifest.json'), 'utf8')); man.plans[0].steps[0].title = 'a, renamed'; fs.writeFileSync(path.join(w.dir, 'manifest.json'), JSON.stringify(man));
  setModes(w, '001', ['ok']);
  const r = await runRunner(w);
  c(r.code === 0 && /starts over/.test(r.out) && !/resuming after step 1/.test(r.out), `exit ${r.code}\n${r.out.slice(-700)}`);
});

await t('S15 a step check that passes before any work is reported as weak', async (c) => {
  const w = build('s15', { plans: onePlan(2, { steps: [{ n: 1, title: 'a', verify: ['node -e "process.exit(0)"'] }, { n: 2, title: 'a2', verify: ['node check.js a2'] }] }), cfg: { '001': { modes: ['ok'], files: filesFor(2) } } });
  const r = await runRunner(w);
  c(r.code === 0, `exit ${r.code}\n${r.out.slice(-600)}`);
  c(/## Weak checks[\s\S]*Plan 001: step\(s\) 1\b/.test(reportOf(w)), 'weak check not reported');
});

await t('S16 a session changes another repo next to the project: halts', async (c) => {
  const w = build('s16', { otherRepo: true, plans: onePlan(1), cfg: { '001': { modes: ['otherrepo'], files: filesFor(1) } } });
  const r = await runRunner(w);
  c(r.code === 1 && /another repo outside the project/.test(r.out), `exit ${r.code}\n${r.out.slice(-600)}`);
});

await t('S17 a program run by the session commits: halts (the Claude runner now checks HEAD too)', async (c) => {
  const w = build('s17', { plans: onePlan(1), cfg: { '001': { modes: ['headmove'], files: filesFor(1) } } });
  const r = await runRunner(w);
  c(r.code === 1 && /changed git state/.test(r.out) && /HEAD moved/.test(r.out), `exit ${r.code}\n${r.out.slice(-600)}`);
});

await t('S18 refused tool calls are listed in the report with the command', async (c) => {
  const w = build('s18', { plans: onePlan(1), cfg: { '001': { modes: ['refused'], files: filesFor(1) } } });
  const r = await runRunner(w);
  c(r.code === 0 && reportOf(w).includes('Bash: cd /x && php migrate.php'), `exit ${r.code}`);
});

await t('S19 file guard: writes only inside the project, never to blocked files; .claude/rules and .env.example are open', async (c) => {
  const w = build('s19');
  const S = { repos: { toyapp: w.app, toyapi: w.api }, planDirRel: 'docs/plans/feat', primaryName: 'toyapp' };
  const d = (tool, p) => decideFile({ tool_name: tool, tool_input: { file_path: p } }, S).decision;
  c(d('Write', path.join(w.app, 'src', 'x.js')) === 'allow', 'normal write refused');
  c(d('Write', path.join(os.homedir(), 'plan-runner-guard-test', 'x.js')) === 'deny', 'write outside the project allowed'); // (the test workspace itself is in the temp folder, which is allowed)
  c(d('Write', path.join(os.tmpdir(), 'x.txt')) === 'allow', 'write to the temp folder refused');
  c(d('Edit', path.join(w.app, '.claude', 'rules', 'x.md')) === 'allow', '.claude/rules refused');
  c(d('Edit', path.join(w.app, '.claude', 'settings.json')) === 'deny', '.claude/settings.json allowed');
  c(d('Write', path.join(w.app, '.agents', 'hooks.json')) === 'deny', '.agents/hooks.json allowed');
  c(d('Write', path.join(w.app, '.env.example')) === 'allow' && d('Read', path.join(w.app, '.env.example')) === 'allow', '.env.example refused');
  c(d('Read', path.join(w.app, '.env')) === 'deny' && d('Write', path.join(w.app, '.env')) === 'deny', '.env allowed');
  c(d('Write', path.join(w.dir, 'manifest.json')) === 'deny' && d('Write', path.join(w.dir, 'BLOCKED.md')) === 'allow', 'plan folder rule wrong');
  const args = await runRunner(build('s19run', { plans: onePlan(1), cfg: { '001': { modes: ['ok'], files: filesFor(1) } } }));
  c(args.code === 0, 'run failed');
});

await t('S20 validator: a step without a check, an unknown plan-file step, and a check on a file nobody creates are errors', async (c) => {
  const w = build('s20', { plans: onePlan(2, {
    steps: [{ n: 1, title: 'a' }, { n: 2, title: 'a2', verify: [`node "{{runner}}/assert.mjs" has src/never.js "x"`] }],
  }) });
  fs.appendFileSync(path.join(w.dir, '001-a.md'), '\n### Step 3: extra\nDo more.\n');
  const text = validateFolder(w.dir, { workspace: w.ws }).errors.join('\n');
  c(/step 1: verify must be a non-empty array/.test(text), `missing-step-check not caught:\n${text}`);
  c(/plan file has "Step 3"/.test(text), 'extra plan-file step not caught');
  c(/toyapp\/src\/never\.js/.test(text), 'check on a file nobody creates not caught');
});

await t('S21 validate.mjs run on its own (how /plan-split runs it) finds the repo folders next to the main repo', async (c) => {
  const w = build('s21');
  const r = spawnSync('node', [path.join(RUNNER, 'validate.mjs'), w.dir], { encoding: 'utf8' });
  c(r.status === 0 && /VALID/.test(r.stdout) && !/INVALID/.test(r.stdout), `exit ${r.status}\n${r.stdout}`);
});

await t('S22 all steps done but the final check fails: the retry prompt says so (no "start at step N+1")', async (c) => {
  const w = build('s22', { plans: onePlan(1, { verify: ['node check.js z'] }), cfg: { '001': { modes: ['ok'], files: filesFor(1) } } });
  const r = await runRunner(w);
  c(r.code === 1 && /the final check failed 3 times/.test(r.out), `exit ${r.code}\n${r.out.slice(-500)}`);
  const prompts = fs.readFileSync(`${w.cfg}.prompts.log`, 'utf8');
  c(/ALL 1 steps are ALREADY DONE/.test(prompts) && !/Start at step 2/.test(prompts), 'wrong retry prompt');
});

await t('S23 the session gets the file guard (--settings) and the report schema (--json-schema)', async (c) => {
  const w = build('s23', { plans: onePlan(1), cfg: { '001': { modes: ['ok'], files: filesFor(1) } } });
  await runRunner(w);
  const args = fs.readFileSync(`${w.cfg}.args.log`, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))[0];
  const settings = JSON.parse(args[args.indexOf('--settings') + 1]);
  const schema = JSON.parse(args[args.indexOf('--json-schema') + 1]);
  c(/file-guard\.mjs/.test(settings.hooks.PreToolUse[0].hooks[0].command), 'no file guard hook');
  c(schema.required.includes('not_done'), 'no report schema');
});

const LIMIT = Number(process.env.CHAOS_PAR || 5);
let qi = 0;
await Promise.all(Array.from({ length: LIMIT }, async () => { while (qi < queue.length) await queue[qi++](); }));
results.sort((a, b) => a.name.localeCompare(b.name));
const failed = results.filter((r) => r.fails.length);
console.log(`\n${results.length - failed.length}/${results.length} passed. Test workspaces: ${ROOT}`);
process.exit(failed.length ? 1 : 0);
