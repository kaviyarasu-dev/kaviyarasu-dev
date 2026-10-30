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

- Stop: Ctrl+C. The current plan is rolled back to its last checkpoint the next time you start.
- Resume after a stop or failure: fix the cause (the plan file, a check or the environment; not the code by hand), then run the same command again. Passed steps are kept and re-checked.
- Start over: add `--reset` (only when the repos are clean).
- Check the setup without spending model usage: `run.mjs run <slug> --dry-run` (checks agy, the model names, the safety guard and the plan folder, then lists the plans).
- Look at a run: `run.mjs status <slug>`.
- Check a plan folder only: `node $HOME/.gemini/tools/plan-runner/validate.mjs docs/plans/<slug>`.
- Use your own agy settings instead of the throwaway HOME: `--no-isolation` (see "Permissions"; the session is then NOT restricted).

Everything the run writes is in `$HOME/.gemini/plan-runs/<repo>__<slug>/`: `state.json`, `run.log`,
`REPORT.md` (also copied to the plan folder), raw `session-N.jsonl` per session, `plans/<id>/failures.log` (every failed try in full), the throwaway HOME (`agy-home/`), and `.patch` files
for any work that was rolled back.

## What it does for each plan

1. Snapshot every repo (a git tree object; no commit, no stash, no branch change).
2. Run each step's check once before any work. A check that already passes cannot prove its step was done; it is listed in the report as a weak check. (`"precheck": false` in the manifest or a plan turns this off.)
3. Start `agy -p --output-format stream-json --model <model> --json-schema <report schema>` in its own throwaway HOME (see "Permissions").
4. The session does numbered steps and runs `checkpoint.mjs <n>` after each. That runs the step's own check and records a restore point. Steps can only be checkpointed in order.
5. When the session ends the runner decides, not the session (see "No step is skipped"). agy says SUCCESS and exits 0 even when a tool call was refused, so only the runner's own checks mean anything.
6. Pass: append to `HANDOFF.md` (with the full session report), next plan.

## Large runs: a whole application (size L and XL)

For work too big for one session (a full application, 30 to 100 plans over days) the planning has one more phase
and the manifest more fields. In agy (start a fresh agy session between phases):

1. `/plan-research <product>`: researches the domain on the web (comparable products, every feature a complete
   product has, domain rules, regulations, vendors, production needs, all with links) and lets you pick the scope.
   Writes `_planning/research.md`.
2. `/plan-feature <slug>`: takes the scope from research.md, interviews you on the rest (stack, data model, API,
   auth, real-time, testing and deploy are always asked for L and XL), writes the spec with user journeys and a
   production-readiness section, and writes **`ARCHITECTURE.md`** in the plan folder: the locked decisions.
3. `/plan-split <slug>`: writes the plans epic by epic (progress kept in STATE.md and EPICS.md, so a compacted chat
   can go on), plan 001 builds the skeleton, each epic ends with a milestone, the last epic is production readiness.
4. The runner, then `/plan-replan <slug>` whenever it pauses at a milestone or stops on a whole-app check.

What the runner does for these runs (all manifest fields are optional; the validator requires some for L and XL):

| Field or flag | What it does |
|---|---|
| `ARCHITECTURE.md` (plan folder) | Read first by every session, which must follow it. Required for L and XL. A change during the run is noted in the report. |
| `CONTEXT.md` (written by the runner) | A short map of what earlier plans built (modules, interfaces, helpers, conventions), from each session's `context` entries, plus the last 3 handoffs. Sessions read it instead of the ever-growing HANDOFF.md, which they only search. |
| `size` | `S`, `M`, `L` or `XL`. L and XL need ARCHITECTURE.md and `full_gates`; XL also needs `e2e_gates`. |
| `reset` | Commands run before every session, every pre-check and every whole-app check: they rebuild the throwaway test database from the current files, so a rolled-back try leaves no migrations or rows behind. A failing reset halts the run. |
| `deps_install` | Run after a rollback changed a package or lock file, so installed packages match the files again. |
| `e2e_gates` | The app end to end (start it, run the user-journey tests). At every milestone and at the end. A failure halts the run and is repeated on the next start before any other plan. |
| `pause_after` | Plan ids (the end of each epic). After that plan: the full and end-to-end checks, then the run **pauses** (exit 0, `Result: PAUSED`) so you can look at the app. The next start continues. |
| plan `freeze` / `unfreeze` | Files (tests, test config) that no later plan may change once this plan is done. A change is refused by the checkpoint and the scope gate. A later plan that must change one lists it under `unfreeze`. |
| `plan_review` (default on for L and XL) | After a plan passes its checks, a separate read-only reviewer reads its diff against the plan, ARCHITECTURE.md and CONTEXT.md: tests that would pass on wrong code, stubs, contradictions, security. A critical or high problem is a failed try with the problems as the reason. A review that gives no answer twice is noted in the report and does not block. |
| `final_review_blocks` (default on for L and XL) | The final review's critical or high findings halt the run. |
| plan `repair: true` | A plan written after a failed full or end-to-end check or final review (`/plan-replan` writes it). Repair plans run before the failed check is repeated. |
| `bisect` (default on) | When the full check fails, the runner puts the files back to each plan's finished state in turn (a binary search over the plans since the last green check) and names the first plan after which it fails. The files are always put back. |
| `max_limit_wait_hours` | The longest total usage-limit wait since this start (agy gives no reset time). Default 168. A new start begins a new budget. |
| `pass_env` | Variable names that may pass through. Every other secret-looking variable of your shell (`*_API_KEY`, `*TOKEN*`, `*SECRET*`, `*PASSWORD*` ...) is removed from sessions and checks, so a test can never use a real exchange, cloud or payment key. Put throwaway test values in `env`. |
| `--from <plan id>` | A fresh run (`--reset`, clean repos) that counts the plans before it as done, for work committed from an earlier run. |

`REPORT.md` is now rewritten after every plan (`Result: RUNNING`), with progress, elapsed time, a rough time left, a time per plan, and the plan reviews' findings that did not block.

## No step is skipped

- **Every step must be checkpointed.** A session that ends with steps left is not done. If it moved forward, a fresh session goes on from the next step (no try used). If it did not move forward, that is a failed try.
- **Every step's check runs again at the end**, then the plan's `verify`, the scope check, `php -l` and `gates_each`. A later step that breaks an earlier one is caught.
- **The session must end with a fixed-format report** (`lib/report.mjs`, read from agy's `structured_output`, or a json block in the answer): every step done or not, `not_done`, `different_from_plan` (with a reason), `needs_person_check`. A missing or malformed report is a failed try.
- **Anything "not done" stops the run.** The runner rolls back to before the earliest not-done step (keeping the steps before it), saves the rest as a `.patch`, and halts so you can decide. It does not retry blindly. (A session that moved forward and only marks the steps it did not reach yet is simply continued.)
- **3 tries per step** (`max_attempts`). The count starts again when a step passes. Each failed try rolls back to the last checkpoint. After the 3rd fail of the same step the run stops; the passed steps are kept.
- **Every failure is stored in full** in `plans/<id>/failures.log` (time, step, try number, reason, command output, the `.patch` of the discarded work) and listed in `REPORT.md`. The terminal shows the first lines.
- **Starting again after a stop:** the kept steps' checks run first. The first one that fails, and every step after it, is redone. If the plan's steps changed in the manifest while it was stopped, the plan starts over. If you edited code by hand, the runner refuses to start (it would roll your edits back): put the fix into the plan file instead.
- **A finished plan that was changed afterwards** (its manifest entry or plan file) makes the runner refuse to start, because the finished work no longer matches it.
- The validator refuses a step without its own check, `if_changed` in a step or plan check (it would skip the check exactly when the work was skipped), a step heading in the plan file that the manifest does not know, and a check on a file nobody creates.

`REPORT.md` starts with what to read first: **1. done differently from the plan**, **2. changed outside the plan's allowed_paths**, **3. needs a person to check**; then anything not done, weak checks, every plan, every failed try, refused calls, files changed, new dependencies, the session reports and the security review.

Other behaviour:
- A usage limit or spent credit balance waits and retries without using a try. agy gives no reset time the runner can read, so it waits the server's retry delay when the `AGY_ERROR` line has one, else 15 minutes (up to 12 hours in total).
- A session silent for `idle_min` or running past `timeout_min` is killed with its child processes. After agy's final answer, a background task it started can keep it alive for up to 30 minutes, so the runner stops it after 20 seconds.
- agy has no max-turns flag, so the runner counts tool calls itself. The manifest's `est_turns` and `max_turns` are Claude turns; the runner allows about 3 tool calls per turn. A session over 1.5 times its estimate is stopped at the next green checkpoint and continued in a fresh one (up to 6 continuations). A session over `max_turns` is stopped and the try fails.
- `BLOCKED.md` from a session stops the run (the steps before it are kept). At the end `full_gates` run (and every `full_gates_every` plans), then a read-only security review of the whole diff goes into the report.
- Windows is kept awake; a toast and the log tell you when it stops or finishes.

## Models

`config/models.json` maps the manifest's `sonnet`, `opus` and `haiku` to agy models (`agy models` lists them). A plan or `defaults` may name an agy model directly (`model: "gemini-3.1-pro-high"`) or set `agy_model`. The runner checks every model against `agy models` before it starts. The final review uses the `review` entry.

## Permissions: how a session is restricted

agy has no "refuse instead of ask" flag, no per-run settings file, and no way to skip your own plugins, MCP servers and rules. It does work with `HOME` / `USERPROFILE` pointing somewhere else, and in `-p` mode it refuses (and does not ask) anything not allowed. So each run gets its own HOME at `plan-runs/<repo>__<slug>/agy-home/`:

- `settings.json` allows commands (agy itself allows files inside the workspace folders) and adds a small deny list agy enforces itself. Measured: agy also lets a session read a file outside the workspace, so credentials are protected by name (`.env`, `.ssh`, `.aws`, `.npmrc`, `.netrc`, keys, `.git/`), not by location.
- `hooks.json` runs `guard.mjs` before every tool call. It refuses what `config/permissions.json` lists: git changes, recursive deletes, sudo and system commands, other shells, network tools, cloud and deploy tools, package publishing, `.env` and credential files, and edits to `.git/`, `.gemini/` and agent settings, hooks, skills and workflows (`.agents/hooks.json`, `.agents/hooks`, `.agents/skills`, `.agents/workflows`, `.claude/settings*.json`, `.claude/hooks`, `.claude/agents`, `.claude/skills`). Rule and doc files (`.agents/rules`, `.claude/rules`) are open. It also refuses file writes outside the project repos (the temp folder and the session HOME are allowed) and into the plan folder (except `BLOCKED.md`). If the guard cannot run, the call is refused.
- Your plugins, MCP servers, global rules and permissions are not there. Your `.gitconfig` is copied in (git identity); `.npmrc`, `.netrc`, `.ssh` and `.aws` are not. Secret-looking environment variables (names with token, secret, password, credential, api key, auth) are removed from the session. The manifest's `env` is added after that.
- Because the shell on Windows is PowerShell, the rules cover both bash and PowerShell spellings. Add rules for one project in `manifest.json`: `"permissions": { "deny": ["Bash(docker *)", "Read(**/secrets/**)", "Edit(**/vendor/**)"] }`.
- A refusal does not mean the shell is off. The refusal message says so and tells the session to do the same work another way, never to drop the task (or to write `BLOCKED.md` if the plan cannot be done without it). Every refusal is listed in `REPORT.md`.

**The deny list is best effort.** A program that can run code (node, php, python ...) can still reach what a rule refuses. The real safety is outside the session: the git rollback, the scope gate (blocked files never change), the secret-file gate (`.env` files are fingerprinted before the run), the git state check (a session that commits or switches branch halts the run), the throwaway `isolate` database, and the final security review.

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

Exit 0 = passed, 1 = the check failed, 2 = the command itself is wrong (bad usage, a missing or unreadable file, invalid regex). A check that cannot run never passes. `validate.mjs` compiles every regex in an `assert.mjs` command and checks that every file it names exists or is created by a plan before the run starts (errors), and warns about `grep -E`, `rg` and `Select-String` patterns that do not compile.

## Safety rules the runner enforces

- Refuses to start on a dirty tree, an unapproved plan folder, an invalid manifest (including the old Antigravity format), a missing repo, an unknown model, an agy that cannot start, a guard that fails its self-test, or when `env`/`isolate` would use the project's real database name.
- Refuses to resume if someone edited files while it was stopped.
- Only one runner per feature (lock file).
- A session may change any file in the project repos except: `.git/`, the real `.env` and `.env.*` (the `.env.example` family is open), the plan folder (only `BLOCKED.md`), `.gemini/`, and agent settings, hooks, skills and workflows (see "Permissions"). Files outside `allowed_paths` may change; they are listed in the report.
- After every session: a commit, reset or branch switch (HEAD moved), a changed `.env`, or a change in another git repo next to the project stops the run.

## Known limits

- Rollback restores files only. Database changes are undone only by the manifest's `reset` commands, and installed packages only by `deps_install` (without them, re-run `npm install` after a failed run).
- Ignored files (`.env`, `node_modules`) are never snapshotted or touched. Files outside the repos (another project, your home folder) are not snapshotted either: a session could change them through the shell, and no gate would notice.
- On a heavily loaded computer the guard hook can be slow. agy fails a tool call whose hook times out (30 seconds), so a harmless call may fail for that reason (the log shows it as `[Denied] ... JSON hook ... failed`); the session usually just retries it.
- Each agy session has a cold start of 20 to 30 seconds, and git calls are slow on Windows, so expect a minute or two of overhead per plan.
- agy's `--sandbox` is not used: on Windows it hid `node`, `git` and `npm` from the sandboxed shell in our tests.
- The throwaway HOME hides `~/.npmrc` and similar files from the session. On Windows, npm and composer keep their caches under `%APPDATA%` and `%LOCALAPPDATA%`, which are unchanged. On macOS and Linux caches live under `$HOME`, so the first install in a run is slower.
- `tests/` (chaos tests against a fake agy, guard tests, installer tests) live in the repo, not in the install. See `CAPABILITY-MATRIX.md` for what was measured and what was not.
