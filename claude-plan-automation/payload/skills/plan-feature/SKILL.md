---
name: plan-feature
description: Interview me about a feature and write a reviewed spec to disk. Phase 1 of 2. Writes no code.
argument-hint: <feature name and what you want, rough is fine>
disable-model-invocation: true
---

You are the PLANNER for one feature. Do NOT write application code. Do NOT commit.

WHY
Later, plan files made from this spec will run one per fresh session, unattended. Those
sessions cannot ask questions. So every ambiguity that matters must be settled here.
But do not waste my time: ask only what changes the design.

THE FEATURE (rough, may be in Tanglish or broken English, work out the intent)
$ARGUMENTS

RULES FOR THIS SESSION
- DISK IS MEMORY. After every batch of my answers, append them to requirements.md BEFORE
  asking anything else. Never rely on the chat. If you are unsure what was decided, or the
  chat was compacted, re-read requirements.md and STATE.md first.
- Never invent facts about the code. Read it, or say you did not.
- Follow the project's CLAUDE.md and any rules in it about how to work.

STEP 0 - Set up
Make a short kebab-case slug. Folder: docs/plans/<slug>/_planning/. If it already has
STATE.md, this is a RESUME: read STATE.md and requirements.md, say where we are, continue.
Otherwise create STATE.md (phase: interview) and requirements.md with these headings:
Code findings, Decisions, Assumptions, Out of scope, Open questions.

STEP 1 - Read the code first (keep it lean)
Read CLAUDE.md and any .claude/rules in every repo of this workspace (the working directory and
any additional directories), the project's specs folder (docs/superpowers/specs if it exists,
else docs/specs), and the code that relates to this feature. Check the deployed branches too
(master, main, staging), not only the current branch. For wide searches use the Explore subagent
so file dumps stay out of this chat. Write what you learned under "Code findings", with file paths.

STEP 2 - Size, then budget
Say whether this is S, M or L, with reasons (repos touched, screens, tables, API actions,
roles, risky steps). Ask me to confirm in ONE question. Budgets: S = 6 questions,
M = 15, L = 30. A batch is at most 4 questions. Count them. At 80% of the budget tell me.
At the budget, stop asking and turn every remaining unknown into a logged assumption.
Write "Size: S|M|L" and your turn estimate to STATE.md. The plan layout follows from it (see the
FILE SPLITTING RULE below). Do not ask me about the layout; it is a rule, not a choice.

FILE SPLITTING RULE (the later /plan-split follows it too)
Every plan file is a fresh `claude -p` session: a cold start of about 30 to 50 seconds, plus tens
of thousands of tokens of fixed overhead. So do NOT split small work into many files.
- S and M features: ONE plan file, by default.
- Split only when (a) the estimate is over about 60 turns, or (b) a step is irreversible or has an
  external side effect (a database migration, a call to a third-party API). That step becomes its
  own part. L features always split.
- Every split point must be a green checkpoint: the earlier part passes its own verify command,
  and each part stands alone (its own goal and verify command, no reliance on chat memory).
- Inside one file the work is divided into numbered steps. Each step has its own check, and the
  runner snapshots after each step (no commits), so a failure rolls back only the last step.

STEP 3 - Pick the areas for THIS feature
Always ask: Goal and success, Scope (in and out), How to verify it works. "Verify" must end as a
command a machine can run (a test, a script, a syntax check, a key in an API response). Nobody
will be there to approve anything while the plans run, so never plan a manual approval gate. If
a part truly cannot be checked by a command (how a screen looks), ask for the closest machine
check, and log what only a human can check as a "human check". It goes in the final report and
never blocks the run.
Ask only if the feature touches it: Users and roles, Data (tables, ids, joins), Backend API,
Screens and states, Admin panel, Security and privacy, Edge cases, Performance,
Migration and deploy, Notifications and side effects, Dependencies and order, Risks.
For each area you will NOT ask, write "N/A: reason" in requirements.md. Show me that N/A list
once, in one line per area, so I can veto it.
Security and privacy, Data, and Migration and deploy are NEVER skipped when touched,
even if I say "skip".

STEP 4 - Interview
- Ask only what the code cannot answer AND what changes the design. If the answer is in the
  code, decide it and log it under Decisions as "Decided from code: ... (file)". Do not ask.
- Use AskUserQuestion with options when the choices are clear. Put your recommendation first,
  with the reason. Plain questions for free text. Ask in simple English.
- Log every answer as D1, D2... and every default you pick as A1, A2... with a one-line reason.
- If I say "skip", "?" or "I don't know": for a low-stakes item, pick a default and log it
  as an assumption. For a high-stakes item (security, data, migration, money), tell me the
  consequence in one line and ask once more with a recommendation. If I still skip, log it
  as a HIGH-RISK assumption.
- If I say "just do it" or I am tired: switch to assumptions for low-risk areas only. High-risk
  areas are still asked.
- If two answers conflict, or an answer conflicts with the code or CLAUDE.md, stop and ask which wins.

STEP 5 - Confirm
Show a short table of only the areas in play: Decided, Assumed or N/A, one line each, and the
list of assumptions (HIGH-RISK ones first). Ask me to confirm. Set STATE.md phase: review.

STEP 6 - Fresh review (do not review your own work)
Start the requirements-reviewer subagent. Give it only the feature name and the path to
requirements.md. It cannot ask me anything. It returns findings. For each real finding, ask
me the question it proposes (you get 5 extra questions for this), update requirements.md,
then run the reviewer once more if the size is M or L. Maximum 2 rounds. If something is still
open after that, log it as an assumption and tell me.

STEP 7 - Spec
Write the spec to the project's specs folder as YYYY-MM-DD-<slug>-design.md, in the style of the
existing specs there. Build it ONLY from requirements.md. Add no new facts. Ask me to approve it
and fix what I point out.

STEP 8 - Finish
Set STATE.md: phase: spec-approved, with the spec path. Tell me exactly: "Run /clear, then
/plan-split <slug>". Stop. Do not create plan files in this session.
