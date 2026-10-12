// agy PreInvocation hook (registered in ~/.gemini/config/hooks.json by the installer).
// Antigravity has no "after the chat was compacted" event, so this runs before model calls instead and stays
// silent unless a feature is still in the interview or review phase. Then it reminds the agent, now and then,
// that the planning files, not the chat, are the record of every decision.
// Input (stdin): { workspacePaths, invocationNum, ... }. Output (stdout): { injectSteps: [...] } or {}.
import fs from 'node:fs';
import path from 'node:path';

const out = (o) => process.stdout.write(JSON.stringify(o));
try {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  const input = JSON.parse(raw);
  const n = Number(input.invocationNum || 0);
  if (n > 1 && n % 8 !== 0) { out({}); process.exit(0); } // first call of a session, then every 8th call
  let newest = null;
  for (const ws of input.workspacePaths || []) {
    const plans = path.join(ws, 'docs', 'plans');
    let slugs = [];
    try { slugs = fs.readdirSync(plans); } catch { continue; }
    for (const slug of slugs) {
      const f = path.join(plans, slug, '_planning', 'STATE.md');
      try {
        const m = fs.statSync(f).mtimeMs;
        if (!newest || m > newest.m) newest = { f, m };
      } catch { /* no STATE.md in this folder */ }
    }
  }
  if (!newest || !/phase:\s*(interview|review)/i.test(fs.readFileSync(newest.f, 'utf8'))) { out({}); process.exit(0); }
  const d = path.dirname(newest.f).split(path.sep).join('/');
  out({ injectSteps: [{ ephemeralMessage: `A feature is being planned. Before you continue, re-read ${d}/STATE.md and ${d}/requirements.md. Those files, not the chat, are the record of every decision.` }] });
} catch {
  out({}); // a reminder must never block the agent
}
