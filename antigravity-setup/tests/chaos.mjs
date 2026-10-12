// Chaos tests: the runner against a fake agy that lies, hangs, crashes and trips limits.
// Uses no model usage. Run: node tests/chaos.mjs [name-filter]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateFolder } from '../payload/tools/plan-runner/validate.mjs';
import { killTree } from '../payload/tools/plan-runner/lib/agy.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUNNER = path.join(HERE, '..', 'payload', 'tools', 'plan-runner');
const RUN = path.join(RUNNER, 'run.mjs');
const ASSERT = path.join(RUNNER, 'assert.mjs');
const FAKE = path.join(HERE, 'fake-agy.mjs');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-chaos-'));
const REAL_HOME = path.join(ROOT, 'realhome'); // stands in for the user's home, so the tests never read the real one
fs.mkdirSync(REAL_HOME, { recursive: true });
fs.writeFileSync(path.join(REAL_HOME, '.gitconfig'), '[user]\n\tname = Test\n');
fs.writeFileSync(path.join(REAL_HOME, '.npmrc'), '//registry/:_authToken=not-for-the-session\n');
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

const envFor = (w, extra = {}) => ({
  ...process.env, PLAN_RUNNER_AGY_CMD: JSON.stringify(['node', FAKE]), FAKE_CFG: w.cfg, PLAN_RUNNER_HOME: w.home,
  PLAN_RUNNER_QUIET: '1', PLAN_RUNNER_FAST: '1', PLAN_RUNNER_LINGER_MS: '1500', USERPROFILE: REAL_HOME, HOME: REAL_HOME, MY_API_TOKEN: 'super-secret', ...extra,
});
function runRunner(w, extra = [], env = {}) {
  return new Promise((resolve) => {
    const child = spawn('node', [RUN, 'run', 'feat', '--repo', w.app, ...extra], { env: envFor(w, env), windowsHide: true });
    let out = '';
    const take = (d) => { out += d; if (process.env.CHAOS_DEBUG) process.stdout.write(d); };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    const to = setTimeout(() => killTree(child.pid), 900000);
    child.on('close', (code) => { clearTimeout(to); resolve({ code, out }); });
  });
}
const state = (w) => JSON.parse(fs.readFileSync(path.join(w.runDir, 'state.json'), 'utf8'));
const has = (p) => fs.existsSync(p);
const commits = (repo) => Number(sh(repo, ['rev-list', '--count', 'HEAD']).stdout.trim());
const dirty = (repo) => sh(repo, ['status', '--porcelain', '--untracked-files=all', '--', '.', ':!docs/plans']).stdout.trim();
const argLog = (w) => fs.readFileSync(`${w.cfg}.args.log`, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

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
  const w = build('happy', { manifest: { env: { MANIFEST_DB_PASSWORD: 'throwaway' } } });
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
  c(r.out.includes('[System] Starting agy for 001-a.md...'), 'missing "Starting agy for" line');
  c(/-> Progress: write_to_file/.test(r.out), 'missing live progress line');
  c(r.out.includes('[CLI Internal] fake agy'), 'stderr not forwarded as [CLI Internal]');
  c(r.out.includes('Safety guard self-test passed'), 'guard self-test did not run');
  const sessions = argLog(w).filter((a) => a.argv.includes('-p'));
  c(sessions.length >= 4, `expected 3 plan sessions + a final review, saw ${sessions.length}`);
  const a = sessions[0];
  c(a.argv.includes('--model') && a.argv[a.argv.indexOf('--model') + 1] === 'gemini-3.8-flash-high', `model flag: ${a.argv}`);
  c(a.argv.includes('stream-json') && a.argv.includes('--output-format'), 'output format flag missing');
  c(a.home !== REAL_HOME && a.home.startsWith(w.runDir), `the session did not get its own HOME: ${a.home}`);
  c(a.guardFiles.length === 4, `guard files missing in the session home: ${a.guardFiles}`);
  c(a.hooks?.['plan-runner-guard']?.PreToolUse?.[0]?.hooks?.[0]?.command === 'node guard.mjs', 'hooks.json has no guard hook');
  c(a.settings?.permissions?.allow?.includes('command(*)') && a.settings.permissions.deny.some((d) => d.startsWith('read_file(.env')), `settings.json: ${JSON.stringify(a.settings).slice(0, 200)}`);
  c(a.secretVisible === false, 'a secret-looking variable reached the session');
  c(a.manifestEnvVisible === true, 'the manifest env did not reach the session');
  c(a.gitconfigCopied === true && a.npmrcCopied === false, `home copies: gitconfig=${a.gitconfigCopied} npmrc=${a.npmrcCopied}`);
  if (process.platform === 'win32') c(a.localAppData === true, 'the session HOME has no AppData\\Local: PowerShell would write its cache into the workspace (real-run bug)');
  const review = sessions[sessions.length - 1];
  c(review.settings.permissions.allow.length === 0 && review.settings.permissions.deny.includes('write_file(*)') && review.settings.permissions.deny.includes('command(*)'), `the final review must be read-only: ${JSON.stringify(review.settings.permissions)}`);
  c(a.settings.permissions.allow.join() === 'command(*)', `a plan session may only be given command(*) explicitly (agy allows the workspace files itself): ${a.settings.permissions.allow}`);
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

await t('03 out-of-scope edit: caught, rolled back, saved as patch', async (c) => {
  const w = build('scope', { cfg: { '001': { modes: ['scope'] } } });
  const r = await runRunner(w);
  c(r.code === 1, `exit ${r.code}`);
  c(!has(path.join(w.app, 'OUTSIDE.txt')), 'stray file was not rolled back');
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
  const w = build('garbage', { cfg: { '001': { modes: ['garbage'] } } });
  const r = await runRunner(w);
  c(r.code === 0, `exit ${r.code}\n${r.out.slice(-600)}`);
  c(r.out.includes('non-JSON stdout'), 'garbage was not reported');
});

await t('07 usage limit / spent credits (AGY_ERROR, exit 3): waits, retries, no attempt used', async (c) => {
  const w = build('quota', { cfg: { '001': { modes: ['quota', 'ok'] } } });
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

await t('10 crash after step 1: resumes at step 2, progress not counted as an attempt', async (c) => {
  const w = build('progress', { twoSteps: true, cfg: { '001': { modes: ['crash_after_step1', 'ok'] } } });
  const r = await runRunner(w);
  c(r.code === 0, `exit ${r.code}\n${r.out.slice(-900)}`);
  c(state(w).plans['001'].attempts === 0, `attempts ${state(w).plans['001'].attempts}`);
  c(/resuming after step 1/.test(r.out), 'second session did not resume after step 1');
});

await t('11 dirty tree at start: refuses, spawns nothing', async (c) => {
  const w = build('dirty');
  fs.writeFileSync(path.join(w.app, 'src', 'index.js'), 'changed');
  const r = await runRunner(w);
  c(r.code === 2 && r.out.includes('uncommitted changes'), `exit ${r.code}`);
  c(!has(`${w.cfg}.args.log`), 'agy was started');
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
  while (!has(`${w.cfg}.cnt.001`) && Date.now() - t0 < 60000) await new Promise((r) => setTimeout(r, 200));
  await new Promise((r) => setTimeout(r, 1500));
  killTree(child.pid);
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

await t('19 tool-call limit (agy has no max-turns flag): the runner stops the session itself', async (c) => {
  const w = build('toomany', { defaults: { max_turns: 2 }, cfg: { '001': { modes: ['toomany'] } } });
  const r = await runRunner(w);
  c(r.code === 1 && /turn limit of 6 tool calls reached/.test(r.out), `exit ${r.code}\n${r.out.slice(-600)}`);
  c(state(w).plans['001'].status === 'failed', 'plan should fail');
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

await t('25 a refused tool call is not fatal: agy still says SUCCESS, the gates decide', async (c) => {
  const w = build('denied', { cfg: { '001': { modes: ['denied'] } } });
  const r = await runRunner(w);
  c(r.code === 0, `exit ${r.code}\n${r.out.slice(-800)}`);
  c(/\[Denied\] run_command git add -A was refused/.test(r.out), 'the refusal was not reported');
  c(state(w).plans['001'].status === 'done', 'plan 001 should pass: the work was done');
});

await t('26 a program run by the session moves HEAD (bypasses the deny rules): halts, files rolled back', async (c) => {
  const w = build('headmove', { cfg: { '001': { modes: ['headmove'] } } });
  const r = await runRunner(w);
  c(r.code === 1 && /changed git state/.test(r.out) && /HEAD moved/.test(r.out), `exit ${r.code}\n${r.out.slice(-700)}`);
  c(!has(path.join(w.app, 'src', 'a.js')), 'the files were not rolled back');
  c(!state(w).plans['002'], 'a later plan started');
});

await t('27 session lingers after its result (background task): killed after the grace period, plan counts as done', async (c) => {
  const w = build('linger', { cfg: { '001': { modes: ['lingers'] } } });
  const r = await runRunner(w);
  c(r.code === 0, `exit ${r.code}\n${r.out.slice(-800)}`);
  c(state(w).plans['001'].status === 'done' && state(w).plans['001'].attempts === 0, 'plan 001 should be done on the first attempt');
});

await t('28 a model error that is not a quota error (exit 3) counts as a failed attempt', async (c) => {
  const w = build('modelerror', { cfg: { '001': { modes: ['modelerror'] } } });
  const r = await runRunner(w);
  c(r.code === 1 && state(w).plans['001'].attempts === 3, `exit ${r.code} attempts ${state(w).plans['001']?.attempts}`);
  c(!/Usage limit reached/.test(r.out), 'a model error was treated as a usage limit');
});

await t('29 result status ERROR, and a session that dies without a result, both fail the attempt', async (c) => {
  const w = build('resulterror', { cfg: { '001': { modes: ['resulterror'] } } });
  const r = await runRunner(w);
  c(r.code === 1 && /model exploded/.test(r.out), `exit ${r.code}\n${r.out.slice(-500)}`);
  const w2 = build('noresult', { cfg: { '001': { modes: ['noresult'] } } });
  const r2 = await runRunner(w2);
  c(r2.code === 1 && /no result from agy/.test(r2.out), `exit ${r2.code}\n${r2.out.slice(-500)}`);
});

await t('30 editing .agents/ (the agent configuration) is a scope violation', async (c) => {
  const w = build('agentdir', { cfg: { '001': { modes: ['agentdir'] } } });
  const r = await runRunner(w);
  c(r.code === 1 && r.out.includes('SCOPE GATE') && r.out.includes('.agents/hooks.json'), `exit ${r.code}\n${r.out.slice(-500)}`);
});

await t('31 unknown model: refuses to start and lists what agy offers', async (c) => {
  const w = build('badmodel');
  const r = await runRunner(w, [], { FAKE_MODELS: JSON.stringify(['some-other-model']) });
  c(r.code === 2 && /The model "gemini-[\w.-]+" is not available in agy/.test(r.out) && r.out.includes('some-other-model'), `exit ${r.code}\n${r.out.slice(-500)}`);
  c(!has(`${w.cfg}.args.log`), 'a session was started');
});

await t('32 agy cannot start in the isolated HOME: refuses and points to --no-isolation', async (c) => {
  const w = build('nostart');
  const r = await runRunner(w, [], { FAKE_MODELS_FAIL: '1' });
  c(r.code === 2 && /agy could not start in its isolated HOME/.test(r.out) && r.out.includes('--no-isolation'), `exit ${r.code}\n${r.out.slice(-500)}`);
});

await t('33 --no-isolation: runs in the real HOME, no guard, and the report says the session was not restricted', async (c) => {
  const w = build('noiso');
  const r = await runRunner(w, ['--no-isolation']);
  c(r.code === 0, `exit ${r.code}\n${r.out.slice(-600)}`);
  const a = argLog(w).filter((x) => x.argv.includes('-p'))[0];
  c(a.home === REAL_HOME && a.hooks === null, `home ${a.home}`);
  c(a.secretVisible === false, 'the secret-looking variable must be scrubbed in this mode too');
  c(/NOT restricted/.test(fs.readFileSync(path.join(w.runDir, 'REPORT.md'), 'utf8')), 'the report does not say the session was unrestricted');
});

await t('34 --dry-run checks agy, models and the guard but starts no session', async (c) => {
  const w = build('dry');
  const r = await runRunner(w, ['--dry-run']);
  c(r.code === 0 && r.out.includes('Dry run. agy, the models and the guard are OK'), `exit ${r.code}\n${r.out.slice(-500)}`);
  c(!has(`${w.cfg}.args.log`), 'a session was started');
});

await t('35 old Antigravity manifest format is rejected with a conversion hint', async (c) => {
  const w = build('oldformat', { plans: [{ id: '01-001', name: 'x', repo: 'toyapp', file: '001-a.md', depends_on: [], gate: false, verify_command: 'node check.js a', prompt: 'do it' }] });
  fs.writeFileSync(path.join(w.dir, '001-a.md'), planMd('01-001', [{ n: 1, title: 'a' }]));
  const { errors } = validateFolder(w.dir, { workspace: w.ws });
  c(errors.length === 1 && /OLD Antigravity format/.test(errors[0]) && /repos/.test(errors[0]) && /verify/.test(errors[0]), errors.join('\n'));
});

await t('36 validator: regexes in verify commands must compile (assert.mjs is an error, grep -E a warning)', async (c) => {
  const w = build('regex', { plans: [
    { id: '001', file: '001-a.md', repos: ['toyapp'], depends_on: [], allowed_paths: ['toyapp/src/a.js'], est_turns: 10,
      verify: [`node ${ASSERT} has toyapp/src/a.js "foo(bar"`, `node ${ASSERT} none toyapp/src/a.js "ok(x)"`, 'grep -E "(oops" toyapp/src/a.js'], steps: [{ n: 1, title: 'a', verify: [`node ${ASSERT} count toyapp/src/a.js "a)" 1`] }] },
  ] });
  fs.writeFileSync(path.join(w.dir, '001-a.md'), planMd('001', [{ n: 1, title: 'a' }]));
  const { errors, warnings } = validateFolder(w.dir, { workspace: w.ws });
  c(errors.filter((e) => e.includes('does not compile')).length === 2, `expected 2 regex errors, got:\n${errors.join('\n')}`);
  c(warnings.some((x) => x.includes('grep')), 'grep -E warning missing');
});

await t('37 assert.mjs: has/none/count/exists/json, and a bad regex or file exits 2, never 0', async (c) => {
  const f = path.join(ROOT, 'assert-target.txt');
  fs.writeFileSync(f, 'alpha(beta)\nsecond line\n');
  fs.writeFileSync(`${f}.json`, JSON.stringify({ a: { b: 'x' }, n: 3 }));
  const a = (...args) => spawnSync('node', [ASSERT, ...args], { encoding: 'utf8' }).status;
  c(a('has', f, 'alpha\\(beta\\)') === 0, 'has should pass');
  c(a('has', f, 'gamma') === 1, 'has should fail with 1');
  c(a('none', f, 'gamma') === 0 && a('none', f, 'second') === 1, 'none');
  c(a('count', f, 'line', '1') === 0 && a('count', f, 'line', '2') === 1, 'count');
  c(a('exists', f, `${f}.json`) === 0 && a('exists', f, 'nope.txt') === 1, 'exists');
  c(a('json', `${f}.json`, 'a.b', 'x') === 0 && a('json', `${f}.json`, 'a.c') === 1 && a('json', `${f}.json`, 'n', '4') === 1, 'json');
  c(a('has', f, 'alpha(') === 2, 'an invalid regex must exit 2');
  c(a('none', f, '(') === 2, 'an invalid regex in none must exit 2 (it must never pass silently)');
  c(a('has', path.join(ROOT, 'missing.txt'), 'x') === 2, 'a missing file must exit 2');
  c(a('bogus') === 2 && a() === 2, 'bad usage must exit 2');
});

await t('38 status command prints the state of a halted run', async (c) => {
  const w = build('status', { cfg: { '001': { modes: ['lie'] } } });
  await runRunner(w);
  const r = spawnSync('node', [RUN, 'status', 'feat', '--repo', w.app], { env: envFor(w), encoding: 'utf8' });
  c(r.status === 0 && /Run "feat": halted/.test(r.stdout) && /001: failed/.test(r.stdout), r.stdout);
});

await t('39 validate.mjs run on its own (how /plan-split runs it) finds the repo folders next to the main repo', async (c) => {
  const w = build('standalone');
  const r = spawnSync('node', [path.join(RUNNER, 'validate.mjs'), w.dir], { encoding: 'utf8' });
  c(r.status === 0 && /VALID/.test(r.stdout) && !/INVALID/.test(r.stdout), `exit ${r.status}\n${r.stdout}`);
});

const LIMIT = Number(process.env.CHAOS_PAR || 5);
let qi = 0;
await Promise.all(Array.from({ length: LIMIT }, async () => { while (qi < queue.length) await queue[qi++](); }));
results.sort((a, b) => a.name.localeCompare(b.name));
const failed = results.filter((r) => r.fails.length);
console.log(`\n${results.length - failed.length}/${results.length} passed. Test workspaces: ${ROOT}`);
process.exit(failed.length ? 1 : 0);
