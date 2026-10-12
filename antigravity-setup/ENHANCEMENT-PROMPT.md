# Prompt for the Antigravity agent: bring the Claude Code plan automation to Antigravity

Paste everything below the line into Antigravity (agy) with the working folder set to the root of the `kaviyarasu-dev` repo. Nothing here has been run yet.

---

You are improving the Antigravity plan-automation setup in `antigravity-setup/` so it matches the Claude Code plan automation in `claude-plan-automation/`, but ONLY for the features that Antigravity (`agy`) can really support. Do not assume. Prove every claim with a command you ran and its output.

## 0. Rules for this whole job

- Never commit, push, stash or change git state. Never touch the branch. Leave every change uncommitted for me to review.
- Never read or print the value of any secret (`.env`, tokens, keys, `settings.json` auth fields). If you need a settings key, print the key name only.
- Do not run experiments against real projects or my real `~/.gemini` folder. Use a throwaway folder under the system temp directory, and a throwaway copy of the config when you can redirect it. If you cannot redirect the config, say so and test only with read-only commands.
- No hardcoded user paths. The current files contain `C:\Users\Kaviyarasu\...` and `C:\Users\inc3241\...`; find every one and replace it with a lookup (`os.homedir()`, `PATH` search for `agy`, an environment variable).
- Write files in plain English. Match the style of the file you edit. Keep scripts dependency-free (Node 20 only, no npm packages).
- Think like a senior engineer: root cause, security, edge cases, reuse before writing new code. Do not add an abstraction that is not needed yet.
- If a decision is truly mine (not something a command can answer), ask me at most 4 questions at a time, with your recommendation first. Otherwise decide, and log the decision in the final report.
- If a feature is not supported, do NOT fake it. Say so, give the closest safe workaround if one exists, and move on.

## 1. Read first (no changes yet)

Reference implementation (Claude Code), in this repo:
- `claude-plan-automation/FEATURES-REPORT.md`: the full feature list, the lessons, and a first gap analysis made from a quick skim (verify it, do not trust it).
- `claude-plan-automation/payload/tools/plan-runner/` : `run.mjs`, `checkpoint.mjs`, `validate.mjs`, `lib/*.mjs`, `config/permissions.json`, `README.md`, `tests/chaos.mjs`, `tests/fake-claude.mjs`.
- `claude-plan-automation/payload/skills/` (`plan-feature`, `plan-split`, `grill-me`) and `claude-plan-automation/payload/agents/`.
- `claude-plan-automation/install.mjs` and `README.md`: the one-command installer.

Current Antigravity setup to improve:
- `antigravity-setup/GUIDE.md`, `INSTRUCTIONS.md`, and everything under `antigravity-setup/config/` (`scripts/plan-runner.js`, `scripts/plan-runner-2.js`, `scripts/validate-manifest.js`, `scripts/reminder_hook.js`, `skills/plan_feature/SKILL.md`, `agents/*.md`, `hooks.json`, `config.json`, `mcp_config.json`, `projects/`).
- Also look at how the installed `agy` keeps its config: `~/.gemini/config/` (shared) and `~/.gemini/antigravity-cli/settings.json`. Read key names only.

## 2. What is already known about `agy` (verified on this machine, agy 1.3.1)

From `agy --help`:
- Flags that exist: `-p/--print`, `--output-format text|json|stream-json`, `--input-format text|stream-json`, `--json-schema`, `--print-timeout`, `--model`, `--effort low|medium|high|xhigh|max`, `--mode accept-edits|plan`, `--sandbox`, `--dangerously-skip-permissions`, `--add-dir` (repeatable), `--agent`, `--project`, `--new-project`, `--continue`, `--conversation <id>`, `--disable-slash-commands`, `--log-file`.
- Flags that do NOT exist: a max-turns limit, an allow-list or deny-list flag, a "never ask, refuse instead" permission mode, a flag to skip user settings, a flag to skip MCP servers, a flag for no session persistence.
- Subcommands: `agent(s)`, `changelog`, `install`, `mcp`, `models`, `plugin(s)`, `remote-control`, `update`, `help`.

From `agy changelog` (read it yourself: `agy changelog`):
- `~/.gemini/antigravity-cli/settings.json` has a `permissions.allow` list. The changelog also mentions `command` permission rules (and a deprecated `unsandboxed` type). Whether a deny list exists is NOT confirmed.
- Hooks exist in `hooks.json` (global `~/.gemini/config/hooks.json`, workspace `<workspace>/.agents/hooks.json`, and inside plugins). Events named in the changelog: `PreInvocation`, `PostInvocation`, `Stop`, `PostToolUse` (with matchers). Whether a pre-tool hook can veto a tool call is NOT confirmed.
- Headless (`-p`) runs: exit code `3` plus an `AGY_ERROR: {...}` JSON line on stderr when a turn ends on a model or agent error; `--print-timeout` expiry returns partial output and exits 0 with a warning on stderr; the default timeout is unlimited; background tasks are waited for until the print timeout (30-minute cap); `-p "/usage"` prints quota reset times (UTC when piped).
- A permission request that is not approved (for example from a subagent) is now respected, and the agent does not try to work around it. What happens to an unapproved request in `-p` mode with no flag is NOT confirmed.
- Custom agents are Markdown with frontmatter (`tools`, `excludeDefaultComponents`, `enable_mcp_tools`), project agents live in `.agents/agents/`, and they work in headless runs and with `--agent`.
- A Windows command sandbox exists (`--sandbox`).

From the existing runners:
- `plan-runner-2.js` drives one long-lived `agy` process with stream-json (events like `{"event":"user",...}` in and `{"event":"result",...}` out) and uses `--dangerously-skip-permissions`. `plan-runner.js` starts one `agy` print-mode process per plan. Retries exist only for quota errors. There is no rollback, no checkpoint, no scope check done by the runner, and no tests.

## 3. Phase 1: capability probe (do this before writing any feature)

Build `antigravity-setup/CAPABILITY-MATRIX.md`: one row per feature below, with columns `Feature | Claude Code reference | Antigravity support (YES / PARTIAL / NO / UNKNOWN) | Evidence (exact command and the relevant output) | Plan (implement / workaround / skip)`. Never write YES from memory or from the changelog alone: run a small safe experiment in the throwaway folder. If an experiment cannot be run safely, mark UNKNOWN and skip the feature.

Features to probe (the number is the row id):

Session and process
1. Fresh, isolated session per plan in print mode (does `-p` start a new conversation every time? how do you prove it? what does `--continue` do?).
2. Machine-readable output: record the real stream-json events for one trivial prompt (init, tool call, tool result, final result) and write the schema down. Is there a result subtype or flag that says success, error, max-turns, quota?
3. Exit codes and error signalling (success, model error, quota, killed). Reproduce at least success and one failure you can cause safely.
4. Turn budget: there is no max-turns flag. Can the runner count tool-call events from the stream and stop the session? Test the stop on Windows (kill the whole process tree).
5. Idle watchdog and total timeout: `--print-timeout` behaviour plus a runner-side idle timer. Does `agy` leave child or daemon processes after a kill?
6. Usage limit and quota: what does a quota or credit error look like in stream-json and on stderr? Does `agy -p "/usage"` give a parseable reset time? Do not exhaust the quota on purpose; read what the CLI documents and use the `/usage` output only.
7. Structured final report: does `--json-schema` enforce the "report back" shape?
8. Per-plan model and effort selection (`--model`, `--effort`). Does `agy models` list what the manifest can name?

Safety and permissions
9. Refuse instead of ask: in `-p` mode WITHOUT `--dangerously-skip-permissions`, what happens when the agent wants a command that is not approved? Does it fail, hang waiting for input, or auto-deny? Test with a harmless command in the throwaway folder, with a time limit.
10. Allow list: does `permissions.allow` in `settings.json` take `command` patterns, and does it support wildcards? Can the runner supply a per-run settings file or folder (an environment variable, `--project`, a workspace `.agents/` folder) so that the user's global settings are not used?
11. Deny list: is there a `deny` (or equivalent) rule type? If not, test whether a `PreToolUse`-style hook (or any hook event) can block a command. Record the hook events that really exist (use `/hooks`, the changelog, and a test hook that only writes a line to a log file).
12. Sandbox: what does `--sandbox` restrict on Windows (writes outside the workspace? network?). Test a write outside the folder and a network call to `localhost` only.
13. Protecting files that git ignores (`.env`): independent of agy, the runner can fingerprint them. (This is runner-side, so it is always possible; confirm and plan it.)
14. Isolation from user config: plugins, global rules (`~/.gemini/GEMINI.md`), MCP servers and skills could leak into an unattended run. Can they be switched off for one run (a different config directory, `--disable-slash-commands`, an empty `mcp_config.json`)?

Planning layer
15. Skills: can `plan_feature` and a new `plan_split` skill be installed as agy skills and invoked as slash commands? Is there something equivalent to `disable-model-invocation`?
16. Sub-agents: can the three agents (requirements reviewer, cold reader, auditor) be invoked from a skill (`invoke_subagent`)? Can a skill force a model per agent? Can an agent be read-only (limit `tools` in frontmatter)?
17. Asking the user structured questions with options (is there an AskUserQuestion-like tool?).
18. A "context compacted, re-read the planning files" hook (the Claude version uses a SessionStart/compact hook). Is there an equivalent event?
19. `/grill-me` equivalent skill.

Runner-side features (no agy support needed, but confirm nothing blocks them)
20. Git-tree snapshots (temporary index, `git add -A`, `write-tree`) and restore, no commit.
21. Per-step checkpoints (`checkpoint.mjs`): the session runs a command after each numbered step. Needs the agent to be able to run `node <script>`; confirm it can.
22. Runner-side acceptance after each plan: scope gate (`allowed_paths`), secret-file gate, language-neutral lint hook (`gates_each`), the plan's `verify` commands, `full_gates` every N plans and at the end, final read-only review session.
23. State and resume: `state.json`, `run.log`, `REPORT.md`, `HANDOFF.md`, `.patch` of discarded work, lock file, refuse on a dirty tree or on edits made while stopped, `--reset`, `--dry-run`, `status`.
24. Validator: manifest shape, ids, order, files exist, steps match the plan file headings, AND (new lesson) every regex argument in a `verify` command compiles. Also reject invalid regexes in the checker script (it must exit non-zero, never pass silently).
25. Offline chaos tests with a fake `agy` that lies, hangs, crashes, trips quota, writes `.env`, writes a lock file, emits garbage lines.
26. Keep the machine awake during a run, and a notification when the run stops.

Distribution
27. One-command installer for Antigravity (see section 5).
28. Config location: where do skills, agents, hooks and scripts have to live for `agy` to load them (`~/.gemini/config/...`)? Can the installer set that location by an environment variable for tests?

Stop and print the matrix in your reply when it is complete. Then continue to Phase 2 without waiting, unless a row needs a decision from me.

## 4. Phase 2: implement only what Phase 1 proved

Rules:
- Implement a feature only if its row says YES, or PARTIAL with a workaround you tested. Skip UNKNOWN and NO rows (list them again in the final report with the reason).
- Port the idea, not the Claude flags. Do not copy `--allowedTools`, `--permission-mode dontAsk`, `--setting-sources`, `--strict-mcp-config`, the `CLAUDE_CODE_*` variables or the Claude stream-json parser; use the `agy` equivalents you measured.
- Decide the runner design with evidence: one fresh `agy -p` process per plan (like Claude and like `plan-runner.js`) is required, because plans must not share memory. If `plan-runner-2.js` (one long session) cannot isolate plans, say so and retire it (keep it only if it still has a use, and say which).
- Keep a single runner file layout like the Claude one where it makes sense (`run.mjs` + `lib/*.mjs` + `validate.mjs` + `checkpoint.mjs` + `config/`), as ES modules, so the two systems are easy to compare. Put the new code under `antigravity-setup/` (for example `antigravity-setup/payload/...`), and leave the old scripts in place until the new ones pass their tests, then say what you replaced.
- The manifest format should stay the same as the Claude one (`defaults`, `env`, `isolate`, `setup`, `gates_each`, `full_gates`, `permissions`, `plans[]` with `allowed_paths`, `steps[]`, `verify`), so a plan folder written for one runner runs on the other. If agy needs a different field (model names differ), add it as an optional field and document it.
- Permissions: build the closest safe equivalent that Phase 1 proved (allow list, deny hook, sandbox, or none). If the only available mode is `--dangerously-skip-permissions`, keep the runner-side protections (scope gate, secret-file gate, rollback, `isolate` database guard, final review) and say clearly in the README that the session itself is not restricted.
- Planning skills: port `plan_feature` (fix the 46-line version to include disk-as-memory, S/M/L sizing and budgets, the N/A list, HIGH-RISK assumptions, fresh review) and add `plan_split` (file-splitting rule, plan file sections, validator, cold-reader per plan, auditor once, `phase: plans-approved` in lower-case, never start the runner itself). Port the three agents with the same checks as the Claude versions (read them and keep the intent). Port `grill-me` if skills can be invoked by name.
- Docs: update `GUIDE.md` and `INSTRUCTIONS.md` (the old ones say to copy a folder by hand and to run `plan-runner.js path\to\manifest.json`). Tell people to use `$HOME`, not `~`, in PowerShell commands (PowerShell does not expand `~` when it starts `node`).

Lessons already learned on the Claude side, so you do not repeat them:
1. A checker that can pass silently (bad regex, missing file) is worse than none. Validate verify commands.
2. A refused command must never make the session conclude the whole shell is off. Tell it to use another way, and to write `BLOCKED.md` only if the plan cannot be done without that command.
3. Anything git ignores (`.env`) is invisible to a git-tree snapshot, so fingerprint it separately.
4. Case: accept `Phase:` and `phase:` in `STATE.md`; write `phase: plans-approved` in lower case.
5. State lives outside the repos (`~/.gemini/...` or a runs folder you choose), and the run is resumable by running the same command again.
6. The runner, not the session, decides pass or fail. The session's "done" counts for nothing.

## 5. Phase 3: one-command installer for Antigravity

Goal: any teammate runs one command and gets the same setup on their machine, without hand-copying folders.

Requirements:
- Look at `claude-plan-automation/install.mjs` and reuse its design: payload folder, backup of any file it would overwrite, merge (never overwrite) of shared JSON such as `hooks.json` and `settings.json`, a receipt file for `--uninstall`, `--dry-run`, idempotent, prerequisite checks (Node 20, git, `agy` on PATH, with a clear message), and it never touches my history, projects, auth, models or unrelated settings.
- Lessons that must be built in from day one:
  1. Use the HTTPS tarball URL, never `github:owner/repo`: npm fetches `github:` over SSH and hangs without a key.
  2. npx keeps an old copy of a URL it ran before, even with `--prefer-online`. So the installer must clone the repo over HTTPS (`git clone --depth 1`, `GIT_TERMINAL_PROMPT=0`, a timeout) and run the installer found in the clone with a `--local` flag; if the clone fails, fall back to the bundled copy with a warning.
  3. Backups are essential; a stale install once overwrote newer files and only the backup saved them.
- Command shape. The repo root `package.json` currently has ONE `bin` (`kaviyarasu-dev` -> `claude-plan-automation/install.mjs`). With two bins npx cannot choose. So turn the single bin into a small router, for example `kaviyarasu-dev` -> `install-router.mjs`: no argument or `claude` runs the Claude installer (the current public command and its flags must keep working exactly as now), `antigravity` runs the Antigravity installer. Pass `--dry-run` and `--uninstall` through. The final commands should look like:
  - `npx --yes https://github.com/kaviyarasu-dev/kaviyarasu-dev/tarball/main antigravity`
  - `npx --yes https://github.com/kaviyarasu-dev/kaviyarasu-dev/tarball/main claude`
  Test that the existing Claude command still installs 18 files and still reports "unchanged" on the second run.
- Bump the version in the root `package.json` and print it when installing. Give the installer a `CLAUDE_CONFIG_DIR`-style override for the Antigravity config folder (name it clearly) so tests never touch `~/.gemini`.
- Test it: fresh install into a temp config folder, a second run (all unchanged), an update (edit one installed file, run again, see it restored with a backup), uninstall (settings merged entries removed, nothing else touched), a failed clone (warning and fallback). Do the real `npx` test only after the files are pushed; if they are not pushed yet, say what you could not test.

## 6. Tests and proof

- Offline chaos tests for the new runner with a fake `agy` (same cases as `claude-plan-automation/payload/tools/plan-runner/tests/chaos.mjs`, adapted). The suite must run with no model usage. Run it and show the pass count.
- A real `agy -p` smoke test of the permission mode you chose, with the exact flags the runner uses, in the throwaway folder: show which commands were allowed and which were refused.
- `node --check` on every `.mjs` and `.js` you wrote; JSON files parse; the validator prints VALID on a sample plan folder you create under the temp folder (not in a real repo).

## 7. Final report (your last message)

Start with one line naming the audience (me, the owner), then:
1. The capability matrix (short form) and what you decided to implement, workaround, or skip, each with a reason.
2. Every file you created or changed (paths), and every file you replaced or retired.
3. The commands: how to install (`antigravity` and `claude`), update, uninstall, plan, and run a plan folder; PowerShell-safe (`$HOME`).
4. Test results with real numbers, and the list of what you could NOT verify.
5. Risks and decisions I should review, and anything unsupported that I could ask Google/Antigravity for.
6. Confirmation that nothing was committed.
