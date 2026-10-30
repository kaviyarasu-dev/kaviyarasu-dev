// The final report every plan session must give, in a fixed shape the runner can check.
// A session saying "done" in free text is not enough: it must say, step by step, what it did not do,
// what it did differently from the plan, and what only a person can check. Same file in both runners.

export const REPORT_SCHEMA = {
  type: 'object',
  properties: {
    steps: {
      type: 'array',
      items: {
        type: 'object',
        properties: { n: { type: 'integer' }, done: { type: 'boolean' }, reason: { type: 'string' } },
        required: ['n', 'done', 'reason'],
      },
    },
    not_done: {
      type: 'array',
      items: {
        type: 'object',
        properties: { step: { type: 'integer' }, item: { type: 'string' }, reason: { type: 'string' } },
        required: ['step', 'item', 'reason'],
      },
    },
    different_from_plan: {
      type: 'array',
      items: {
        type: 'object',
        properties: { step: { type: 'integer' }, what: { type: 'string' }, reason: { type: 'string' } },
        required: ['step', 'what', 'reason'],
      },
    },
    needs_person_check: { type: 'array', items: { type: 'string' } },
    context: {
      type: 'array',
      items: {
        type: 'object',
        properties: { key: { type: 'string' }, text: { type: 'string' } },
        required: ['key', 'text'],
      },
    },
    summary: { type: 'string' },
  },
  required: ['steps', 'not_done', 'different_from_plan', 'needs_person_check', 'summary'],
};

/** What a read-only reviewer (the per-plan review and the final review) must answer. */
export const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['pass', 'fail'] },
    problems: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
          file: { type: 'string' },
          problem: { type: 'string' },
          fix: { type: 'string' },
        },
        required: ['severity', 'problem'],
      },
    },
    summary: { type: 'string' },
  },
  required: ['verdict', 'problems'],
};
const BLOCKING = ['critical', 'high'];

/** The prompt section that asks for the report. */
export function reportInstructions(firstStep, stepCount) {
  const range = firstStep === stepCount ? `step ${stepCount}` : `steps ${firstStep} to ${stepCount}`;
  return `FINAL REPORT (required, the runner checks it): end with ONE JSON object, in a \`\`\`json block, with exactly these keys:
{"steps":[{"n":${firstStep},"done":true,"reason":""}],"not_done":[],"different_from_plan":[],"needs_person_check":[],"summary":"<your Report back section>"}
- "steps": one entry for every step from ${range}. "done": true only when EVERYTHING that step asks for is done; otherwise false, with the reason.
- "not_done": every thing the plan asks for that you did not do, as {"step": <number, 0 for the whole plan>, "item": "...", "reason": "..."}. Never leave one out: an item missing here is a skipped task. If anything is listed here, the run stops so a person can decide.
- "different_from_plan": everything you did in a different way than the plan says, as {"step": <number>, "what": "...", "reason": "<why, never empty>"}.
- "needs_person_check": things only a person can check (a browser, a phone, a real device). These are not "not_done".
- "context": what the NEXT sessions must know about what you built, so they reuse it instead of writing it again. One entry per module, public interface, shared helper, route group, table or convention you created or changed: {"key": "<area>: <name>", "text": "<where it lives, how to call or use it, in one or two lines>"}. Reuse the exact key of an entry in CONTEXT.md to replace it. Leave it empty only when you created nothing others will use.`;
}

/** The report from a structured-output field, or else the last JSON object in the session's final text. */
export function extractReport(structured, text, key = 'steps') {
  if (structured && typeof structured === 'object' && !Array.isArray(structured)) return structured;
  const t = String(text || '');
  const blocks = [...t.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map((m) => m[1]).reverse();
  for (const b of blocks) { const o = parseObject(b); if (o) return o; }
  const whole = parseObject(t);
  if (whole) return whole;
  const end = t.lastIndexOf('}');
  for (let i = t.lastIndexOf('{', end); i >= 0 && end > 0; i = t.lastIndexOf('{', i - 1)) {
    const o = parseObject(t.slice(i, end + 1));
    if (o && key in o) return o;
  }
  return null;
}
function parseObject(s) {
  try { const o = JSON.parse(String(s).trim()); return o && typeof o === 'object' && !Array.isArray(o) ? o : null; } catch { return null; }
}

const str = (v) => (typeof v === 'string' ? v.trim() : '');
const isStep = (v, max, allowZero) => Number.isInteger(v) && v <= max && v >= (allowZero ? 0 : 1);

/**
 * Checks a report against the plan. { ok:false, failure } when it is missing or malformed (a failed try);
 * else { ok:true, notDone, deviations, person, summary }. notDone holds every step marked not done and every not_done item.
 */
export function checkReport(rep, { firstStep, stepCount }) {
  const bad = (why) => ({ ok: false, failure: `the session's final report is missing or not valid: ${why}. Every session must end with the JSON report described in its prompt.` });
  if (!rep || typeof rep !== 'object') return bad('no JSON report was found in its final answer');
  for (const k of ['steps', 'not_done', 'different_from_plan', 'needs_person_check']) if (!Array.isArray(rep[k])) return bad(`"${k}" is not a list`);
  const notDone = [];
  for (let n = firstStep; n <= stepCount; n++) {
    const e = rep.steps.find((s) => s && s.n === n);
    if (!e) return bad(`"steps" has no entry for step ${n}`);
    if (typeof e.done !== 'boolean') return bad(`step ${n}: "done" must be true or false`);
  }
  for (const e of rep.steps) {
    if (!e || !isStep(e.n, stepCount, false)) return bad(`"steps" has an entry for a step that does not exist (${JSON.stringify(e?.n)})`);
    if (e.done === false) notDone.push({ step: e.n, item: `step ${e.n} is not done`, reason: str(e.reason) || '(no reason given)' });
  }
  for (const x of rep.not_done) {
    if (!x || !str(x.item)) return bad('a "not_done" entry has no "item"');
    notDone.push({ step: isStep(x.step, stepCount, true) ? x.step : 0, item: str(x.item), reason: str(x.reason) || '(no reason given)' });
  }
  const deviations = [];
  for (const x of rep.different_from_plan) {
    if (!x || !str(x.what)) return bad('a "different_from_plan" entry has no "what"');
    if (!str(x.reason)) return bad(`"different_from_plan" entry "${str(x.what).slice(0, 80)}" has no reason (a reason is required)`);
    if (!isStep(x.step, stepCount, false)) return bad(`"different_from_plan" entry "${str(x.what).slice(0, 80)}" names no valid step`);
    deviations.push({ step: x.step, what: str(x.what), reason: str(x.reason) });
  }
  const person = rep.needs_person_check.map(str).filter(Boolean);
  // optional: a malformed entry is dropped, never a failed try (the work itself was checked by the gates)
  const context = (Array.isArray(rep.context) ? rep.context : [])
    .filter((x) => x && str(x.key) && str(x.text))
    .map((x) => ({ key: str(x.key).slice(0, 120), text: str(x.text).slice(0, 600) }));
  return { ok: true, notDone, deviations, person, context, summary: str(rep.summary) };
}

/**
 * Checks a reviewer's answer. { ok:false, failure } when it is missing or malformed; else
 * { ok:true, blocking, problems, text } where blocking holds the critical and high problems
 * (a "fail" verdict with none of those still blocks, as one high problem).
 */
export function checkReview(rev) {
  if (!rev || typeof rev !== 'object' || !['pass', 'fail'].includes(rev.verdict) || !Array.isArray(rev.problems)) {
    return { ok: false, failure: 'the reviewer gave no valid JSON answer ({"verdict":"pass"|"fail","problems":[...]})' };
  }
  const problems = rev.problems.filter((p) => p && str(p.problem)).map((p) => ({
    severity: ['critical', 'high', 'medium', 'low'].includes(p.severity) ? p.severity : 'high',
    file: str(p.file), problem: str(p.problem), fix: str(p.fix),
  }));
  const blocking = problems.filter((p) => BLOCKING.includes(p.severity));
  if (rev.verdict === 'fail' && !blocking.length) blocking.push({ severity: 'high', file: '', problem: str(rev.summary) || 'the reviewer said "fail" without naming a critical or high problem', fix: '' });
  return { ok: true, blocking, problems, text: formatReview(problems, str(rev.summary)) };
}

export function formatReview(problems, summary = '') {
  const lines = problems.map((p) => `- **${p.severity}**${p.file ? ` ${p.file}` : ''}: ${p.problem}${p.fix ? `\n  Fix: ${p.fix}` : ''}`);
  return `${summary ? `${summary}\n\n` : ''}${lines.length ? lines.join('\n') : 'No findings.'}`;
}

/** Markdown lines for HANDOFF.md and REPORT.md. */
export function formatReport(r) {
  const L = [];
  if (r.notDone?.length) L.push('Not done:', ...r.notDone.map((x) => `- ${x.step ? `step ${x.step}` : 'plan'}: ${x.item} (${x.reason})`));
  if (r.deviations?.length) L.push('Done differently from the plan:', ...r.deviations.map((x) => `- step ${x.step}: ${x.what} (why: ${x.reason})`));
  if (r.person?.length) L.push('Needs a person to check:', ...r.person.map((x) => `- ${x}`));
  return L;
}
