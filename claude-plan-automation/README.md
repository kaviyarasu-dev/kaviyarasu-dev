# Claude plan automation

Plan a feature with Claude Code, then let it build the feature unattended, one plan file at a time, with checks after every step.

## Install or update (one command)

Needs Node 20+, Git, and Claude Code. On Windows, Git for Windows (Git Bash) is also needed.

```
npx --yes --prefer-online https://github.com/kaviyarasu-dev/kaviyarasu-dev/tarball/main
```

Run the same command again to update. The installer always downloads the newest files from GitHub itself (npx keeps old copies of a URL, so it cannot be trusted to do that). Other options:

```
npx --yes --prefer-online https://github.com/kaviyarasu-dev/kaviyarasu-dev/tarball/main --dry-run     # show what would change, write nothing
npx --yes --prefer-online https://github.com/kaviyarasu-dev/kaviyarasu-dev/tarball/main --uninstall   # remove what the installer added
```

The command can also be written with a name: add `claude` after the URL for this setup, or `antigravity` for the Antigravity (agy) version in [`../antigravity-setup/`](../antigravity-setup/README.md). With no name it installs this one, exactly as before.

## What it installs (into `~/.claude`, or `$CLAUDE_CONFIG_DIR`)

| Path | What |
|---|---|
| `tools/plan-runner/` | The unattended runner (`run.mjs`, `validate.mjs`, `checkpoint.mjs`, `config/permissions.json`) |
| `skills/plan-audit`, `skills/plan-research`, `skills/plan-feature`, `skills/plan-split`, `skills/plan-replan`, `skills/grill-me`, `skills/goal` | The `/plan-audit`, `/plan-research`, `/plan-feature`, `/plan-split`, `/plan-replan`, `/grill-me` and `/goal` commands |
| `agents/plan-*.md`, `agents/requirements-reviewer.md` | Fresh-eyes reviewers used by the skills, and `plan-module-auditor`, the read-only subagent `/plan-audit` starts once per module |
| `hooks/planning-context.sh` | Reminds Claude to re-read the planning files after a chat is compacted |
| `settings.json` | One `SessionStart` hook is added. Nothing else in the file changes. |

It does not touch your model, plugins, permissions, history, projects or MCP settings. Any file it would overwrite is first copied to `~/.claude/backups/plan-automation-<time>/`. The installer is safe to run many times.

## Use

1. In Claude Code, inside your project: `/plan-feature <idea>`, then `/clear`, then `/plan-split <slug>`.
2. In a separate terminal, in the project folder: `node $HOME/.claude/tools/plan-runner/run.mjs run <slug>` (use `$HOME`, not `~`: PowerShell does not expand `~` when it starts node).
3. Read `$HOME/.claude/plan-runs/<repo>__<slug>/REPORT.md`, sections 1 to 3 first (done differently from the plan, changed outside the plan, needs a person). If it stopped, fix the cause in the plan file or the environment (not the code by hand) and run the same command again: steps that passed are kept and re-checked.

**A project that already has code**: start with `/plan-audit <project>`. It lists the modules, has one read-only subagent audit each (feature gaps: done, half done, missing; security problems; performance problems), and merges the reports into `docs/plans/<slug>/_planning/AUDIT.md`: every finding has `file:line` evidence, a severity and a fix, and anything it could not prove is marked "not checked". It reads code only (it runs nothing, never opens secret files, writes no application code) and can be resumed after a `/clear` or a crash. After you approve `AUDIT.md` (STATE.md `phase: audit-approved`), `/clear` and run `/plan-research <slug>`: it reads the audit's gaps and findings, researches only what the code cannot show, and asks you which gaps and findings are in scope. Then `/plan-feature <slug>` and `/plan-split <slug>` as below. For a small change that needs no research, go from `/plan-audit` straight to `/plan-feature <slug>`.

**A new application** has nothing to audit: it starts at `/plan-research <product>`.

**A whole application or a very large feature** (days of work, 30 to 100 plans): start with `/plan-research <product>` (web research of the domain, you pick the scope), then `/clear` and `/plan-feature <slug>`, which also writes a locked `ARCHITECTURE.md`. The runner then pauses at each milestone for you to look at the app; when it pauses or stops on a whole-app check, run `/plan-replan <slug>`. See "Large runs" in the [runner README](payload/tools/plan-runner/README.md).

No step can be skipped: every step must be checkpointed, every step's check runs again at the end, and each session must report what it did not do (anything not done stops the run). Each step gets 3 tries, and every failed try is saved in full in `plans/<id>/failures.log`.

For a smaller job you do not need a plan: `/goal <what to finish and how we will know it is done>` keeps Claude working in the current chat until every check passes (or it is blocked and says why). It is not unattended; use the runner for that.

The runner never commits or pushes. More detail: [payload/tools/plan-runner/README.md](payload/tools/plan-runner/README.md) (or `$HOME/.claude/tools/plan-runner/README.md`).

## For the maintainer

The files to ship live in `payload/` and mirror the layout of `~/.claude`. To publish a change, edit the file in `payload/`, raise `version` in the repo-root `package.json`, and push. Everyone gets it the next time they run the command. Do not put secrets, project names or personal settings in `payload/`; this repo is public.
