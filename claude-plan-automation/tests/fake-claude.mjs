// A fake `claude -p` for chaos tests. It speaks the same stream-json and misbehaves on demand.
// Config (env FAKE_CFG): { "<planId>": { "modes": ["ok","lie",...], "files": [["repo/rel/path","content"], ...] } }
// The Nth session of a plan uses modes[N-1] (the last mode repeats).
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const prompt = fs.readFileSync(0, 'utf8');
const cfg = JSON.parse(fs.readFileSync(process.env.FAKE_CFG, 'utf8'));
fs.appendFileSync(`${process.env.FAKE_CFG}.args.log`, `${JSON.stringify(process.argv.slice(2))}\n`);

const planId = (/running plan (\S+) of feature/.exec(prompt) || [])[1];
const emit = (o) => console.log(JSON.stringify(o));
let mid = 0;
const sid = 'fake-session';

if (!planId) { // the final review session
  emit({ type: 'system', subtype: 'init', model: 'fake', tools: [] });
  emit({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, result: 'no findings', total_cost_usd: 0, session_id: sid });
  process.exit(0);
}

const plan = cfg[planId] || { modes: ['ok'], files: [] };
const cnt = `${process.env.FAKE_CFG}.cnt.${planId}`;
const n = (fs.existsSync(cnt) ? Number(fs.readFileSync(cnt, 'utf8')) : 0) + 1;
fs.writeFileSync(cnt, String(n));
const mode = plan.modes[Math.min(n, plan.modes.length) - 1];
fs.appendFileSync(`${process.env.FAKE_CFG}.prompts.log`, `=== plan ${planId} session ${n} mode ${mode}\n${prompt}\n`);

const S = process.env.PLAN_RUNNER_SESSION ? JSON.parse(fs.readFileSync(process.env.PLAN_RUNNER_SESSION, 'utf8')) : null;
const cp = (/node "([^"]+checkpoint\.mjs)"/.exec(prompt) || [])[1];
const planDir = (/write BLOCKED\.md in (\S+) with/.exec(prompt) || [])[1];

emit({ type: 'system', subtype: 'init', model: 'fake', tools: ['Read', 'Edit', 'Write', 'Bash'] });
emit({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } });
console.error(`fake claude: plan ${planId} session ${n} mode ${mode}`);

const say = (text) => emit({ type: 'assistant', message: { id: `m${++mid}`, content: [{ type: 'text', text }] } });
const tool = (name, input) => { const id = `t${++mid}`; emit({ type: 'assistant', message: { id: `m${mid}`, content: [{ type: 'tool_use', id, name, input }] } }); return id; };
/** The fixed-format report: every step of this session done, unless `over` says otherwise. */
const report = (over = {}) => ({
  steps: Array.from({ length: Math.max(0, S.steps.length - S.resumeFrom + 1) }, (_, i) => ({ n: S.resumeFrom + i, done: true, reason: '' })),
  not_done: [], different_from_plan: [], needs_person_check: [], summary: `fake summary for plan ${planId}`, ...over,
});
const result = (text = 'done', extra = {}, rep = report()) => emit({ type: 'result', subtype: 'success', is_error: false, num_turns: mid, result: text, total_cost_usd: 0.01, session_id: sid, ...(rep ? { structured_output: rep } : {}), ...extra });

function writeRel(rel, content) {
  const [repo, ...rest] = rel.split('/');
  const abs = repo in S.repos ? path.join(S.repos[repo], ...rest) : path.join(path.dirname(S.repos[Object.keys(S.repos)[0]]), repo, ...rest);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  tool('Write', { file_path: abs });
}
async function doStep(i) {
  const f = plan.files[i - 1];
  if (f) writeRel(f[0], f[1]);
  const beat = setInterval(() => emit({ type: 'system', subtype: 'heartbeat' }), 2000); // like a long tool call that still streams
  const r = await new Promise((resolve) => {
    const c = spawn('node', [cp, String(i)], { env: process.env });
    let out = '';
    c.stdout.on('data', (d) => { out += d; });
    c.stderr.on('data', (d) => { out += d; });
    c.on('close', () => resolve(out));
  });
  clearInterval(beat);
  emit({ type: 'user', message: { content: [{ type: 'tool_result', content: r }] } });
  return /CHECKPOINT \d+ OK/.test(r);
}
const doAll = async () => { for (let i = S.resumeFrom; i <= S.steps.length; i++) if (!(await doStep(i))) return false; return true; };
const sleepForever = () => setInterval(() => {}, 1000);

switch (mode) {
  case 'ok': {
    say(`starting plan ${planId}`);
    if (!(await doAll())) { result('a checkpoint refused', {}, null); process.exit(0); }
    result('all steps done');
    break;
  }
  case 'lie': say('I did everything, trust me.'); result('done'); break;
  case 'question': say('Which database should I use?'); result('Which database should I use?', {}, null); break;
  case 'scope': await doAll(); writeRel('toyapp/.claude/settings.json', '{"permissions":{"allow":["Bash"]}}'); result('done'); break;
  case 'outside': await doAll(); writeRel('toyapp/notes/extra.txt', 'x'); writeRel('toyapp/.claude/rules/new-rule.md', '# rule'); result('done'); break;
  case 'secret': writeRel('toyapp/.env', 'DB_NAME=hacked\n'); result('done'); break;
  case 'lockfile':
    await doAll();
    writeRel('toyapp/Cargo.lock', 'lock'); writeRel('toyapp/go.sum', 'sum'); result('done'); break;
  case 'hang': sleepForever(); break;
  case 'crash': process.exit(1); break;
  case 'badjson':
    console.log('garbage {{{ not json');
    console.log('');
    await doAll();
    result('done despite noise');
    break;
  case 'limit': {
    const resetsAt = Math.floor(Date.now() / 1000) + 2;
    emit({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt, rateLimitType: 'five_hour' } });
    emit({ type: 'result', subtype: 'success', is_error: true, api_error_status: 429, num_turns: 0, result: 'You have reached your usage limit', session_id: sid });
    process.exit(1);
    break;
  }
  case 'blocked':
    fs.writeFileSync(path.join(planDir, 'BLOCKED.md'), 'Cannot continue: the spec contradicts itself.');
    result('blocked');
    break;
  case 'overrun':
    for (let i = 0; i < 6; i++) say(`thinking ${i}`);
    await doStep(S.resumeFrom);
    setTimeout(() => { result('should have been stopped'); process.exit(0); }, 30000);
    break;
  case 'crash_after_step1': await doStep(S.resumeFrom); process.exit(1); break;
  case 'delete': fs.rmSync(path.join(S.repos.toyapp, 'src', 'index.js')); writeRel('toyapp/src/junk.js', 'x'); process.exit(1); break;
  case 'maxturns': say('running out'); emit({ type: 'result', subtype: 'error_max_turns', is_error: false, num_turns: 99, session_id: sid }); process.exit(1); break;
  // --- skip-related misbehaviour ---
  case 'partial': // does one step, then stops, honestly marking the steps it did not reach as not done
    await doStep(S.resumeFrom);
    result('Out of time.', {}, report({ steps: report().steps.map((s) => (s.n > S.resumeFrom ? { ...s, done: false, reason: 'not reached' } : s)) }));
    break;
  case 'partial_silent': await doStep(S.resumeFrom); result('All done.', {}, null); break; // the same, with no report at all
  case 'partial_notdone': // checkpoints one step, then says that very step is not really done
    await doStep(S.resumeFrom);
    result('Stopped.', {}, report({ steps: report().steps.map((s) => ({ ...s, done: false, reason: s.n === S.resumeFrom ? 'half of it is missing' : 'not reached' })) }));
    break;
  case 'notdone_last': // checkpoints every step, but reports that the last one is not really done
    await doAll();
    result('done', {}, report({ not_done: [{ step: S.steps.length, item: 'the second half of the last step', reason: 'a command was refused' }] }));
    break;
  case 'notdone_first': // checkpoints every step, but step 1 is marked not done
    await doAll();
    result('done', {}, report({ steps: report().steps.map((s) => (s.n === 1 ? { ...s, done: false, reason: 'could not write the test' } : s)) }));
    break;
  case 'noreport': await doAll(); result('All steps done, everything works.', {}, null); break;
  case 'textreport': await doAll(); result(`Done.\n\n\`\`\`json\n${JSON.stringify(report())}\n\`\`\``, {}, null); break;
  case 'deviation': await doAll(); result('done', {}, report({ different_from_plan: [{ step: 1, what: 'used unset() instead of imagedestroy()', reason: 'imagedestroy is deprecated' }], needs_person_check: ['open the page in a browser'] })); break;
  case 'deviation_noreason': await doAll(); result('done', {}, report({ different_from_plan: [{ step: 1, what: 'skipped the cache', reason: '' }] })); break;
  case 'otherrepo': await doAll(); writeRel('otherrepo/touched.txt', 'x'); result('done'); break;
  case 'headmove':
    await doAll();
    spawnSync('git', ['-c', 'user.name=x', '-c', 'user.email=x@x', 'commit', '--allow-empty', '-m', 'sneaky'], { cwd: S.repos.toyapp });
    result('done');
    break;
  case 'refused': {
    const id = tool('Bash', { command: 'cd /x && php migrate.php' });
    emit({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: true, content: "Permission to use Bash has been denied because Claude Code is running in don't ask mode." }] } });
    await doAll();
    result('done');
    break;
  }
  default: result('unknown mode', {}, null);
}
