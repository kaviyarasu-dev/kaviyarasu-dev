# Claude plan automation

Plan a feature with Claude Code, then let it build the feature unattended, one plan file at a time, with checks after every step.

## Install or update (one command)

Needs Node 20+, Git, and Claude Code. On Windows, Git for Windows (Git Bash) is also needed.

```
npx --yes --prefer-online https://github.com/kaviyarasu-dev/kaviyarasu-dev/tarball/main
```

Run the same command again to update. Other options:

```
npx --yes --prefer-online https://github.com/kaviyarasu-dev/kaviyarasu-dev/tarball/main --dry-run     # show what would change, write nothing
npx --yes --prefer-online https://github.com/kaviyarasu-dev/kaviyarasu-dev/tarball/main --uninstall   # remove what the installer added
```

## What it installs (into `~/.claude`, or `$CLAUDE_CONFIG_DIR`)

| Path | What |
|---|---|
| `tools/plan-runner/` | The unattended runner (`run.mjs`, `validate.mjs`, `checkpoint.mjs`, `config/permissions.json`) |
| `skills/plan-feature`, `skills/plan-split`, `skills/grill-me` | The `/plan-feature`, `/plan-split` and `/grill-me` commands |
| `agents/plan-*.md`, `agents/requirements-reviewer.md` | Fresh-eyes reviewers used by the skills |
| `hooks/planning-context.sh` | Reminds Claude to re-read the planning files after a chat is compacted |
| `settings.json` | One `SessionStart` hook is added. Nothing else in the file changes. |

It does not touch your model, plugins, permissions, history, projects or MCP settings. Any file it would overwrite is first copied to `~/.claude/backups/plan-automation-<time>/`. The installer is safe to run many times.

## Use

1. In Claude Code, inside your project: `/plan-feature <idea>`, then `/clear`, then `/plan-split <slug>`.
2. In a separate terminal, in the project folder: `node ~/.claude/tools/plan-runner/run.mjs run <slug>`
3. If it stops, read `~/.claude/plan-runs/<repo>__<slug>/REPORT.md`, fix the cause, and run the same command again to resume.

The runner never commits or pushes. More detail: `~/.claude/tools/plan-runner/README.md`.

## For the maintainer

The files to ship live in `payload/` and mirror the layout of `~/.claude`. To publish a change, edit the file in `payload/`, raise `version` in the repo-root `package.json`, and push. Everyone gets it the next time they run the command. Do not put secrets, project names or personal settings in `payload/`; this repo is public.
