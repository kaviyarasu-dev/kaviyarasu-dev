# Claude plan automation

Plan a feature with Claude Code. Then let a runner build it by itself, one plan file at a time, with a check after every step. It never commits and never pushes.

```
 💬 Claude chat: plan it   ───►   🖥️ Terminal: runner builds it   ───►   YOU: check and commit
```

## Docs

| File | What is inside |
|---|---|
| [GUIDE.md](GUIDE.md) | Easy step by step guide with pictures. Start here. |
| [payload/tools/plan-runner/README.md](payload/tools/plan-runner/README.md) | What the runner does, its safety rules, big runs, limits. (After install, it is also at `$HOME/.claude/tools/plan-runner/README.md`.) |
| [../antigravity-setup/README.md](../antigravity-setup/README.md) | The same setup for Antigravity (`agy`) |

## Install or update

You need: Node 20+, Git and Claude Code. On Windows you also need Git for Windows (it has Git Bash).

```
npx --yes --prefer-online https://github.com/kaviyarasu-dev/kaviyarasu-dev/tarball/main
```

| To do this | Add this |
|---|---|
| Update | Run the same command again |
| See what would change (writes nothing) | `--dry-run` |
| Remove what the installer added | `--uninstall` |
| Pick a setup | `claude` (this one, the default) or `antigravity`, right after the URL |

The command always downloads the newest files from GitHub itself, because npx keeps old copies of a URL.

## What it installs

It copies files into `~/.claude` (or `$CLAUDE_CONFIG_DIR`):

| Path | What |
|---|---|
| `tools/plan-runner/` | The runner that builds the plans, and the plan checker |
| `skills/` | The commands `/plan-audit`, `/plan-research`, `/plan-feature`, `/plan-split`, `/plan-replan`, `/grill-me`, `/goal` |
| `agents/` | Helpers that review the work with fresh eyes, and `plan-module-auditor` (used by `/plan-audit`) |
| `hooks/planning-context.sh` | After a chat is compacted, it reminds Claude to read the planning files again |
| `settings.json` | One `SessionStart` hook is added. Nothing else in this file changes. |

It does not touch your model, plugins, permissions, history, projects or MCP settings. Before it overwrites a file, it saves a copy in `~/.claude/backups/plan-automation-<time>/`.

## Use in short

| I want... | Start with |
|---|---|
| A whole new application | `/plan-research <product>` |
| To check an existing project and build what is missing | `/plan-audit <project>` |
| One feature | `/plan-feature <idea>` |
| A small job, in the current chat | `/goal <what to finish and how we will know it is done>` |

Then:

```
/clear  →  /plan-feature <slug> (if you are not there yet)  →  /clear  →  /plan-split <slug>
```

Then, in a **separate terminal**, in the project folder:

```
node $HOME/.claude/tools/plan-runner/run.mjs run <slug>
```

- Write `$HOME`, not `~`. PowerShell does not understand `~` here.
- If it stops, read `$HOME/.claude/plan-runs/<repo>__<slug>/REPORT.md`. Fix the plan file or the environment (not the code by hand). Run the same command again.

Full steps: [GUIDE.md](GUIDE.md).

## For the maintainer

- The files to ship are in `payload/`. They have the same layout as `~/.claude`.
- To publish a change: edit the file in `payload/`, raise `version` in the root `package.json`, and push. Everyone gets it the next time they run the command.
- Do not put secrets, project names or personal settings in `payload/`. This repo is public.
