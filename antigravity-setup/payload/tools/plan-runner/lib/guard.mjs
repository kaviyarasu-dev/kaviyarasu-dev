// PreToolUse hook. agy runs `node guard.mjs` before EVERY tool call of an unattended session (the runner
// writes hooks.json into the session's own throwaway HOME) and sends the call as JSON on stdin.
// We answer on stdout: {"decision":"deny","reason":...} refuses it, {"decision":"ask"} hands it back to the
// normal permission rules (which allow commands and file edits, see config/permissions.json).
// Fail closed: if anything is wrong here the call is refused, never allowed by accident.
// This file, rules.mjs and util.mjs are copied side by side next to guard-rules.json.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileRules, decide } from './rules.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = (o) => process.stdout.write(JSON.stringify(o));

try {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  const payload = JSON.parse(raw);
  const cfg = JSON.parse(fs.readFileSync(path.join(here, 'guard-rules.json'), 'utf8'));
  const rules = compileRules(cfg.permissions, cfg.manifestDeny || [], { readOnly: !!cfg.readOnly });
  const verdict = decide(rules, payload.toolCall);
  if (verdict.decision === 'deny') {
    try {
      const line = { at: new Date().toISOString(), tool: payload.toolCall?.name, what: String(payload.toolCall?.args?.CommandLine ?? payload.toolCall?.args?.TargetFile ?? payload.toolCall?.args?.AbsolutePath ?? '').slice(0, 300), why: verdict.reason.slice(0, 160) };
      fs.appendFileSync(path.join(here, 'guard-denied.log'), `${JSON.stringify(line)}\n`);
    } catch { /* logging must never change the verdict */ }
  }
  out(verdict);
} catch (e) {
  out({ decision: 'deny', reason: `Refused by the plan runner: its safety check could not run (${String(e.message).slice(0, 120)}). Stop and write BLOCKED.md.` });
}
