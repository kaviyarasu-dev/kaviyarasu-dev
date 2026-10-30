// The tool-neutral runner files are copied from the Claude Code runner on purpose (the Claude payload and its public
// command stay untouched). This test fails when a copy drifts from its source, so a fix made on one side is not forgotten
// on the other. It also checks the planning skills and agents of both setups: /plan-audit and its subagent must be the same
// text apart from the named tool differences, and every STATE.md phase name must be spelled the same in every file that
// writes or reads it. Run: node tests/drift.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLAUDE = path.join(HERE, '..', '..', 'claude-plan-automation', 'payload', 'tools', 'plan-runner');
const AGY = path.join(HERE, '..', 'payload', 'tools', 'plan-runner');
const read = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');

// byte-for-byte copies (line endings aside)
const IDENTICAL = ['lib/git.mjs', 'lib/util.mjs', 'lib/system.mjs', 'lib/report.mjs', 'checkpoint.mjs', 'assert.mjs'];
// copies that differ only in one named place: each [pattern, replacement] is applied to BOTH sides before comparing
const SAME_AFTER = {
  'lib/gates.mjs': [[/import \{ killTree \} from '\.\/(?:claude|agy)\.mjs';/, "import { killTree } from './<cli>.mjs';"]],
  'lib/state.mjs': [
    [/\(~\/\.(?:claude|gemini)\/plan-runs\//, '(~/<tool>/plan-runs/'],
    [/export const RUNS_ROOT = .*\n/, 'export const RUNS_ROOT = <per-tool default>;\n'],
  ],
};

const problems = [];
let checked = 0;
for (const rel of IDENTICAL) {
  checked++;
  if (read(path.join(CLAUDE, rel)) !== read(path.join(AGY, rel))) problems.push(`${rel} differs from the Claude runner's copy`);
}
for (const [rel, subs] of Object.entries(SAME_AFTER)) {
  checked++;
  const norm = (s) => subs.reduce((t, [re, to]) => t.replace(re, to), s);
  if (norm(read(path.join(CLAUDE, rel))) !== norm(read(path.join(AGY, rel)))) problems.push(`${rel} differs from the Claude runner's copy beyond its one allowed difference`);
}

const runnerChecks = checked;
console.log(`${runnerChecks - problems.length}/${runnerChecks} shared runner files match the Claude runner.`);

// ---------- planning skills and agents ----------
const CPAY = path.join(HERE, '..', '..', 'claude-plan-automation', 'payload');
const APAY = path.join(HERE, '..', 'payload', 'config');
const CSKILL = (n) => path.join(CPAY, 'skills', n, 'SKILL.md');
const ASKILL = (n) => path.join(APAY, 'skills', n, 'SKILL.md');
const split = (text) => { const m = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/); return m ? { head: m[1], body: m[2] } : null; };
const field = (head, key) => (head.match(new RegExp(`^${key}:[ \\t]*(.*)$`, 'm')) || [])[1] || '';
let planning = 0;
const planningProblems = [];
const check = (cond, msg) => { planning++; if (!cond) planningProblems.push(msg); };

// the only places where the two /plan-audit texts may differ: [Claude text, Antigravity text]
const SKILL_SUBS = [
  ['$ARGUMENTS', 'The text the user typed after /plan-audit.'],
  ['(Read, Grep and Glob)', '(view_file, grep_search, find_by_name and list_dir)'],
  ['AskUserQuestion', 'ask_question'],
  ['(Agent tool)', '(invoke_subagent)'],
  ['Run /clear, then /plan-research', 'Start a fresh agy session, then run /plan-research'],
];
const AGY_SUFFIX = ' Use ONLY when the user explicitly types /plan-audit. Never start it on your own.';
const normalise = (body, side) => SKILL_SUBS.reduce((t, sub, i) => t.split(sub[side]).join(`<sub${i}>`), body);

const cs = split(read(CSKILL('plan-audit')));
const as = split(read(ASKILL('plan-audit')));
check(cs && as, 'plan-audit/SKILL.md has no frontmatter on one side');
if (cs && as) {
  check(field(cs.head, 'name') === 'plan-audit' && field(as.head, 'name') === 'plan-audit', 'plan-audit: the skill name must be plan-audit on both sides');
  check(field(cs.head, 'disable-model-invocation') === 'true' && !!field(cs.head, 'argument-hint'), 'plan-audit (Claude): needs disable-model-invocation: true and an argument-hint');
  check(field(as.head, 'description').endsWith(AGY_SUFFIX) && field(as.head, 'description').slice(0, -AGY_SUFFIX.length) === field(cs.head, 'description'), 'plan-audit: the descriptions differ beyond the Antigravity "Use ONLY when the user explicitly types" suffix');
  check(normalise(cs.body, 0) === normalise(as.body, 1), 'plan-audit: the Claude and Antigravity skill bodies differ beyond the allowed tool-name substitutions');
  for (const [i, sub] of SKILL_SUBS.entries()) check(cs.body.includes(sub[0]) && as.body.includes(sub[1]), `plan-audit: substitution ${i} (${sub[0]}) is no longer used on both sides`);
}

const ca = split(read(path.join(CPAY, 'agents', 'plan-module-auditor.md')));
const aa = split(read(path.join(APAY, 'agents', 'plan-module-auditor.md')));
check(ca && aa, 'plan-module-auditor.md has no frontmatter on one side');
if (ca && aa) {
  const cTools = field(ca.head, 'tools').split(',').map((t) => t.trim()).filter(Boolean);
  const aTools = [...aa.head.matchAll(/^ {2}- (\S+)$/gm)].map((m) => m[1]);
  check(field(ca.head, 'description') === field(aa.head, 'description'), 'plan-module-auditor: the descriptions differ');
  check(cTools.length > 0 && cTools.every((t) => ['Read', 'Grep', 'Glob', 'Write'].includes(t)), `plan-module-auditor (Claude): tools must stay read-only plus Write for its one report, got ${cTools.join(', ')}`);
  check(aTools.length > 0 && aTools.every((t) => ['view_file', 'grep_search', 'list_dir', 'find_by_name', 'write_to_file'].includes(t)) && field(aa.head, 'commandExecutionPolicy') === 'off', `plan-module-auditor (Antigravity): tools must stay read-only plus write_to_file, with commandExecutionPolicy: off, got ${aTools.join(', ')}`);
  check(aa.body.replace(/^# Plan module auditor\n+/, '\n') === ca.body, 'plan-module-auditor: the Claude and Antigravity agent bodies differ');
}

// STATE.md phases: the same names everywhere, and each phase is named where the flow writes or reads it
const PHASES = ['audit', 'audit-approved', 'research', 'research-approved', 'interview', 'review', 'spec-approved', 'splitting', 'plans-approved'];
const SKILLS = ['plan-audit', 'plan-research', 'plan-feature', 'plan-split', 'plan-replan'];
const phaseTokens = (text) => new Set([...text.matchAll(/phase:\s*([a-z][a-z-]*)/g)].map((m) => m[1]));
for (const name of SKILLS) {
  const c = phaseTokens(read(CSKILL(name)));
  const a = phaseTokens(read(ASKILL(name)));
  const unknown = [...c, ...a].filter((p) => !PHASES.includes(p));
  check(unknown.length === 0, `${name}: uses a phase name that is not in the list (${unknown.join(', ')})`);
  check([...c].sort().join() === [...a].sort().join(), `${name}: the Claude skill uses phases [${[...c].sort()}] but the Antigravity skill uses [${[...a].sort()}]`);
}
const FLOW = { // phase -> the skills that must name it: the one that sets it and the ones that read it
  'audit-approved': ['plan-audit', 'plan-research', 'plan-feature'],
  'research-approved': ['plan-research', 'plan-feature'],
  'spec-approved': ['plan-feature', 'plan-split'],
  'plans-approved': ['plan-split'],
};
for (const [phase, names] of Object.entries(FLOW)) {
  for (const name of names) check(phaseTokens(read(CSKILL(name))).has(phase) && phaseTokens(read(ASKILL(name))).has(phase), `${name}: must name phase "${phase}" in both the Claude and the Antigravity skill`);
}
check(/phase: plans-approved/.test(read(path.join(CLAUDE, 'run.mjs'))) && /phase: plans-approved/.test(read(path.join(AGY, 'run.mjs'))), 'run.mjs must require "phase: plans-approved" on both sides');
// the reminder hooks stay silent unless a plan is in progress: those phases (never an "-approved" one) must be listed in both
const IN_PROGRESS = ['audit', 'research', 'interview', 'review', 'splitting'];
const hookPhases = (text) => ((text.match(/\(([a-z]+(?:\|[a-z]+)+)\)/) || [])[1] || '').split('|');
const HOOKS = {
  claude: path.join(CPAY, 'hooks', 'planning-context.sh'),
  antigravity: path.join(APAY, 'scripts', 'planning-context.mjs'),
};
for (const [side, file] of Object.entries(HOOKS)) check(hookPhases(read(file)).join() === IN_PROGRESS.join(), `the ${side} planning-context hook must watch [${IN_PROGRESS}], not [${hookPhases(read(file))}]`);

console.log(`${planning - planningProblems.length}/${planning} planning skill, agent and phase checks agree.`);
problems.push(...planningProblems);
if (problems.length) {
  console.log(`DRIFT:\n  - ${problems.join('\n  - ')}\nCopy the fix to the other side (or, if it is on purpose, change the lists at the top of tests/drift.mjs).`);
  process.exit(1);
}
