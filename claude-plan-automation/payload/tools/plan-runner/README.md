# Plan runner

Runs the plan files made by `/plan-feature` and `/plan-split`, one fresh `claude -p` session per
plan file, with nobody present. It never trusts a session's "done", stops at the first failure,
never commits, and can always be resumed.

## Use

1. Plan: `/plan-feature <idea>`, then `/clear`, then `/plan-split <slug>`.
2. Make sure every repo in the plan has no uncommitted changes (plan folders under `docs/plans/` are ignored for this check).
3. In a **separate terminal** (not inside Claude Code), from the main repo:

```
node ~/.claude/tools/plan-runner/run.mjs run <slug>
```

- Stop: Ctrl+C. The current plan is rolled back the next time you start.
- Resume after a stop or failure: run the same command again.
- Start over: add `--reset` (only when the repos are clean).
- Look without running: `run.mjs status <slug>` or `run.mjs run <slug> --dry-run`.
- Check a plan folder only: `node ~/.claude/tools/plan-runner/validate.mjs docs/plans/<slug>`.

Everything the run writes is in `~/.claude/plan-runs/<repo>__<slug>/`: `state.json`, `run.log`,
`REPORT.md` (also copied to the plan folder), raw `session-N.jsonl` per session, and `.patch` files
for any work that was rolled back.

## What it does for each plan

1. Snapshot every repo (a git tree object; no commit, no stash, no branch change).
2. Start `claude -p` with a locked permission list (`config/permissions.json`, mode `dontAsk`: anything not allowed is refused, never asked), user-level settings switched off, no MCP servers.
3. The session does numbered steps and runs `checkpoint.mjs <n>` after each. That runs the step's own check and records a restore point.
4. When the session ends the runner decides, not the session: the result must be `success`, then the scope check (only `allowed_paths` changed), `php -l`, the manifest's `gates_each`, any unchecked step checks, and the plan's `verify` commands must all pass.
5. Pass: append to `HANDOFF.md`, next plan. Fail: roll back to the last checkpoint (the discarded work is saved as a `.patch`) and retry, up to `max_attempts`. After the last attempt, roll the whole plan back and stop the run.

Other behaviour: a usage-limit hit waits for the reset and retries without using an attempt; a session silent for `idle_min` or running past `timeout_min` is killed with its child processes; a session over 1.5x its `est_turns` is stopped at the next green checkpoint and continued in a fresh one; `BLOCKED.md` from a session stops the run; every `full_gates_every` plans and at the end the `full_gates` run; at the end a read-only security review of the whole diff is written into the report; Windows is kept awake; a toast and the log tell you when it stops or finishes.

## Safety rules the runner enforces

- Refuses to start on a dirty tree, an unapproved plan folder, an invalid manifest, a missing repo, or when `env`/`isolate` would use the project's real database name.
- Refuses to resume if someone edited files while it was stopped.
- Only one runner per feature (lock file).
- Never edits `.env`, `.claude/`, `.git/`, the manifest or plan files (scope gate).

## Permissions: any language, any build tool

`config/permissions.json` allows Bash as a whole and lists what is refused. It names no language, so php, node, python, go, cargo, dotnet, maven, gradle, ruby, make and anything new all work with no setup.

- **Refused (deny list):** git changes (commit, push, reset, checkout, stash, `git -C` ...), recursive deletes, sudo and system commands, other shells (`bash -c`, powershell, cmd), network and remote tools (curl, ssh, scp ...), cloud and deploy tools (aws, kubectl, terraform, vercel ...), package publishing (npm, cargo, gem, twine, mvn deploy ...), `.env`, ssh and aws secret files.
- **Add rules for one project:** put `"permissions": { "allow": [...], "deny": [...] }` in `manifest.json`. Example: `"deny": ["Bash(docker *)"]` for a project that must not touch Docker.
- **The deny list is best-effort.** A program that can run code (node, php, python ...) can still reach what a rule refuses, for example `node -e` calling git. The real safety is outside the session: the git snapshot and rollback, the scope gate (only `allowed_paths` may change), the secret-file gate, the throwaway `isolate` database, and the final security review.
- **Secret files:** the runner fingerprints `.env` and `.env.*` in every repo before the run. If a session changes one, the run halts and says so. Git ignores these files, so the runner cannot restore them. It also cannot stop a session from *reading* `.env` through a program it runs.
- **Dependency files:** lock and manifest files of every common ecosystem (package.json, composer.json, requirements.txt, pyproject.toml, go.mod/go.sum, Cargo.toml/Cargo.lock, Gemfile, ...) may always change, because installs are allowed. Changes are listed in HANDOFF.md under "New or changed dependencies".
- Only `php -l` (changed PHP files) is a built-in language check. For any other language put its lint, compile or test command in `gates_each` and `full_gates`, or set `"php_lint": false`.

## Known limits

- Rollback restores files only. It cannot undo database changes (that is why runs use a throwaway database), and it cannot remove packages an install added to `node_modules` (re-run `npm install` after a failed run).
- Ignored files (`.env`, `node_modules`) are never snapshotted or touched.
- On this machine each git call takes about 2 seconds (Windows process-start cost), so expect a minute or two of snapshot overhead per plan.
- `tests/chaos.mjs` exercises all of this against a fake `claude` and uses no Claude usage.
