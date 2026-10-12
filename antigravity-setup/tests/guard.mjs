// Offline tests for the deny rules (lib/rules.mjs) and the PreToolUse hook (lib/guard.mjs). No model usage.
// Run: node tests/guard.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { compileRules, decide } from '../payload/tools/plan-runner/lib/rules.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUNNER = path.join(HERE, '..', 'payload', 'tools', 'plan-runner');
const cfg = JSON.parse(fs.readFileSync(path.join(RUNNER, 'config', 'permissions.json'), 'utf8'));
const rules = compileRules(cfg);

let pass = 0;
const fails = [];
const ok = (name, cond, extra = '') => { if (cond) pass++; else fails.push(`${name} ${extra}`); };
const run = (cmd) => decide(rules, { name: 'run_command', args: { CommandLine: cmd, Cwd: 'C:\\ws' } });
const file = (tool, p, key = 'TargetFile') => decide(rules, { name: tool, args: { [key]: p } });

const DENY = [
  'git commit -m x', 'git commit --allow-empty -m probe', 'echo a && git commit -m x', 'cd x; git push origin HEAD', 'git -C . commit -m y',
  '& git add -A', '& "C:\\Program Files\\Git\\cmd\\git.exe" commit -m x', 'GIT_AUTHOR_NAME=x git commit', '(git push)', 'if ($true) { git reset --hard }',
  'git  checkout -b x', 'GIT checkout .', 'git branch feature', 'git branch -D old', 'git stash', 'git --git-dir=x log', 'git clone https://x/y',
  'git switch main', 'git merge x', 'git rebase main', 'git tag v1', 'git config user.name x', 'git rm a.txt', 'git remote add o u', 'git pull', 'git fetch',
  'echo hi | git apply; git commit -am x', '$(git push)', 'ls; git restore .', 'git am x.patch', 'git clean -fd',
  'curl http://x', 'curl.exe http://x', 'Invoke-WebRequest http://x', 'iwr http://x', 'irm http://x', "(New-Object Net.WebClient).DownloadString('x')", 'wget x', 'ssh host', 'scp a b:c', 'cd x && curl y',
  'rm -rf node_modules', 'rm -r x', 'rm -fr x', 'RM -RF x', 'rm -f -r x', 'rm --recursive x', 'Remove-Item x -Recurse -Force', 'Remove-Item -Recurse x', 'ri x -r', 'rmdir /s /q x', 'del /s x', 'find . -delete', 'echo a; rm -rf x',
  'cat .env', 'type .env', 'Get-Content .env.local', 'echo X > .env', 'cp .env x', 'node -e "require(\'fs\').readFileSync(\'.env\')"', 'Get-Content C:\\Users\\x\\.ssh\\id_rsa',
  'cat ~/.aws/credentials', 'cat id_rsa', 'type .npmrc', 'ls .git/', 'cat .git/config', 'Set-Content .agents/hooks.json x', 'dir .claude/', 'type C:\\Users\\x\\.gemini\\config\\hooks.json',
  'cat C:\\Users\\x\\.gemini\\plan-runs\\r__s\\state.json', 'dir C:\\run\\agy-home', 'cp a .env.production',
  'Start-Process git', 'powershell -c x', 'pwsh -c x', 'cmd /c dir', 'bash -c "git push"', 'npm publish', 'npm config get x', 'sudo x', 'docker push x', 'docker login', 'kubectl apply -f x',
  'Invoke-Expression "x"', 'iex x', 'Set-ExecutionPolicy Bypass', 'taskkill /f /im x', 'Stop-Process -Id 1', 'eas build', 'npx eas build', 'gh pr create', 'aws s3 ls', 'terraform apply',
  'Get-ItemProperty HKLM:\\Software', 'echo x | Out-File .ENV',
];
const ALLOW = [
  'git status --short', 'git diff HEAD~1 -- src/add.js', 'git log --oneline -5', 'git show HEAD:file', 'git branch --show-current', 'git branch', 'git branch -a', 'git rev-parse HEAD',
  'git ls-files', 'git grep foo', 'git blame x', 'git apply p.diff', 'git diff --stat', 'git diff -- src/reset.js', 'git status',
  'node -v', 'npm test', 'npm install', 'npm run lint', 'npm run build && node dist/index.js', 'node checkpoint.mjs 1', 'node "C:\\Users\\x\\.gemini\\tools\\plan-runner\\checkpoint.mjs" 2',
  'node -e "console.log(process.env.HOME)"', 'Get-Content .env.example', 'cat .env.sample', 'cat package.json', 'Get-ChildItem -Recurse src', 'rm file.txt', 'rm -f file.txt', 'Remove-Item x -Force',
  'del file.txt', 'echo ssh', 'echo hello', 'php -l a.php', 'composer install', 'pip install x', 'python -m pytest', 'go test ./...', 'cargo build', 'dotnet test',
  'mvn -q test', './gradlew test', 'make test', 'Select-String -Path a.txt -Pattern "x"', 'grep -rn "TODO" src', 'ls -la', 'mkdir x', 'cd x; npm test', 'node scripts/format.js', 'docker compose up -d',
  'docker build .', 'cat .github/workflows/ci.yml', 'ls .gitignore', 'type .gitattributes', 'Get-Content README.md', 'node scripts/env.js', 'npx jest --runInBand', 'rm -f a b', 'echo $env:FOO', 'sort az.txt',
  'node assert.mjs has src/a.js "foo\\(bar\\)"', 'npm ci', 'yarn install', 'pnpm test', 'git diff HEAD',
];
for (const c of DENY) ok(`deny: ${c}`, run(c).decision === 'deny', `-> ${run(c).decision}`);
for (const c of ALLOW) ok(`allow: ${c}`, run(c).decision === 'ask', `-> ${JSON.stringify(run(c)).slice(0, 160)}`);

const W = 'C:\\ws';
const FD = [
  ['write_to_file', `${W}\\.env`], ['write_to_file', `${W}\\.env.local`], ['write_to_file', `${W}\\app\\.ENV`], ['write_to_file', `${W}\\key.pem`], ['replace_file_content', `${W}\\.env`],
  ['multi_replace_file_content', `${W}\\.git\\config`], ['view_file', `${W}\\.env`], ['view_file', 'C:\\Users\\me\\.ssh\\id_rsa'], ['view_file', `${W}\\.git\\config`], ['view_file', `${W}\\deploy\\server.key`],
  ['write_to_file', `${W}\\.agents\\hooks.json`], ['write_to_file', 'C:\\Users\\me\\.gemini\\config\\x'], ['write_to_file', `${W}\\.claude\\settings.json`], ['sed_file', `${W}\\.env.production`],
];
const FA = [
  ['write_to_file', `${W}\\src\\a.php`], ['write_to_file', `${W}\\.env.example`], ['view_file', `${W}\\.env.example`], ['view_file', `${W}\\src\\x.js`], ['view_file', `${W}\\.agents\\skills\\x\\SKILL.md`],
  ['write_to_file', `${W}\\docs\\plans\\x\\BLOCKED.md`], ['replace_file_content', `${W}\\src\\env.js`], ['write_to_file', `${W}\\.github\\workflows\\ci.yml`], ['write_to_file', `${W}\\.gitignore`],
];
for (const [t, p] of FD) ok(`file deny: ${t} ${p}`, file(t, p).decision === 'deny');
for (const [t, p] of FA) ok(`file allow: ${t} ${p}`, file(t, p).decision === 'ask');
ok('grep query without separators is not a path', decide(rules, { name: 'grep_search', args: { SearchPath: W, Query: 'password', Includes: ['*.js'] } }).decision === 'ask');
ok('unknown tools fall through to the normal rules', decide(rules, { name: 'invoke_subagent', args: { x: '.env' } }).decision === 'ask');
ok('browser tool falls through (no allow rule, so agy refuses it)', decide(rules, { name: 'browser_input', args: {} }).decision === 'ask');

// manifest extras use the Claude spelling
const extra = compileRules(cfg, ['Bash(docker *)', 'Read(**/secrets/**)', 'Edit(**/vendor/**)', 'Weird(thing)']);
ok('manifest Bash rule', decide(extra, { name: 'run_command', args: { CommandLine: 'docker ps' } }).decision === 'deny');
ok('manifest Read rule', decide(extra, { name: 'view_file', args: { AbsolutePath: 'C:\\ws\\secrets\\a.txt' } }).decision === 'deny');
ok('manifest Edit rule blocks writes only', decide(extra, { name: 'write_to_file', args: { TargetFile: 'C:\\ws\\vendor\\a.php' } }).decision === 'deny' && decide(extra, { name: 'view_file', args: { AbsolutePath: 'C:\\ws\\vendor\\a.php' } }).decision === 'ask');
ok('unsupported manifest entries are reported', extra.unsupported.length === 1 && extra.unsupported[0] === 'Weird(thing)');
ok('refusal tells the session it is not "shell off"', /does NOT mean/.test(run('git commit').reason) && /BLOCKED\.md/.test(run('git commit').reason));

// the read-only mode used by the final review: reading is fine, nothing else is
const ro = compileRules(cfg, [], { readOnly: true });
ok('read-only: a command is refused', decide(ro, { name: 'run_command', args: { CommandLine: 'node -v' } }).decision === 'deny');
ok('read-only: a file write is refused', decide(ro, { name: 'write_to_file', args: { TargetFile: 'C:\\ws\\a.txt' } }).decision === 'deny');
ok('read-only: a file edit is refused', decide(ro, { name: 'replace_file_content', args: { TargetFile: 'C:\\ws\\a.txt' } }).decision === 'deny');
ok('read-only: reading a file is allowed', decide(ro, { name: 'view_file', args: { AbsolutePath: 'C:\\ws\\a.txt' } }).decision === 'ask');
ok('read-only: reading .env is still refused', decide(ro, { name: 'view_file', args: { AbsolutePath: 'C:\\ws\\.env' } }).decision === 'deny');
ok('normal mode is not read-only', decide(rules, { name: 'write_to_file', args: { TargetFile: 'C:\\ws\\a.txt' } }).decision === 'ask');

// the hook process itself: same answers over stdin/stdout, and it fails closed
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-test-'));
for (const f of ['guard.mjs', 'rules.mjs', 'util.mjs']) fs.copyFileSync(path.join(RUNNER, 'lib', f), path.join(dir, f));
const hook = (input) => spawnSync(process.execPath, [path.join(dir, 'guard.mjs')], { input, encoding: 'utf8', cwd: dir });
const call = (c) => JSON.stringify({ toolCall: { name: 'run_command', args: { CommandLine: c } }, conversationId: 'x' });
let r = hook(call('git commit -m x'));
ok('hook fails closed without guard-rules.json', JSON.parse(r.stdout).decision === 'deny' && /could not run/.test(JSON.parse(r.stdout).reason), r.stdout);
fs.writeFileSync(path.join(dir, 'guard-rules.json'), JSON.stringify({ permissions: cfg, manifestDeny: ['Bash(docker *)'] }));
r = hook(call('git commit -m x'));
ok('hook denies git commit', JSON.parse(r.stdout).decision === 'deny' && r.status === 0, r.stdout);
r = hook(call('docker ps'));
ok('hook applies the manifest rule', JSON.parse(r.stdout).decision === 'deny', r.stdout);
r = hook(call('node -v'));
ok('hook hands allowed commands back', JSON.parse(r.stdout).decision === 'ask', r.stdout);
r = hook('this is not json');
ok('hook fails closed on a garbage payload', JSON.parse(r.stdout).decision === 'deny', r.stdout);
fs.writeFileSync(path.join(dir, 'guard-rules.json'), JSON.stringify({ permissions: cfg, manifestDeny: [], readOnly: true }));
r = hook(call('node -v'));
ok('hook honours readOnly from guard-rules.json', JSON.parse(r.stdout).decision === 'deny' && /read-only/.test(JSON.parse(r.stdout).reason), r.stdout);
ok('hook logs refusals for the runner report', fs.readFileSync(path.join(dir, 'guard-denied.log'), 'utf8').split('\n').filter(Boolean).length >= 2);
fs.rmSync(dir, { recursive: true, force: true });

console.log(`${pass}/${pass + fails.length} guard checks passed (${DENY.length} deny, ${ALLOW.length} allow command cases).`);
if (fails.length) { console.log(`FAILED:\n  - ${fails.join('\n  - ')}`); process.exit(1); }
