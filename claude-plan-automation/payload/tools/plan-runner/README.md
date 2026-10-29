# Plan runner

Runs the plan files made by `/plan-feature` and `/plan-split`, one fresh `claude -p` session per
plan file, with nobody present. It never trusts a session's "done", stops at the first failure,
never commits, and can always be resumed.

## Use

1. Plan: `/plan-feature <idea>`, then `/clear`, then `/plan-split <slug>`.
2. Make sure every repo in the plan has no uncommitted changes (plan folders under `docs/plans/` are ignored for this check).
3. In a **separate terminal** (not inside Claude Code), from the main repo:

```
node $HOME/.claude/tools/plan-runner/run.mjs run <slug>
```

Use `$HOME`, not `~`. PowerShell does not expand `~` when it starts `node`; `$HOME` works in PowerShell and in Git Bash.
If you installed with `CLAUDE_CONFIG_DIR`, use that folder instead of `$HOME/.claude`.

- Stop: Ctrl+C. The current plan is rolled back to its last checkpoint the next time you start.
- Resume after a stop or failure: fix the cause (the plan file, a check or the environment; not the code by hand), then run the same command again. Passed steps are kept and re-checked.
- Start over: add `--reset` (only when the repos are clean).
- Look without running: `run.mjs status <slug>` or `run.mjs run <slug> --dry-run`.
- Check a plan folder only: `node $HOME/.claude/tools/plan-runner/validate.mjs docs/plans/<slug>`.

Everything the run writes is in `$HOME/.claude/plan-runs/<repo>__<slug>/`: `state.json`, `run.log`,
`REPORT.md` (also copied to the plan folder), raw `session-N.jsonl` per session, `plans/<id>/failures.log` (every failed try in full), and `.patch` files
for any work that was rolled back.

## What it does for each plan

1. Snapshot every repo (a git tree object; no commit, no stash, no branch change).
2. Run each step's check once before any work. A check that already passes cannot prove its step was done; it is listed in the report as a weak check. (`"precheck": false` in the manifest or a plan turns this off.)
3. Start `claude -p` with a locked permission list (`config/permissions.json`, mode `dontAsk`: anything not allowed is refused, never asked), user-level settings switched off, no MCP servers, the file guard (`lib/file-guard.mjs`, see below) and the report format (`--json-schema`).
4. The session does numbered steps and runs `checkpoint.mjs <n>` after each. That runs the step's own check and records a restore point. Steps can only be checkpointed in order.
5. When the session ends the runner decides, not the session (see "No step is skipped").
6. Pass: append to `HANDOFF.md` (with the full session report), next plan.

Other behaviour: a usage-limit hit waits for the reset and retries without using a try; a session silent for `idle_min` or running past `timeout_min` is killed with its child processes; a session over 1.5x its `est_turns` is stopped at the next green checkpoint and continued in a fresh one; every `full_gates_every` plans and at the end the `full_gates` run; at the end a read-only security review of the whole diff is written into the report; Windows is kept awake; a toast and the log tell you when it stops or finishes.

## No step is skipped

- **Every step must be checkpointed.** A session that ends with steps left is not done. If it moved forward, a fresh session goes on from the next step (no try used). If it did not move forward, that is a failed try.
- **Every step's check runs again at the end**, then the plan's `verify`, the scope check, `php -l` and `gates_each`. A later step that breaks an earlier one is caught.
- **The session must end with a fixed-format report** (`lib/report.mjs`): every step done or not, `not_done`, `different_from_plan` (with a reason), `needs_person_check`. A missing or malformed report is a failed try.
- **Anything "not done" stops the run.** The runner rolls back to before the earliest not-done step (keeping the steps before it), saves the rest as a `.patch`, and halts so you can decide. It does not retry blindly. (A session that moved forward and only marks the steps it did not reach yet is simply continued.)
- **3 tries per step** (`max_attempts`). The count starts again when a step passes. Each failed try rolls back to the last checkpoint. After the 3rd fail of the same step the run stops; the passed steps are kept.
- **Every failure is stored in full** in `plans/<id>/failures.log` (time, step, try number, reason, command output, the `.patch` of the discarded work) and listed in `REPORT.md`. The terminal shows the first lines.
- **Starting again after a stop:** the kept steps' checks run first. The first one that fails, and every step after it, is redone. If the plan's steps changed in the manifest while it was stopped, the plan starts over. If you edited code by hand, the runner refuses to start (it would roll your edits back): put the fix into the plan file instead.
- **A finished plan that was changed afterwards** (its manifest entry or plan file) makes the runner refuse to start, because the finished work no longer matches it.
- The validator refuses a step without its own check, `if_changed` in a step or plan check (it would skip the check exactly when the work was skipped), a step heading in the plan file that the manifest does not know, and a check on a file nobody creates.

`REPORT.md` starts with what to read first: **1. done differently from the plan**, **2. changed outside the plan's allowed_paths**, **3. needs a person to check**; then anything not done, weak checks, every plan, every failed try, refused tool calls, files changed, new dependencies, the session reports and the security review.

## Safety rules the runner enforces

- Refuses to start on a dirty tree, an unapproved plan folder, an invalid manifest, a missing repo, or when `env`/`isolate` would use the project's real database name.
- Refuses to resume if someone edited files while it was stopped.
- Only one runner per feature (lock file).
- A session may change any file in the project repos except: `.git/`, the real `.env` and `.env.*` (the `.env.example` family is open), the plan folder (only `BLOCKED.md`), and agent settings, hooks, sub-agents and skills (`.claude/settings*.json`, `.claude/hooks`, `.claude/agents`, `.claude/skills`, `.claude/commands`, `.agents/hooks.json`, `.agents/hooks`, `.agents/skills`). `.claude/rules` and other docs are open. Files outside `allowed_paths` may change; they are listed in the report.
- The file guard (`lib/file-guard.mjs`, a PreToolUse hook passed with `--settings`) refuses Write/Edit outside the project repos (the temp folder is allowed) and on blocked files, and Read on secret files.
- After every session: a commit, reset or branch switch (HEAD moved), a changed `.env`, or a change in another git repo next to the project stops the run.

## Permissions: any language, any build tool

`config/permissions.json` allows Bash as a whole and lists what is refused. It names no language, so php, node, python, go, cargo, dotnet, maven, gradle, ruby, make and anything new all work with no setup.

- **Refused (deny list):** git changes (commit, push, reset, checkout, stash, `git -C` ...), recursive deletes, sudo and system commands, other shells (`bash -c`, powershell, cmd), network and remote tools (curl, ssh, scp ...), cloud and deploy tools (aws, kubectl, terraform, vercel ...), package publishing (npm, cargo, gem, twine, mvn deploy ...), `.env`, ssh and aws secret files.
- **Add rules for one project:** put `"permissions": { "allow": [...], "deny": [...] }` in `manifest.json`. Example: `"deny": ["Bash(docker *)"]` for a project that must not touch Docker.
- **The deny list is best-effort.** A program that can run code (node, php, python ...) can still reach what a rule refuses, for example `node -e` calling git. The real safety is outside the session: the git snapshot and rollback, the scope gate (only `allowed_paths` may change), the secret-file gate, the throwaway `isolate` database, and the final security review.
- **Secret files:** the runner fingerprints `.env` and `.env.*` in every repo before the run. If a session changes one, the run halts and says so. Git ignores these files, so the runner cannot restore them. It also cannot stop a session from *reading* `.env` through a program it runs.
- **Dependency files:** lock and manifest files of every common ecosystem (package.json, composer.json, requirements.txt, pyproject.toml, go.mod/go.sum, Cargo.toml/Cargo.lock, Gemfile, ...) may always change, because installs are allowed. Changes are listed in HANDOFF.md under "New or changed dependencies".
- Only `php -l` (changed PHP files) is a built-in language check. For any other language put its lint, compile or test command in `gates_each` and `full_gates`, or set `"php_lint": false`.
- **Refused commands are listed** in `REPORT.md` with the command. The prompt asks for one command per Bash call (no `cd`, no `&&` chains, no `>` into files): in a real run most refusals were compound commands like these.

## Checks in a plan: `{{runner}}` and `assert.mjs`

Commands in a manifest may contain `{{runner}}`, which the runner replaces with its own folder, so a plan folder holds no machine-specific path. `assert.mjs` is a small checker that needs only Node:

```
node "{{runner}}/assert.mjs" has    <file> <regex> [flags]
node "{{runner}}/assert.mjs" none   <file> <regex> [flags]
node "{{runner}}/assert.mjs" count  <file> <regex> <n>
node "{{runner}}/assert.mjs" exists <path> [<path> ...]
node "{{runner}}/assert.mjs" json   <file> <dotted.key> [expected]
```

Exit 0 = passed, 1 = the check failed, 2 = the command itself is wrong (bad usage, a missing or unreadable file, an invalid regex). A check that cannot run never passes. `validate.mjs` compiles every regex in an `assert.mjs` command and checks that every file it names exists or is created by a plan before the run starts.

## Known limits

- Rollback restores files only. It cannot undo database changes (that is why runs use a throwaway database), and it cannot remove packages an install added to `node_modules` (re-run `npm install` after a failed run).
- Ignored files (`.env`, `node_modules`) are never snapshotted or touched.
- On this machine each git call takes about 2 seconds (Windows process-start cost), so expect a minute or two of snapshot overhead per plan.
- Shell commands cannot be fenced in on Windows. The file guard covers Write/Edit; a shell command could still write outside the project. The runner notices it only in another git repo next to the project.
- `tests/chaos.mjs` in the repo (not in the install) exercises all of this against a fake `claude` and uses no Claude usage.
