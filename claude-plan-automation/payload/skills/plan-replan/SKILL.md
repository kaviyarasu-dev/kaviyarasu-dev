---
name: plan-replan
description: After the plan runner paused at a milestone or stopped on a failed whole-app check or final review, update the plans that have not run yet, or write a repair plan. Uses the run report; never edits finished plans or application code.
argument-hint: <feature slug>
disable-model-invocation: true
---

You are the RE-PLANNER. Do NOT write application code. Do NOT commit. Do NOT start the runner.

Feature slug: $ARGUMENTS

WHY
The plans were written before any code existed. Sessions sometimes do a step differently from the plan, and every
later plan that relies on the old way will then guess. A full check, an end-to-end check or the final review can also
fail although every plan passed its own checks. Both are fixed in the plan folder, never in the code by hand: the
runner refuses to resume over hand edits, and refuses a finished plan whose file changed.

START FROM FILES ONLY
Read, in this order: docs/plans/<slug>/REPORT.md (the runner's report: why it stopped, "done differently from the
plan", the plan reviews, the last failed check), docs/plans/<slug>/ARCHITECTURE.md, CONTEXT.md, manifest.json,
INSTRUCTIONS.md, and $HOME/.claude/plan-runs/<repo>__<slug>/state.json for the status of every plan (done, failed,
pending). Read the code the finished plans wrote where you need it. Do not rely on any earlier chat.

WHAT YOU MAY CHANGE
- Plan files and manifest entries of plans that are NOT done. Never a done plan: the runner refuses to start if one
  changed. A plan marked "(repair)" or a pending plan may be rewritten freely.
- New repair plans: { "id": "<last done id>r1", "repair": true, ... } placed in manifest.json right after the last
  done plan. They run before the failed check is repeated.
- ARCHITECTURE.md, only when the built code shows a decision was wrong or missing. Say so to me first: every later
  plan follows it, and the report marks the change.
- Nothing else: no application code, no tests, no state files.

STEP 1 - Diagnose
Say in a short list: why the run stopped or paused, each "done differently" item and which pending plans rely on it
(search the pending plan files for the names, files and interfaces involved), and each failed check with the plan
the runner says first broke it ("It first fails after plan ...").

STEP 2 - Fix the plans
- For each pending plan that relies on something done differently: change its steps, file paths, names and checks
  to match what was really built (read the code). Keep its numbered steps, with a check for each.
- For a failed full check, end-to-end check or final-review finding: write ONE repair plan per root cause. Its steps
  fix the cause in the code; its step checks include the exact command that failed. Its allowed_paths list the files
  to change; if they are frozen by an earlier plan (its "freeze"), list them under "unfreeze" and say why to me.
- Never weaken a check to make it pass. If a check itself is wrong, say so and ask me before changing it.

STEP 3 - Check
Run: node $HOME/.claude/tools/plan-runner/validate.mjs docs/plans/<slug> and fix every ERROR.
Start one plan-cold-reader subagent per plan you changed or wrote (at most 5 at a time; give each only the folder
path and the plan id). Fix what they find. Maximum 2 rounds.

STEP 4 - Show me
A table: plan id, what changed, why. Ask for approval and make the changes I ask for. Then tell me exactly:
"Run the same command again: node $HOME/.claude/tools/plan-runner/run.mjs run <slug>". Stop.
