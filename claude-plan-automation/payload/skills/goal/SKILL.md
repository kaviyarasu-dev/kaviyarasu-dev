---
name: goal
description: Keep working until the goal I give you is completely finished and proven, not just started.
argument-hint: <the goal, and how we will know it is done>
disable-model-invocation: true
---

Work on this goal until it is completely finished. Do not stop at "mostly done", and do not stop to ask me things you can find out yourself.

THE GOAL (rough is fine, work out the intent)
$ARGUMENTS

If the goal above is empty, ask me for it and wait. Otherwise do not wait for me.

1. DEFINE DONE FIRST
- Read the relevant code and docs first, so you only ask what they cannot answer.
- Write the goal as a short checklist where every item can be checked by running something (a test, lint, a command, a request, a file that must exist). Show me the checklist.
- Ask me only if the goal is unclear in a way that changes the result. Ask a few questions at once, then start.

2. WORK IN A LOOP
- Pick the next unfinished item, do it, run its check, read the real output.
- If a check fails, find the root cause and fix that. Do not weaken the check or hide the error to make it pass.
- Keep the checklist up to date as you go. Match the style of the code you edit and reuse what already exists.
- Keep going without asking permission between items.

3. STOP ONLY FOR THESE
- Everything on the checklist passes, and you have run the checks again at the end (see 4).
- You are blocked by something only I can do or decide: a missing secret or access, a choice that changes the outcome, or a risky step (deleting data, deploying, pushing, spending money). Say exactly what you need, then stop.
- You are going in circles: the same failure after 3 different fixes. Stop changing things, explain what you tried and what you think the cause is, then stop.

4. PROVE IT
- Run every check once more from the start. Say "done" only when they all pass in that last run.
- Finish with a short report: what you changed, the check results (real output, not "should work"), and anything you could not verify.

RULES
- Stay inside the goal. If you notice a related problem, report it. Fix it only if it is small and clearly part of the goal.
- Never commit or push unless the goal says so. Follow the project's own rules (CLAUDE.md).
- Never read or print secrets (`.env`, tokens, keys).
