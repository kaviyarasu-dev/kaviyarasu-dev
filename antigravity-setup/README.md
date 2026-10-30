# Antigravity (agy) plan automation

Plan a feature with an interview, split the spec into small plan files, then let an unattended runner execute one plan file per fresh `agy -p` session. The runner checks every result with its own commands, rolls back on failure, retries, and stops at the first real problem. It never commits. It is the Antigravity twin of [`../claude-plan-automation/`](../claude-plan-automation/README.md) and reads the same plan folders, so a folder written for one runner runs on the other.

## Install (one command)

Needs Node 20+, Git and Antigravity CLI (`agy` on PATH).

```
npx --yes https://github.com/kaviyarasu-dev/kaviyarasu-dev/tarball/main antigravity
```

- Check first: add `--dry-run`. Remove everything it added: add `--uninstall`. Update: run the same command again.
- It installs into `~/.gemini` (or the folder in `AGY_GEMINI_DIR`): skills `plan-audit`, `plan-research`, `plan-feature`, `plan-split`, `plan-replan`, `grill-me`; agents `requirements-reviewer`, `plan-cold-reader`, `plan-auditor`, `plan-module-auditor`; the runner in `tools/plan-runner/`; one hook entry in `config/hooks.json`. It backs up any file it would overwrite, and removes the known files of the first, hand-copied Antigravity setup. It does not touch your history, projects, auth, models, MCP servers, plugins or settings.
- The Claude Code version of the same command: `npx --yes https://github.com/kaviyarasu-dev/kaviyarasu-dev/tarball/main claude` (or no name at all, as before).
- Use the HTTPS tarball URL, never `github:owner/repo` (npm fetches that over SSH and hangs without a key). The installer clones the repo over HTTPS itself, because npx keeps an old copy of a URL it has already run.

## Use

0. **A project that already has code:** `/plan-audit <project>` in agy first. It lists the modules, has one read-only subagent audit each (feature gaps: done, half done, missing; security problems; performance problems), and merges the reports into `docs/plans/<slug>/_planning/AUDIT.md`: every finding has `file:line` evidence, a severity and a fix, and anything it could not prove is marked "not checked". It reads code only (runs nothing, never opens secret files, writes no application code) and can be resumed in a fresh session. After you approve it (STATE.md `phase: audit-approved`), start a fresh session and run `/plan-research <slug>`: it reads the audit's gaps and findings and asks which are in scope. A **new** application has nothing to audit and starts at `/plan-research <product>`.
1. `/plan-feature <idea>` in agy (it also reads `AUDIT.md` when there is one): an interview, then a reviewed spec.
2. Start a fresh agy session, then `/plan-split <slug>`: plan files, a validated manifest, fresh-eyes review.
3. In a **separate terminal**, from the main repo: `node $HOME/.gemini/tools/plan-runner/run.mjs run <slug>` (use `$HOME`, not `~`: PowerShell does not expand `~` when it starts node).
4. Read `$HOME/.gemini/plan-runs/<repo>__<slug>/REPORT.md`, sections 1 to 3 first (done differently from the plan, changed outside the plan, needs a person). If it stopped, fix the cause in the plan file or the environment (not the code by hand) and run the same command again: steps that passed are kept and re-checked.

**A whole application or a very large feature** (days of work, 30 to 100 plans): start with `/plan-research <product>` (web research of the domain, you pick the scope), then a fresh session and `/plan-feature <slug>`, which also writes a locked `ARCHITECTURE.md`. The runner then pauses at each milestone for you to look at the app; when it pauses or stops on a whole-app check, run `/plan-replan <slug>`. See "Large runs" in the [runner README](payload/tools/plan-runner/README.md).

No step can be skipped: every step must be checkpointed, every step's check runs again at the end, and each session must report what it did not do (anything not done stops the run). Each step gets 3 tries, and every failed try is saved in full in `plans/<id>/failures.log`.

Details: [GUIDE.md](GUIDE.md) (step by step), [payload/tools/plan-runner/README.md](payload/tools/plan-runner/README.md) (what the runner does and its limits), [INSTRUCTIONS.md](INSTRUCTIONS.md) (the rules every plan session follows).

## What was measured, and what Antigravity cannot do

[CAPABILITY-MATRIX.md](CAPABILITY-MATRIX.md) lists all 28 features, with the exact command and output behind each answer. The short version:

- **Works as is:** a fresh session per `-p` run, stream-json events, a refusal instead of a prompt for anything not allowed, `PreToolUse` hooks that can refuse a tool call, skills as slash commands, sub-agents, `--json-schema`.
- **Needed a workaround:** no max-turns flag (the runner counts tool calls), no per-run settings or way to skip your plugins and rules (each run gets its own throwaway HOME), literal `command(...)` deny rules did not match in our tests (regex rules and a guard hook are used), no "after compaction" event (a `PreInvocation` reminder), no `disable-model-invocation` for skills.
- **Not usable or not provable:** `--sandbox` (it hid node, git and npm), quota errors (documented, not reproduced), `agy -p "/usage"`, interactive `ask_question` and the macOS and Linux behaviour of the throwaway HOME.

## Layout

```
payload/             what the installer copies into ~/.gemini
  config/skills/     plan-audit, plan-research, plan-feature, plan-split, plan-replan, grill-me
  config/agents/     requirements-reviewer, plan-cold-reader, plan-auditor, plan-module-auditor
  config/scripts/    planning-context.mjs (a PreInvocation reminder while a feature is being planned)
  tools/plan-runner/ run.mjs, validate.mjs, checkpoint.mjs, assert.mjs, lib/, config/
tests/               chaos.mjs (fake agy), guard.mjs, drift.mjs, installer.mjs; real-smoke.mjs and real-run.mjs (use a little model quota)
legacy/              the first Antigravity setup (hand-copied folder, plan-runner.js). Kept for reference only; the installer removes these files from a machine. See legacy/README.md.
install.mjs          the installer
CAPABILITY-MATRIX.md what agy can and cannot do, with evidence
```

Tests with no model usage: `node tests/guard.mjs` (204 checks), `node tests/drift.mjs` (also checks that `/plan-audit`, its agent and the STATE.md phase names agree with the Claude setup), `node tests/chaos.mjs` (39 cases, slow on Windows: allow an hour or more), `node tests/installer.mjs` (48 checks). With real agy (spends a little quota): `node tests/real-smoke.mjs` (one session, shows what the guard allowed and refused) and `node tests/real-run.mjs` (the real runner on a toy plan).

`config/config.json`, `config/mcp_config.json`, `config/projects/` and `config/.migrated` are copies of one person's local agy setup. The installer never installs them.
