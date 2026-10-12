# Plan runner (Antigravity / agy)

Runs the plan files made by `/plan-feature` and `/plan-split`, one fresh `agy -p` session per
plan file, with nobody present. It never trusts a session's "done", stops at the first failure,
never commits, and can always be resumed. It reads the same plan folder and `manifest.json` as the
Claude Code runner, so a plan folder runs on either one.

## Use

1. Plan: `/plan-feature <idea>`, then start a fresh agy session, then `/plan-split <slug>`.
2. Make sure every repo in the plan has no uncommitted changes (plan folders under `docs/plans/` are ignored for this check).
3. In a **separate terminal** (not inside agy), from the main repo:

```
node $HOME/.gemini/tools/plan-runner/run.mjs run <slug>
```

Use `$HOME`, not `~`. PowerShell does not expand `~` when it starts `node`; `$HOME` works in PowerShell and in Git Bash.
If you installed with `AGY_GEMINI_DIR`, use that folder instead of `$HOME/.gemini`.

- Stop: Ctrl+C. The current plan is rolled back the next time you start.
- Resume after a stop or failure: run the same command again.
- Start over: add `--reset` (only when the repos are clean).
- Check the setup without spending model usage: `run.mjs run <slug> --dry-run` (checks agy, the model names, the safety guard and the plan folder, then lists the plans).
- Look at a run: `run.mjs status <slug>`.
- Check a plan folder only: `node $HOME/.gemini/tools/plan-runner/validate.mjs docs/plans/<slug>`.
- Use your own agy settings instead of the throwaway HOME: `--no-isolation` (see "Permissions"; the session is then NOT restricted).

Everything the run writes is in `$HOME/.gemini/plan-runs/<repo>__<slug>/`: `state.json`, `run.log`,
`REPORT.md` (also copied to the plan folder), raw `session-N.jsonl` per session, the throwaway HOME (`agy-home/`), and `.patch` files
for any work that was rolled back.

## What it does for each plan

1. Snapshot every repo (a git tree object; no commit, no stash, no branch change).
2. Start `agy -p --output-format stream-json --model <model>` in its own throwaway HOME (see "Permissions").
3. The session does numbered steps and runs `checkpoint.mjs <n>` after each. That runs the step's own check and records a restore point.
4. When the session ends the runner decides, not the session. agy says SUCCESS and exits 0 even when a tool call was refused, so only these mean anything: the git state check (no commit, branch change or reset), the scope check (only `allowed_paths` changed), the secret-file check, `php -l`, the manifest's `gates_each`, any unchecked step checks, and the plan's `verify` commands.
5. Pass: append to `HANDOFF.md`, next plan. Fail: roll back to the last checkpoint (the discarded work is saved as a `.patch`) and retry, up to `max_attempts`. After the last attempt, roll the whole plan back and stop the run.

Other behaviour:
- A usage limit or spent credit balance waits and retries without using an attempt. agy gives no reset time the runner can read, so it waits the server's retry delay when the `AGY_ERROR` line has one, else 15 minutes (up to 12 hours in total).
- A session silent for `idle_min` or running past `timeout_min` is killed with its child processes. After agy's final answer, a background task it started can keep it alive for up to 30 minutes, so the runner stops it after 20 seconds.
- agy has no max-turns flag, so the runner counts tool calls itself. The manifest's `est_turns` and `max_turns` are Claude turns; the runner allows about 3 tool calls per turn. A session over 1.5 times its estimate is stopped at the next green checkpoint and continued in a fresh one (up to 6 continuations). A session over `max_turns` is stopped and the attempt fails.
- `BLOCKED.md` from a session stops the run. At the end `full_gates` run (and every `full_gates_every` plans), then a read-only security review of the whole diff goes into the report.
- Windows is kept awake; a toast and the log tell you when it stops or finishes.

## Models

`config/models.json` maps the manifest's `sonnet`, `opus` and `haiku` to agy models (`agy models` lists them). A plan or `defaults` may name an agy model directly (`model: "gemini-3.1-pro-high"`) or set `agy_model`. The runner checks every model against `agy models` before it starts. The final review uses the `review` entry.

## Permissions: how a session is restricted

agy has no "refuse instead of ask" flag, no per-run settings file, and no way to skip your own plugins, MCP servers and rules. It does work with `HOME` / `USERPROFILE` pointing somewhere else, and in `-p` mode it refuses (and does not ask) anything not allowed. So each run gets its own HOME at `plan-runs/<repo>__<slug>/agy-home/`:

- `settings.json` allows commands (agy itself allows files inside the workspace folders) and adds a small deny list agy enforces itself. Measured: agy also lets a session read a file outside the workspace, so credentials are protected by name (`.env`, `.ssh`, `.aws`, `.npmrc`, `.netrc`, keys, `.git/`), not by location.
- `hooks.json` runs `guard.mjs` before every tool call. It refuses what `config/permissions.json` lists: git changes, recursive deletes, sudo and system commands, other shells, network tools, cloud and deploy tools, package publishing, `.env` and credential files, and edits to `.git/`, `.agents/`, `.gemini/`. If the guard cannot run, the call is refused.
- Your plugins, MCP servers, global rules and permissions are not there. Your `.gitconfig` is copied in (git identity); `.npmrc`, `.netrc`, `.ssh` and `.aws` are not. Secret-looking environment variables (names with token, secret, password, credential, api key, auth) are removed from the session. The manifest's `env` is added after that.
- Because the shell on Windows is PowerShell, the rules cover both bash and PowerShell spellings. Add rules for one project in `manifest.json`: `"permissions": { "deny": ["Bash(docker *)", "Read(**/secrets/**)", "Edit(**/vendor/**)"] }`.
- A refusal does not mean the shell is off. The refusal message says so and tells the session to skip that command.

**The deny list is best effort.** A program that can run code (node, php, python ...) can still reach what a rule refuses. The real safety is outside the session: the git rollback, the scope gate (only `allowed_paths` may change), the secret-file gate (`.env` files are fingerprinted before the run), the git state check (a session that commits or switches branch halts the run), the throwaway `isolate` database, and the final security review.

**`--no-isolation`:** use it only if agy cannot start or sign in inside the throwaway HOME on your computer (the runner refuses to start and says so). The session then uses your own agy settings and is not restricted by the guard; only the runner-side protections remain. The report says which mode ran. The throwaway HOME was verified on Windows; on macOS and Linux agy may keep its sign-in in a file under `~/.gemini`, which the isolated HOME does not have.

The final review session is read-only twice over: its guard refuses every command and every file edit, and its settings deny `command(*)` and `write_file(*)`. Both are checked before the run starts (the guard offline, with no model usage). The settings half was not exercised against the real agy.

## Checks in a plan: `{{runner}}` and `assert.mjs`

Commands in a manifest may contain `{{runner}}`, which the runner replaces with its own folder, so a plan folder holds no machine-specific path. `assert.mjs` is a small checker that needs only Node:

```
node "{{runner}}/assert.mjs" has    <file> <regex> [flags]
node "{{runner}}/assert.mjs" none   <file> <regex> [flags]
node "{{runner}}/assert.mjs" count  <file> <regex> <n>
node "{{runner}}/assert.mjs" exists <path> [<path> ...]
node "{{runner}}/assert.mjs" json   <file> <dotted.key> [expected]
```

Exit 0 = passed, 1 = the check failed, 2 = the command itself is wrong (bad usage, unreadable file, invalid regex). A check that cannot run never passes. `validate.mjs` compiles every regex in an `assert.mjs` command before the run starts (an error), and warns about `grep -E`, `rg` and `Select-String` patterns that do not compile.

## Safety rules the runner enforces

- Refuses to start on a dirty tree, an unapproved plan folder, an invalid manifest (including the old Antigravity format), a missing repo, an unknown model, an agy that cannot start, a guard that fails its self-test, or when `env`/`isolate` would use the project's real database name.
- Refuses to resume if someone edited files while it was stopped.
- Only one runner per feature (lock file).
- Never edits `.env`, `.agents/`, `.gemini/`, `.git/`, the manifest or plan files (scope gate).

## Known limits

- Rollback restores files only. It cannot undo database changes (that is why runs use a throwaway database), and it cannot remove packages an install added to `node_modules` (re-run `npm install` after a failed run).
- Ignored files (`.env`, `node_modules`) are never snapshotted or touched. Files outside the repos (another project, your home folder) are not snapshotted either: a session could change them through the shell, and no gate would notice.
- On a heavily loaded computer the guard hook can be slow. agy fails a tool call whose hook times out (30 seconds), so a harmless call may fail for that reason (the log shows it as `[Denied] ... JSON hook ... failed`); the session usually just retries it.
- Each agy session has a cold start of 20 to 30 seconds, and git calls are slow on Windows, so expect a minute or two of overhead per plan.
- agy's `--sandbox` is not used: on Windows it hid `node`, `git` and `npm` from the sandboxed shell in our tests.
- The throwaway HOME hides `~/.npmrc` and similar files from the session. On Windows, npm and composer keep their caches under `%APPDATA%` and `%LOCALAPPDATA%`, which are unchanged. On macOS and Linux caches live under `$HOME`, so the first install in a run is slower.
- `tests/` (chaos tests against a fake agy, guard tests, installer tests) live in the repo, not in the install. See `CAPABILITY-MATRIX.md` for what was measured and what was not.
