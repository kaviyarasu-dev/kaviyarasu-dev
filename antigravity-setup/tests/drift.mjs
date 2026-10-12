// The tool-neutral runner files are copied from the Claude Code runner on purpose (the Claude payload and its public
// command stay untouched). This test fails when a copy drifts from its source, so a fix made on one side is not forgotten
// on the other. Run: node tests/drift.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLAUDE = path.join(HERE, '..', '..', 'claude-plan-automation', 'payload', 'tools', 'plan-runner');
const AGY = path.join(HERE, '..', 'payload', 'tools', 'plan-runner');
const read = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');

// byte-for-byte copies (line endings aside)
const IDENTICAL = ['lib/git.mjs', 'lib/util.mjs', 'lib/system.mjs', 'checkpoint.mjs'];
// copies that differ only in one named place: each [pattern, replacement] is applied to BOTH sides before comparing
const SAME_AFTER = {
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

console.log(`${checked - problems.length}/${checked} shared runner files match the Claude runner.`);
if (problems.length) {
  console.log(`DRIFT:\n  - ${problems.join('\n  - ')}\nCopy the fix to the other side (or, if it is on purpose, change the lists at the top of tests/drift.mjs).`);
  process.exit(1);
}
