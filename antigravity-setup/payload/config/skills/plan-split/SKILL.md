---
name: plan-split
description: Turn an approved feature spec into a plan folder (manifest and plan files) that the unattended plan runner can execute, and have fresh agents check it. Phase 2 of 2. Use ONLY when the user explicitly types /plan-split <slug>. Never start it on your own.
---

You are the PLAN WRITER. Do NOT write application code. Do NOT commit.

Feature slug: the text the user typed after /plan-split.

START FROM FILES ONLY
Read docs/plans/<slug>/_planning/STATE.md. It must say phase: spec-approved (match it case-insensitively). If not, stop and
tell the user to finish /plan-feature first. Then read the spec it points to, requirements.md
(Decisions and Assumptions), the project rules (GEMINI.md, AGENTS.md, CLAUDE.md) of every repo in this workspace,
the CI workflow files (.github/workflows) of every repo, and the code you need. Do not rely on any earlier chat.

WHY
Each plan file is run by a fresh `agy -p` session with no memory and no way to ask questions,
and nobody is there to approve anything. A vague plan makes that session guess, and a wrong guess
can break everything after it. The runner (installed at $HOME/.gemini/tools/plan-runner, or under the folder
named by AGY_GEMINI_DIR if the installer was run with it) checks every plan with its own commands and never
trusts the session's "done".

FILE SPLITTING RULE (strict)
Each plan file costs one cold start of about 25 to 50 seconds plus tens of thousands of tokens.
- S and M features: write ONE plan file. Do not split small work into several files.
- Split only if (a) your turn estimate is over about 60, or (b) a step is irreversible or has an
  external side effect (a database migration, a third-party API call). That step becomes its own
  plan. L features always split.
- Every split point must be a green checkpoint. The earlier plan passes its own verify commands,
  and each plan stands alone: its own goal and verify, no reliance on chat memory.
- Inside one plan file, divide the work into numbered steps (### Step 1: ...). Each step has its own
  verify. The runner snapshots after each step (no commits), so a failure rolls back only the
  last step, and a retry resumes at the next step.

STEP 1 - Write docs/plans/<slug>/
1. INSTRUCTIONS.md - short, plain English, rules for every plan session:
   do only the plan you are given; never ask the user, and if blocked write the reason and what
   you tried to BLOCKED.md in this folder and stop; never commit, push or change git state; check
   the current state before changing anything, because a plan may be retried or resumed; follow
   the project rules (root cause, security, performance, edge cases, reuse); after each numbered step run
   the checkpoint command from your prompt and go on only when it prints CHECKPOINT <n> OK; run the
   plan's Acceptance commands before reporting done; do not edit manifest.json, HANDOFF.md,
   checkpoint or state files, or anything under .agents/ or .gemini/; use the database named in the
   environment, never another one; treat a refused tool call (git change, network, deploy, secret file,
   recursive delete) as "skip it and carry on", not as "the shell is off"; write BLOCKED.md only when the plan cannot be done
   without that command; create and edit files with the file tools, not with shell redirects
   (the shell on Windows is PowerShell).
2. manifest.json - strict JSON, exactly this shape (the same shape the Claude Code runner uses, so one folder runs on either):
   { "feature": "<slug>",
     "defaults": { "max_attempts": 3, "max_turns": 60, "timeout_min": 45, "idle_min": 15, "model": "sonnet" },
     "full_gates_every": 5,
     "env": { "<KEY>": "<value for the throwaway test environment>" },
     "isolate": ["<KEY from env that must differ from the project's real value>"],
     "setup": [ { "repo": "<repo>", "cmd": "<command that creates the test database, applies migrations>" } ],
     "gates_each": [ { "repo": "<repo>", "cmd": "<lint or syntax command>", "if_changed": ["<repo>/**/*.php"] } ],
     "full_gates": [ { "repo": "<repo>", "cmd": "<full test or typecheck command>" } ],
     "permissions": { "deny": [] },
     "final_review": true,
     "plans": [ { "id": "001", "file": "001-name.md", "repos": ["<repo folder name>"],
                  "depends_on": [], "est_turns": 30, "model": "sonnet or opus (omit for the default)",
                  "allowed_paths": ["<repo>/<glob>"], "allow_extra": [],
                  "verify": [ "<command in the first repo>", { "repo": "<repo>", "cmd": "<command>" } ],
                  "steps": [ { "n": 1, "title": "...", "verify": ["<command that exits 0 when step 1 is right>"] } ],
                  "human_check": "optional: what only a person can check; goes in the report, never blocks" } ] }
   Rules for the manifest:
   - There is NO "gate": "manual". Plans must need no approval. A plan with a manual gate is invalid.
   - Do not use the old Antigravity fields repo, verify_command or prompt. They are rejected.
   - Fill env, isolate, setup, gates_each and full_gates from what you learned in the CI workflows
     and the project rules. If the backend needs a database, use a throwaway name that differs from the real
     one (the real name is in .env.example; for example <real>_test) and list that key under
     "isolate". Never copy a real secret into the manifest. Migrations run only against that
     throwaway database. If the project has no database, leave env, isolate and setup out.
   - "model" is "sonnet" or "opus": the runner maps them to agy models (config/models.json). A plan may set "agy_model"
     to an agy model name instead. Use opus only for a plan that is truly hard.
   - "permissions" is optional: extra deny rules for this project only, in the Claude spelling: "Bash(docker *)" refuses a command,
     "Read(**/secrets/**)" protects a path, "Edit(**/vendor/**)" protects a path from edits. The runner already refuses git changes,
     network tools, deploy and publish tools, recursive deletes and secret files. Leave "permissions" out unless the project needs more.
     "php_lint": false turns off the built-in PHP check for a project with no PHP.
   - Any language works. Put the project's own lint, compile and test commands in gates_each,
     full_gates and each verify. Dependency and lock files of every ecosystem may always change.
   - For checks on file contents or JSON use the runner's checker: node "{{runner}}/assert.mjs" has|none|count|exists|json ...
     ({{runner}} is filled in by the runner, so the plan folder holds no machine-specific path). An invalid regex there exits 2
     and the validator compiles every regex before a run, so a check can never pass silently.
   - est_turns is your honest estimate (assistant turns; the runner allows about 3 tool calls per turn).
   - Commands run through the system shell. Use plain commands, no cd; the repo field sets the folder.
   - allowed_paths start with the repo folder name and list only what the plan needs. package.json
     and package-lock.json are always allowed, because installs are allowed.
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
4. HANDOFF.md - one heading, "# Handoff". The runner appends to it after each plan.

STEP 2 - Script check (a machine, not a model)
Run: node $HOME/.gemini/tools/plan-runner/validate.mjs docs/plans/<slug>
($HOME works in PowerShell and in Git Bash. Do not use ~: PowerShell does not expand it when it starts node.)
Show the output. Fix every ERROR and re-run until it prints VALID. Read every WARN and fix the
ones that matter. If the file does not exist, run the same checks by hand with commands: manifest
parses; ids unique; every file named exists; depends_on points only to earlier ids; every plan has
a non-empty verify and allowed_paths; every step is numbered 1..N and has a heading in the plan
file; every test file named in a verify exists or is created by an allowed path; every regex in a verify compiles.

STEP 3 - Fresh review (do not review your own work)
a. Start one plan-cold-reader subagent per plan file with invoke_subagent (several at once if you can, at most 5).
   Give each only the folder path and its plan id. Each returns READY or NEEDS FIXES with its list of guesses.
b. Start one plan-auditor subagent. Give it the folder path and the spec path. It returns the
   coverage table and its findings.
c. Fix every finding. Re-run only the cold readers for plans you changed, and the auditor once more.
   Maximum 2 rounds. Anything still open: list it for the user honestly. Do not hide it.
d. After any fix, run the validator again.

STEP 4 - Show the user
A table: id, name, repo, depends on, est_turns, verify command, cold-reader verdict. Then the open
items, every HIGH-RISK assumption, every "human_check", and the throwaway environment values.
Ask for approval and make the changes the user asks for. Then set STATE.md: phase: plans-approved (write it exactly like that, lower-case, on its own line).

STEP 5 - Tell the user how to run it
Say exactly: "Open a separate terminal in <primary repo> and run:
node $HOME/.gemini/tools/plan-runner/run.mjs run <slug>
Every repo in the plan must have no uncommitted changes first. It never commits. When it stops, read
$HOME/.gemini/plan-runs/<repo>__<slug>/REPORT.md. Fix the cause and run the same command again to resume."
Do not start the runner yourself.
