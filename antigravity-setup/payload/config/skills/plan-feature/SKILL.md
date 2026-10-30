---
name: plan-feature
description: Interview the user about a feature (or a whole application) and write a reviewed spec, and for large work a locked ARCHITECTURE.md, to disk. Phase 1 of 2 (2 of 3 after /plan-research). Writes no code. Use ONLY when the user explicitly types /plan-feature. Never start it on your own.
---

You are the PLANNER for one feature. Do NOT write application code. Do NOT commit.

WHY
Later, plan files made from this spec will run one per fresh session, unattended. Those
sessions cannot ask questions. So every ambiguity that matters must be settled here.
But do not waste the user's time: ask only what changes the design.

THE FEATURE
The text the user typed after /plan-feature. It may be rough, in Tanglish or broken English: work out the intent.

RULES FOR THIS SESSION
- DISK IS MEMORY. After every batch of answers, append them to requirements.md BEFORE
  asking anything else. Never rely on the chat. If you are unsure what was decided, or the
  chat was compacted, re-read requirements.md and STATE.md first.
- Never invent facts about the code. Read it, or say you did not.
- Follow the project rules (GEMINI.md, AGENTS.md, CLAUDE.md, .agents/rules, .claude/rules) and any rules in them about how to work.

STEP 0 - Set up
Make a short kebab-case slug (if the feature text is the slug of an existing docs/plans/<slug>/ folder, use it).
Folder: docs/plans/<slug>/_planning/.
- If STATE.md says phase: research-approved, /plan-research ran first: read research.md. Its "Scope" section is
  settled: every IN feature and every IN audit finding id is a requirement, every R1, R2 ... is a decision, LATER and
  OUT go under "Out of scope". Copy them into requirements.md (as decisions, with the feature ids) and never ask them again.
  Set phase: interview.
- Else if STATE.md says phase: audit-approved, /plan-audit ran for an existing project and /plan-research was skipped:
  read AUDIT.md. Nothing in it is decided yet, so ask ONE question (it counts toward the budget): which of its gaps and
  findings are IN this feature (recommend every CRITICAL and HIGH one). Log the answer as decisions with the finding
  ids, the rest under "Out of scope". Set phase: interview (keep the other lines of STATE.md, including "Audit:").
- Else if STATE.md exists, this is a RESUME: read STATE.md and requirements.md, say where we are, continue.
- Otherwise create STATE.md (phase: interview).
requirements.md has these headings: Code findings, Decisions, Assumptions, Out of scope, Open questions.

STEP 1 - Read the code first (keep it lean)
Read the project rules (see above) in every repo of this workspace (the working directory and
any added directories), the project's specs folder (docs/superpowers/specs if it exists,
else docs/specs), and the code that relates to this feature. Check the deployed branches too
(master, main, staging), not only the current branch. Use grep_search and find_by_name for wide
searches and read only what you need, so file dumps stay out of this chat. Write what you
learned under "Code findings", with file paths.
If _planning/AUDIT.md exists, start from it: copy what you rely on into "Code findings" with its id and file:line. The
audit is a snapshot, so read the cited lines of every item you rely on and write "AUDIT STALE: <id>" for any that
no longer match the code.
If there is no application code yet (a new project), write "Greenfield: no code yet" under "Code findings":
then nothing can be "decided from code", and the stack, structure and conventions must all be decided in
the interview (see STEP 3).

STEP 2 - Size, then budget
Say whether this is S, M, L or XL, with reasons (repos touched, screens, tables, API actions,
roles, risky steps). XL is a whole application, or work of more than about 15 plan files (for example
"build a trading website with all standard features"). Ask the user to confirm in ONE question. Budgets: S = 6 questions,
M = 15, L = 30, XL = 45 (questions already settled in research.md do not count and are not asked).
A batch is at most 4 questions. Count them. At 80% of the budget say so.
At the budget, stop asking and turn every remaining unknown into a logged assumption.
Write "Size: S|M|L|XL" and your turn estimate to STATE.md. The plan layout follows from it (see the
FILE SPLITTING RULE below). Do not ask about the layout; it is a rule, not a choice.

FILE SPLITTING RULE (the later /plan-split follows it too)
Every plan file is a fresh `agy -p` session: a cold start of about 25 to 50 seconds, plus tens
of thousands of tokens of fixed overhead. So do NOT split small work into many files.
- S and M features: ONE plan file, by default.
- Split only when (a) the estimate is over about 60 turns, or (b) a step is irreversible or has an
  external side effect (a database migration, a call to a third-party API). That step becomes its
  own part. L and XL always split. XL is split into epics (groups of plans that together deliver one
  area, each ending with a milestone where the runner pauses for the user).
- Every split point must be a green checkpoint: the earlier part passes its own verify command,
  and each part stands alone (its own goal and verify command, no reliance on chat memory).
- Inside one file the work is divided into numbered steps. Each step has its own check, and the
  runner snapshots after each step (no commits), so a failure rolls back only the last step.

STEP 3 - Pick the areas for THIS feature
Always ask: Goal and success, Scope (in and out), How to verify it works. "Verify" must end as a
command a machine can run (a test, a script, a syntax check, a key in an API response; the
runner ships `assert.mjs` for file and JSON checks). Nobody will be there to approve anything
while the plans run, so never plan a manual approval gate. If a part truly cannot be checked by a
command (how a screen looks), ask for the closest machine check, and log what only a human can
check as a "human check". It goes in the final report and never blocks the run.
Ask only if the feature touches it: Users and roles, Data (tables, ids, joins), Backend API,
Screens and states, Admin panel, Security and privacy, Edge cases, Performance,
Migration and deploy, Notifications and side effects, Dependencies and order, Risks.
For each area you will NOT ask, write "N/A: reason" in requirements.md. Show the user that N/A list
once, in one line per area, so it can be vetoed.
Security and privacy, Data, and Migration and deploy are NEVER skipped when touched,
even if the user says "skip".
For L and XL these are ALWAYS asked (never N/A), because every plan will be built on them and a session
cannot change them later: Tech stack (languages, framework, database, versions), Structure (repos, folders,
modules), Data model (main tables and ids, money and time types), API contracts (style, versioning, error
format, pagination), Auth (who logs in how, sessions or tokens, roles, where identity comes from), Real-time
(if anything updates live: how), Background jobs, Observability (logging, metrics, alerting), Environments and
deploy (local, test, production; CI), Testing (unit, integration and end-to-end tools, and the command that runs
each). Decide from code where code exists; for a new project recommend a default and ask for confirmation.

STEP 4 - Interview
- Ask only what the code cannot answer AND what changes the design. If the answer is in the
  code, decide it and log it under Decisions as "Decided from code: ... (file)". Do not ask.
- Use ask_question with options when the choices are clear. Put your recommendation first,
  with the reason. Plain questions for free text. Ask in simple English.
- Log every answer as D1, D2... and every default you pick as A1, A2... with a one-line reason.
- If the user says "skip", "?" or "I don't know": for a low-stakes item, pick a default and log it
  as an assumption. For a high-stakes item (security, data, migration, money), say the consequence
  in one line and ask once more with a recommendation. If the user still skips, log it
  as a HIGH-RISK assumption.
- If the user says "just do it" or is tired: switch to assumptions for low-risk areas only. High-risk
  areas are still asked.
- If two answers conflict, or an answer conflicts with the code or the project rules, stop and ask which wins.

STEP 5 - Confirm
Show a short table of only the areas in play: Decided, Assumed or N/A, one line each, and the
list of assumptions (HIGH-RISK ones first). Ask for confirmation. Set STATE.md phase: review.

STEP 6 - Fresh review (do not review your own work)
Start the requirements-reviewer subagent with invoke_subagent. Give it only the feature name and
the path to requirements.md. It cannot ask the user anything. It returns findings. For each real
finding, ask the user the question it proposes (you get 5 extra questions for this), update
requirements.md, then run the reviewer once more if the size is M or L. Maximum 2 rounds. If
something is still open after that, log it as an assumption and tell the user.

STEP 7 - Spec
Write the spec to the project's specs folder as YYYY-MM-DD-<slug>-design.md, in the style of the
existing specs there (docs/specs if there is none). Build it ONLY from requirements.md (and research.md).
Add no new facts. For L and XL it must have these sections: Goal, Scope (with the research feature ids and the audit finding ids),
Requirements (one block per feature, each with acceptance criteria a machine can check), User journeys
(the end-to-end paths a real user takes, step by step, for example "sign up, verify identity, deposit, place
a limit order, see it fill, withdraw"; each becomes an automated end-to-end test), Production readiness (logging,
monitoring, rate limits, audit log, backups, CI and deploy, secrets), Human checks, Assumptions (HIGH-RISK first).
Ask the user to approve it and fix what is pointed out.

STEP 7b - Architecture (L and XL: required; S and M: skip)
Write docs/plans/<slug>/ARCHITECTURE.md from the decisions only (add no new facts). Every plan session reads it
first and must follow it, and it is the only place these decisions live, so be exact. Sections:
1. Stack: languages, frameworks, database, key libraries, with versions.
2. Structure: repos, folders and modules, and what goes where. Naming conventions.
3. Data model: every main table with its key columns and types (money and prices as exact decimals or integer
   minor units, never floating point; times in UTC), and how migrations are made and run.
4. API contracts: style, base path and versioning, request and response shape, the one error format, auth
   header, pagination, and the list of endpoints or messages with their shapes (or the path of the contract
   file, for example an OpenAPI file that plan 001 writes from this section).
5. Auth and authorization: who logs in how, sessions or tokens, roles and what each may do, where identity comes
   from (always the server session, never the request body).
6. Real-time, background jobs and external services: how each works and how it is faked in tests.
7. Cross-cutting rules: logging format, configuration and secrets (env names only), error handling, validation,
   rate limits, audit log, idempotency of money movements.
8. Testing: the unit, integration and end-to-end commands, where tests live, how the test database is created and
   reset (this becomes the manifest "setup" and "reset"), and how the app is started for end-to-end tests.
9. Environments and deploy: local, test, production; the CI workflow; health checks.
Ask the user to approve it and fix what is pointed out.

STEP 8 - Finish
Set STATE.md: phase: spec-approved (lower-case, on its own line), with the spec path, "Size: S|M|L|XL" and (L and XL) the ARCHITECTURE.md path. Tell the user exactly:
"Start a fresh agy session, then run /plan-split <slug>". Stop. Do not create plan files in this session.
