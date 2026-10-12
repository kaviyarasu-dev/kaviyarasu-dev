// Tests for the two installers and the router. Offline: they run the installers from this checkout (--local) into
// temporary config folders, and the clone path against a local git repo. They never touch ~/.gemini or ~/.claude.
// Run: node tests/installer.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..', '..');
const ROUTER = path.join(REPO, 'install-router.mjs');
const AGY_INSTALL = path.join(REPO, 'antigravity-setup', 'install.mjs');
const CLAUDE_INSTALL = path.join(REPO, 'claude-plan-automation', 'install.mjs');
const VERSION = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')).version;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'installer-test-'));

let pass = 0;
const fails = [];
const ok = (name, cond, extra = '') => { if (cond) pass++; else fails.push(`${name} ${extra}`.trim()); };
const fresh = (name) => { const d = path.join(TMP, name); fs.mkdirSync(d, { recursive: true }); return d; };
const walk = (dir, base = dir) => fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name), base) : [path.relative(base, path.join(dir, e.name)).split(path.sep).join('/')])) : [];
const run = (script, args, env) => {
  const r = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', env: { ...process.env, ...env }, timeout: 240000 });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
};
const payloadCount = (dir) => walk(dir).length;
const AGY_FILES = payloadCount(path.join(REPO, 'antigravity-setup', 'payload'));
const CLAUDE_FILES = payloadCount(path.join(REPO, 'claude-plan-automation', 'payload'));

// ---------- Claude: the existing public command keeps working exactly as before ----------
{
  const c = fresh('claude');
  let r = run(ROUTER, ['--local'], { CLAUDE_CONFIG_DIR: c });
  ok('router with no name installs the Claude setup', r.code === 0 && r.out.includes(`${CLAUDE_FILES} added, 0 updated, 0 unchanged`), r.out.slice(-400));
  ok('Claude: 18 files installed', CLAUDE_FILES === 18 && walk(c).filter((f) => !f.startsWith('backups/') && f !== 'settings.json' && f !== '.plan-automation.json').length === 18);
  ok('Claude: the version is printed', r.out.includes(`v${VERSION}`));
  r = run(ROUTER, ['--local'], { CLAUDE_CONFIG_DIR: c });
  ok('Claude: second run reports everything unchanged', r.code === 0 && r.out.includes(`0 added, 0 updated, ${CLAUDE_FILES} unchanged`), r.out.slice(-300));
  r = run(ROUTER, ['claude', '--local', '--dry-run'], { CLAUDE_CONFIG_DIR: c });
  ok('router "claude" is the same command (dry run)', r.code === 0 && r.out.includes('[dry run]'));
  r = run(ROUTER, ['--local', '--uninstall'], { CLAUDE_CONFIG_DIR: c });
  ok('Claude uninstall works through the router', r.code === 0 && !fs.existsSync(path.join(c, '.plan-automation.json')), r.out.slice(-300));
  const none = run(ROUTER, ['bogus'], {});
  ok('router: an unknown name is refused', none.code === 2 && /Unknown installer/.test(none.out));
}

// ---------- Antigravity: fresh install ----------
const A = fresh('agy');
const cfgA = path.join(A, 'config');
{
  let r = run(ROUTER, ['antigravity', '--local'], { AGY_GEMINI_DIR: A });
  ok('antigravity: fresh install', r.code === 0 && r.out.includes(`${AGY_FILES} added, 0 updated, 0 unchanged`), r.out.slice(-500));
  ok('antigravity: the version is printed', r.out.includes(`v${VERSION}`));
  for (const f of ['config/skills/plan-feature/SKILL.md', 'config/skills/plan-split/SKILL.md', 'config/skills/grill-me/SKILL.md', 'config/agents/requirements-reviewer.md', 'config/agents/plan-cold-reader.md', 'config/agents/plan-auditor.md',
    'config/scripts/planning-context.mjs', 'tools/plan-runner/run.mjs', 'tools/plan-runner/validate.mjs', 'tools/plan-runner/checkpoint.mjs', 'tools/plan-runner/assert.mjs', 'tools/plan-runner/lib/guard.mjs', 'tools/plan-runner/config/permissions.json']) {
    ok(`antigravity: installed ${f}`, fs.existsSync(path.join(A, f)));
  }
  const hooks = JSON.parse(fs.readFileSync(path.join(cfgA, 'hooks.json'), 'utf8'));
  ok('antigravity: hooks.json has the named hook with a relative command', hooks['kaviyarasu-plan-automation']?.PreInvocation?.[0]?.command === 'node scripts/planning-context.mjs');
  ok('antigravity: nothing outside config/ and tools/ was written (no history, projects, auth, models, settings)', walk(A).every((f) => /^(config|tools)\//.test(f) || f === '.plan-automation-antigravity.json'), walk(A).filter((f) => !/^(config|tools)\//.test(f)).join(','));
  const USER_PATH = /C:[\\/]+Users[\\/]+[A-Za-z0-9._-]+|\/Users\/[a-z]|\binc3241\b|Kaviyarasu[\\/]/;
  const hardcoded = walk(A).filter((f) => /\.(mjs|json|md)$/.test(f) && USER_PATH.test(fs.readFileSync(path.join(A, f), 'utf8')));
  ok('antigravity: no hardcoded user paths in the installed files', hardcoded.length === 0, hardcoded.join(','));

  // idempotent
  const before = fs.statSync(path.join(cfgA, 'hooks.json')).mtimeMs;
  r = run(ROUTER, ['antigravity', '--local'], { AGY_GEMINI_DIR: A });
  ok('antigravity: second run, everything unchanged', r.code === 0 && r.out.includes(`0 added, 0 updated, ${AGY_FILES} unchanged`), r.out.slice(-300));
  ok('antigravity: second run does not rewrite hooks.json or make a backup', fs.statSync(path.join(cfgA, 'hooks.json')).mtimeMs === before && !fs.existsSync(path.join(A, 'backups')));

  // update: an installed file was edited, the next run restores it and keeps a backup
  const skill = path.join(A, 'config', 'skills', 'plan-split', 'SKILL.md');
  fs.writeFileSync(skill, 'EDITED BY SOMEONE');
  r = run(ROUTER, ['antigravity', '--local'], { AGY_GEMINI_DIR: A });
  ok('antigravity: update restores the edited file', r.out.includes(`0 added, 1 updated, ${AGY_FILES - 1} unchanged`) && fs.readFileSync(skill, 'utf8') !== 'EDITED BY SOMEONE', r.out.slice(-300));
  const backups = walk(path.join(A, 'backups'));
  ok('antigravity: the edited file is in the backup folder', backups.some((f) => f.endsWith('config/skills/plan-split/SKILL.md') && fs.readFileSync(path.join(A, 'backups', f), 'utf8') === 'EDITED BY SOMEONE'), backups.join(','));

  // dry run changes nothing
  const snap = JSON.stringify(walk(A).sort());
  r = run(ROUTER, ['antigravity', '--local', '--dry-run'], { AGY_GEMINI_DIR: A });
  ok('antigravity: dry run changes nothing', r.code === 0 && r.out.includes('[dry run]') && JSON.stringify(walk(A).sort()) === snap);
}

// ---------- Antigravity: a machine with the first (hand-copied) setup and unrelated config ----------
const B = fresh('agy-old');
const cfgB = path.join(B, 'config');
{
  const put = (rel, text) => { fs.mkdirSync(path.dirname(path.join(B, rel)), { recursive: true }); fs.writeFileSync(path.join(B, rel), text); };
  const legacy = ['config/scripts/plan-runner.js', 'config/scripts/plan-runner-2.js', 'config/scripts/validate-manifest.js', 'config/scripts/reminder_hook.js', 'config/skills/plan_feature/SKILL.md', 'config/agents/plan_auditor.md', 'config/agents/plan_cold_reader.md', 'config/agents/plan_reviewer.md'];
  for (const f of legacy) put(f, `old ${f}`);
  const mine = { 'config/config.json': '{"plugins":{"x":{"enabled":true}}}', 'config/mcp_config.json': '{"mcpServers":{}}', 'config/skills/other/SKILL.md': 'mine', 'config/agents/my-agent.md': 'mine', 'config/GEMINI.md': 'rules', 'antigravity-cli/settings.json': '{"permissions":{"allow":["command(*)"]}}', 'antigravity-cli/history.jsonl': 'history' };
  for (const [f, t] of Object.entries(mine)) put(f, t);
  put('config/hooks.json', JSON.stringify({ PreInvocation: [{ type: 'command', command: 'node C:\\Users\\someone\\.gemini\\config\\scripts\\reminder_hook.js', timeout: 5000 }], 'my-hook': { Stop: [{ command: 'node mine.js' }] } }));
  const r = run(ROUTER, ['antigravity', '--local'], { AGY_GEMINI_DIR: B });
  ok('old setup: install succeeds', r.code === 0 && r.out.includes(`${legacy.length} old file(s) removed`), r.out.slice(-600));
  ok('old setup: the known old files are gone', legacy.every((f) => !fs.existsSync(path.join(B, f))));
  ok('old setup: the empty plan_feature folder is gone', !fs.existsSync(path.join(cfgB, 'skills', 'plan_feature')));
  ok('old setup: unrelated files are untouched', Object.entries(mine).every(([f, t]) => fs.readFileSync(path.join(B, f), 'utf8') === t));
  const hooks = JSON.parse(fs.readFileSync(path.join(cfgB, 'hooks.json'), 'utf8'));
  ok('old setup: the old reminder hook is removed, the user\'s own hook kept, ours added', !hooks.PreInvocation && hooks['my-hook']?.Stop?.[0]?.command === 'node mine.js' && hooks['kaviyarasu-plan-automation'], JSON.stringify(hooks));
  ok('old setup: hooks.json was backed up before the merge', walk(path.join(B, 'backups')).some((f) => f.endsWith('hooks.json')));

  // uninstall removes only what this installer added
  let u = run(ROUTER, ['antigravity', '--local', '--uninstall', '--dry-run'], { AGY_GEMINI_DIR: B });
  ok('uninstall dry run changes nothing', u.code === 0 && fs.existsSync(path.join(B, 'tools', 'plan-runner', 'run.mjs')));
  u = run(ROUTER, ['antigravity', '--local', '--uninstall'], { AGY_GEMINI_DIR: B });
  ok('uninstall: succeeds', u.code === 0, u.out.slice(-400));
  ok('uninstall: installed files are gone', !fs.existsSync(path.join(B, 'tools')) && !fs.existsSync(path.join(cfgB, 'skills', 'plan-split')) && !fs.existsSync(path.join(B, '.plan-automation-antigravity.json')));
  ok('uninstall: unrelated files are still untouched', Object.entries(mine).every(([f, t]) => fs.readFileSync(path.join(B, f), 'utf8') === t));
  const h2 = JSON.parse(fs.readFileSync(path.join(cfgB, 'hooks.json'), 'utf8'));
  ok('uninstall: only our hook entry was removed from hooks.json', !h2['kaviyarasu-plan-automation'] && h2['my-hook']);
  ok('uninstall: a second uninstall says there is nothing to remove', run(ROUTER, ['antigravity', '--local', '--uninstall'], { AGY_GEMINI_DIR: B }).code === 1);
}

// ---------- hooks.json that is not plain JSON is left alone ----------
{
  const D = fresh('agy-badjson');
  fs.mkdirSync(path.join(D, 'config'), { recursive: true });
  fs.writeFileSync(path.join(D, 'config', 'hooks.json'), '{ this is not json');
  const r = run(ROUTER, ['antigravity', '--local'], { AGY_GEMINI_DIR: D });
  ok('bad hooks.json: left alone with a manual snippet', r.code === 0 && fs.readFileSync(path.join(D, 'config', 'hooks.json'), 'utf8') === '{ this is not json' && /not plain JSON/.test(r.out) && r.out.includes('kaviyarasu-plan-automation'), r.out.slice(-500));
}

// ---------- an old cached copy of the Claude command that is given the word "antigravity" ----------
{
  const c = fresh('stale-claude');
  const a = fresh('stale-agy');
  const r = run(CLAUDE_INSTALL, ['--local', 'antigravity'], { CLAUDE_CONFIG_DIR: c, AGY_GEMINI_DIR: a });
  ok('stale cache: "antigravity" given to the Claude installer installs Antigravity, not Claude', r.code === 0 && fs.existsSync(path.join(a, 'tools', 'plan-runner', 'run.mjs')) && walk(c).length === 0, r.out.slice(-400));
}

// ---------- clone path: always install the newest files, and fall back when the clone fails ----------
{
  // a local git repo that holds a copy of this checkout, with a marker added to a payload file
  const origin = fresh('origin');
  for (const item of ['package.json', 'install-router.mjs', 'claude-plan-automation', 'antigravity-setup']) fs.cpSync(path.join(REPO, item), path.join(origin, item), { recursive: true, filter: (s) => !/node_modules|[\\/]\.git([\\/]|$)/.test(s) });
  const marker = path.join(origin, 'antigravity-setup', 'payload', 'config', 'skills', 'grill-me', 'SKILL.md');
  fs.appendFileSync(marker, '\nCLONE-MARKER\n');
  const g = (args) => spawnSync('git', args, { cwd: origin, encoding: 'utf8' });
  g(['init', '-q']); g(['add', '-A']); g(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'x']);
  const url = `file:///${origin.replace(/\\/g, '/').replace(/^\//, '')}`;

  const A2 = fresh('clone-agy');
  let r = run(AGY_INSTALL, [], { AGY_GEMINI_DIR: A2, KAVIYARASU_REPO_URL: url }); // no --local: it clones, then runs the installer from the clone
  const installed = path.join(A2, 'config', 'skills', 'grill-me', 'SKILL.md');
  ok('clone: the files come from the clone, not from the (possibly stale) bundled copy', r.code === 0 && fs.existsSync(installed) && fs.readFileSync(installed, 'utf8').includes('CLONE-MARKER'), r.out.slice(-500));
  ok('clone: no warning when the clone worked', !/Could not download/.test(r.out));

  const A3 = fresh('clone-fail');
  r = run(AGY_INSTALL, [], { AGY_GEMINI_DIR: A3, KAVIYARASU_REPO_URL: path.join(TMP, 'does-not-exist') });
  const bundled = path.join(A3, 'config', 'skills', 'grill-me', 'SKILL.md');
  ok('failed clone: warns and installs the bundled copy', r.code === 0 && /Could not download the latest files/.test(r.out) && fs.existsSync(bundled) && !fs.readFileSync(bundled, 'utf8').includes('CLONE-MARKER'), r.out.slice(-500));

  const C2 = fresh('clone-claude');
  r = run(CLAUDE_INSTALL, [], { CLAUDE_CONFIG_DIR: C2, KAVIYARASU_REPO_URL: url });
  ok('clone: the Claude installer still clones and installs 18 files', r.code === 0 && r.out.includes(`${CLAUDE_FILES} added`), r.out.slice(-400));
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`${pass}/${pass + fails.length} installer checks passed.`);
if (fails.length) { console.log(`FAILED:\n  - ${fails.join('\n  - ')}`); process.exit(1); }
