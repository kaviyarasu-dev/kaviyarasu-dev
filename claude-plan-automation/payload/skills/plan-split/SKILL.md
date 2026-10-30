---
name: plan-split
description: Turn an approved feature spec into a plan folder (manifest and plan files) that the unattended plan runner can execute, and have fresh agents check it. Phase 2 of 2.
argument-hint: <feature slug>
disable-model-invocation: true
---

You are the PLAN WRITER. Do NOT write application code. Do NOT commit.

Feature slug: $ARGUMENTS

START FROM FILES ONLY
Read docs/plans/<slug>/_planning/STATE.md. It must say phase: spec-approved (match it case-insensitively). If not, stop and
tell me to finish /plan-feature first. Then read the spec it points to, requirements.md
(Decisions and Assumptions), CLAUDE.md in every repo of this workspace, the CI workflow files
(.github/workflows) of every repo, and the code you need. Do not rely on any earlier chat.
Also read docs/plans/<slug>/ARCHITECTURE.md and _planning/research.md when they exist, and the Size in STATE.md.
Size L and XL need ARCHITECTURE.md: if it is missing, stop and tell me to finish /plan-feature first.

WHY
Each plan file is run by a fresh `claude -p` session with no memory and no way to ask questions,
and nobody is there to approve anything. A vague plan makes that session guess, and a wrong guess
can break everything after it. The runner (installed at $HOME/.claude/tools/plan-runner, or under the folder
named by CLAUDE_CONFIG_DIR) checks every plan with its
own commands and never trusts the session's "done".

FILE SPLITTING RULE (strict)
Each plan file costs one cold start of about 30 to 50 seconds plus tens of thousands of tokens.
- S and M features: write ONE plan file. Do not split small work into several files.
- Split only if (a) your turn estimate is over about 60, or (b) a step is irreversible or has an
  external side effect (a database migration, a third-party API call). That step becomes its own
  plan. L features always split.
- Every split point must be a green checkpoint. The earlier plan passes its own verify commands,
  and each plan stands alone: its own goal and verify, no reliance on chat memory.
- Inside one plan file, divide the work into numbered steps (### Step 1: ...). Each step has its own
  verify. The runner snapshots after each step (no commits), so a failure rolls back only the
  last step, and a retry resumes at the next step.

LARGE WORK (size L and XL; the validator enforces the manifest part)
A whole application is 30 to 100 plans, run over days. Each plan is built by a session that knows only the plan
folder, so the folder must carry the whole design.
- Write in epics, and keep your place on disk. First write EPICS.md in the plan folder: one line per epic (id E1,
  E2 ..., name, the research feature ids or spec requirements it delivers, its plan ids, its milestone). Set
  STATE.md "phase: splitting" and, after each epic is written, "Split progress: E<n> of E<m> written (plans
  001-0xx)". If the chat was compacted, re-read STATE.md, EPICS.md and manifest.json and go on from there.
- Plan 001 builds the skeleton from ARCHITECTURE.md: the folders and modules, config and env names (an
  .env.example), the database connection and migration tool, the contract file (for example OpenAPI) from the API
  section, the unit, integration and end-to-end test runners each with one smoke test, a health endpoint, lint
  and typecheck, and the CI workflow file. Its checks run the build, every test runner and the app's health
  endpoint. Plan 001 "freeze"s the test config files.
- Every later plan follows ARCHITECTURE.md (the runner puts it first in every session's reading list) and names
  the sections it relies on under "Read first". It never restates a decision differently.
- Tests: a plan that writes tests lists them under "freeze", so no later plan can weaken them. Each user journey of
  the spec gets an end-to-end test, written by the plan that completes the journey, and the journey tests run in
  "e2e_gates". Money, auth, permissions and order or payment flows get integration tests against the throwaway
  database, not only unit tests with mocks.
- Each epic ends with a milestone: its last plan id goes in "pause_after", and the runner stops there (after the
  full and end-to-end checks) so me can look at the app.
- The last epic is production readiness, one plan per item of the spec's "Production readiness" section (for
  example structured logging, metrics and health checks, rate limits, audit log, security headers, Dockerfile and
  deploy config, CI, runbook and README). Each with a real check. Deploying itself is never a step.

STEP 1 - Write docs/plans/<slug>/
1. INSTRUCTIONS.md - short, plain English, rules for every plan session:
   do only the plan you are given; never ask the user, and if blocked write the reason and what
   you tried to BLOCKED.md in this folder and stop; never commit, push or change git state; check
   the current state before changing anything, because a plan may be retried or resumed; follow
   CLAUDE.md (root cause, security, performance, edge cases, reuse); after each numbered step run
   the checkpoint command from your prompt and go on only when it prints CHECKPOINT <n> OK; run the
   plan's Acceptance commands before reporting done; read ARCHITECTURE.md and CONTEXT.md (when they exist)
   before the plan and follow ARCHITECTURE.md exactly; reuse what CONTEXT.md lists instead of writing it again;
   never change a frozen test or test config (when one fails, fix the code); in the final report list under
   "context" every module, interface, helper or convention later plans must reuse; never skip a step or a part of a step: anything
   the plan asks for that you did not do goes in "not_done" of the final JSON report (the run then
   stops so a person can decide); end with the final JSON report described in your prompt; do not
   edit manifest.json, HANDOFF.md, checkpoint or state files, .git/, the real .env, or agent settings
   (.claude/settings*.json, .claude/hooks, .claude/agents, .claude/skills, .claude/commands,
   .agents/hooks.json, .agents/hooks, .agents/skills); rule and doc files such as .claude/rules are
   fine; never change files outside the project folders; use the database named in the environment,
   never another one; run one command per Bash call (no cd, no && chains, no > into files: use the
   Write tool); treat a refused Bash call (git change, network, deploy, secret file) as "do the same
   work another way", not as "Bash is off" and never as a reason to drop the task; write BLOCKED.md
   only when the plan cannot be done without that command.
2. manifest.json - strict JSON, exactly this shape:
   { "feature": "<slug>",
     "defaults": { "max_attempts": 3, "max_turns": 60, "timeout_min": 45, "idle_min": 10, "model": "sonnet" },
     "full_gates_every": 5,
     "env": { "<KEY>": "<value for the throwaway test environment>" },
     "isolate": ["<KEY from env that must differ from the project's real value>"],
     "setup": [ { "repo": "<repo>", "cmd": "<command that creates the test database, applies migrations>" } ],
     "gates_each": [ { "repo": "<repo>", "cmd": "<lint or syntax command>", "if_changed": ["<repo>/**/*.php"] } ],
     "full_gates": [ { "repo": "<repo>", "cmd": "<full test or typecheck command>" } ],
     "permissions": { "deny": [] },
     "final_review": true,
     "size": "S, M, L or XL (from STATE.md)",
     "reset": [ { "repo": "<repo>", "cmd": "<command that rebuilds the throwaway test database from the current migrations>" } ],
     "deps_install": [ { "repo": "<repo>", "cmd": "<npm ci, composer install ...>" } ],
     "e2e_gates": [ { "repo": "<repo>", "cmd": "<command that starts the app and runs the end-to-end journey tests>", "timeout_min": 20 } ],
     "pause_after": [ "<last plan id of each epic>" ],
     "plan_review": true, "final_review_blocks": true,
     "plans": [ { "id": "001", "file": "001-name.md", "repos": ["<repo folder name>"],
                  "depends_on": [], "est_turns": 30, "model": "sonnet or opus (omit for the default)",
                  "allowed_paths": ["<repo>/<glob>"], "allow_extra": [],
                  "verify": [ "<command in the first repo>", { "repo": "<repo>", "cmd": "<command>" } ],
                  "steps": [ { "n": 1, "title": "...", "verify": ["<command that exits 0 when step 1 is right>"] } ],
                  "human_check": "optional: what only a person can check; goes in the report, never blocks" } ] }
   Rules for the manifest:
   - There is NO "gate": "manual". Plans must need no approval. A plan with a manual gate is invalid.
   - Plans may also have "epic": "E1", "freeze": ["<repo>/<test glob>"] (files later plans may not change) and
     "unfreeze": [...] (a later plan that truly must change a frozen file; say why in the plan).
   - Size L and XL: "size", "full_gates" (every test suite, the typecheck, the build, and a coverage threshold if the
     project has one), "full_gates_every": 3, "setup" and "reset" (from ARCHITECTURE.md's Testing section; reset runs
     before every session so a rolled-back try leaves no rows or migrations behind), "deps_install", "pause_after"
     and, for XL, "e2e_gates". "plan_review" and "final_review_blocks" default to true for L and XL: a separate
     read-only reviewer reads each plan's diff, and the final review's critical or high findings stop the run.
   - Fill env, isolate, setup, gates_each and full_gates from what you learned in the CI workflows
     and CLAUDE.md. If the backend needs a database, use a throwaway name that differs from the real
     one (the real name is in .env.example; for example <real>_test) and list that key under
     "isolate". Never copy a real secret into the manifest. Migrations run only against that
     throwaway database. If the project has no database, leave env, isolate and setup out.
   - "permissions" is optional: extra "allow" or "deny" rules for this project only (for example "Bash(docker *)").
     Leave it out unless the project needs it. "php_lint": false turns off the built-in PHP check for a project with no PHP.
   - Any language works: the runner allows all Bash except a deny list (git changes, network, deploy,
     publish, secret files). Put the project's own lint, compile and test commands in gates_each,
     full_gates and each verify. Dependency and lock files of every ecosystem may always change.
   - est_turns is your honest estimate. Use model "opus" only for a plan that is truly hard.
   - Commands run through the system shell. Use plain commands, no cd; the repo field sets the folder.
   - For checks on file contents or JSON use the runner's checker: node "{{runner}}/assert.mjs" has|none|count|exists|json ...
     ({{runner}} is filled in by the runner, so the plan folder holds no machine-specific path). A bad regex or a
     missing file exits 2, never 0, and the validator compiles every regex and checks every file before a run,
     so a check can never pass silently. Do not write your own assert script.
   - NO STEP MAY BE SKIPPABLE. Every step has its own non-empty "verify" (the validator refuses a step
     without one). That check must FAIL before the step is done and PASS after it: the runner runs every
     step check once before any work and reports a check that already passes as "weak". Cover every
     item the step asks for, not just one of them. "if_changed" is only for gates_each; in a step or plan
     verify it would skip the check exactly when the work was skipped (the validator refuses it).
   - allowed_paths start with the repo folder name and list every file the plan creates or changes
     (a check on a file nobody lists is an error). A change outside them is allowed but listed in the
     report, so be complete. package.json and package-lock.json are always allowed, because installs are allowed.
   - Some files can never be changed by a session: .git/, the real .env and .env.* (the .env.example
     family is fine), the plan folder, agent settings, hooks, sub-agents and skills (.claude/settings*.json,
     .claude/hooks, .claude/agents, .claude/skills, .claude/commands, .agents/hooks.json, .agents/hooks,
     .agents/skills), and anything outside the project repos. A task that needs one of these is NOT a
     step: put it in "human_check" (with the exact text to paste), never in a step.
3. NNN-name.md - one per plan. Sections in this order, with these exact headings: Goal, Read first,
   Steps, Do not touch, Acceptance, If blocked, Report back. Under Steps use one heading per
   manifest step: "### Step 1: title", "### Step 2: title", and so on, in the same order and count
   as the manifest steps. Each plan file:
   - stands alone. Name every file to read, with its path. Do not write "as discussed".
   - is small enough: about 40 turns is ideal, 60 at most. If larger, split it at a green checkpoint.
   - has concrete steps. List every edge case; do not write "handle edge cases".
   - has at least one REAL runnable check: the project's own test command, a named test file, a
     script, a syntax check, or a key in an API response. Lint and typecheck alone are not enough.
   - if a needed test does not exist, writing that test is the plan's first step, with its path
     inside allowed_paths.
   - if it cannot be checked by a command at all (how a screen looks), still gets the closest
     machine check, and a "human_check" line.
   - carries every HIGH-RISK assumption that touches it, with a step that checks it.
   - lists, under each step, every item that step must deliver. Each item is covered by that step's
     verify, or (if a machine cannot check it) by "human_check". An item covered by neither can be
     skipped unnoticed.
   - under "Report back", says the session ends with the runner's final JSON report (every step done
     or not, "not_done", "different_from_plan" with a reason, "needs_person_check").
4. HANDOFF.md - one heading, "# Handoff". The runner appends to it after each plan.

STEP 2 - Script check (a machine, not a model)
Run: node $HOME/.claude/tools/plan-runner/validate.mjs docs/plans/<slug>
($HOME works in PowerShell and in Git Bash. Do not use ~: PowerShell does not expand it when it starts node.)
Show the output. Fix every ERROR and re-run until it prints VALID. Read every WARN and fix the
ones that matter. If the file does not exist, run the same checks by hand with commands: manifest
parses; ids unique; every file named exists; depends_on points only to earlier ids; every plan has
a non-empty verify and allowed_paths; every step is numbered 1..N, has a heading in the plan file and
its own non-empty verify with no if_changed; the plan file has no step the manifest does not list;
every file a verify names exists or is created by an allowed path; every regex in a verify compiles.

STEP 3 - Fresh review (do not review your own work)
a. Start one plan-cold-reader subagent per plan file, in parallel, at most 5 at a time. Give each
   only the folder path and its plan id. Each returns READY or NEEDS FIXES with its list of guesses.
b. Start one plan-auditor subagent. Give it the folder path and the spec path. It returns the
   coverage table and its findings. For XL: one plan-auditor per epic (give it the folder path, the spec path
   and the epic id; it audits that epic's plans), then one more for the whole folder with the instruction
   "cross-epic: architecture and contracts only" (every plan against ARCHITECTURE.md, and the interfaces between
   epics). Record each cold-reader verdict and each auditor finding as one line in _planning/split-review.md
   as it comes in, so a compacted chat does not lose them.
c. Fix every finding. Re-run only the cold readers for plans you changed, and the auditor once more.
   Maximum 2 rounds. Anything still open: list it for me honestly. Do not hide it.
d. After any fix, run the validator again.

STEP 4 - Show me
A table: id, epic, name, repo, depends on, est_turns, verify command, cold-reader verdict, milestone (pause_after). Then the open
items, every HIGH-RISK assumption, every "human_check", and the throwaway environment values.
Ask for approval and make the changes I ask for. Then set STATE.md: phase: plans-approved (write it exactly like that, lower-case, on its own line).

STEP 5 - Tell me how to run it
Say exactly: "Open a separate terminal in <primary repo> and run:
node $HOME/.claude/tools/plan-runner/run.mjs run <slug>
($HOME works in PowerShell and in Git Bash. Do not use ~.)
Both repos must have no uncommitted changes first. It never commits. When it stops, read
$HOME/.claude/plan-runs/<repo>__<slug>/REPORT.md: sections 1 to 3 first (done differently from the plan,
changed outside the plan, needs a person to check). Every failed try is in plans/<id>/failures.log. Fix the
cause in the plan file or the environment (not the code by hand) and run the same command again: it keeps
the steps that passed, re-checks them and goes on."
Do not start the runner yourself.
