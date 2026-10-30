# Antigravity (agy) plan automation

Plan a feature with an interview. Split the spec into small plan files. Then a runner builds them by itself, one plan file in each fresh `agy -p` session.

```
 💬 agy chat: plan it   ───►   🖥️ Terminal: runner builds it   ───►   YOU: check and commit
```

- The runner checks every result with its own commands.
- If a check fails, it rolls back and tries again. It stops at the first real problem.
- It never commits.
- It is the Antigravity twin of [`../claude-plan-automation/`](../claude-plan-automation/README.md). It reads the same plan folders. A folder made for one runner works on the other.

## Docs

| File | What is inside |
|---|---|
| [QUICKSTART.md](QUICKSTART.md) | Easy step by step guide with pictures. Start here. |
| [GUIDE.md](GUIDE.md) | Full guide: install, audit, plan, run, problems |
| [payload/tools/plan-runner/README.md](payload/tools/plan-runner/README.md) | What the runner does, its safety rules, big runs, limits |
| [INSTRUCTIONS.md](INSTRUCTIONS.md) | The rules every plan session follows |
| [CAPABILITY-MATRIX.md](CAPABILITY-MATRIX.md) | What agy can and cannot do, with the command and output as proof |

## Install or update

You need: Node 20+, Git and Antigravity CLI (`agy` on PATH).

```
npx --yes https://github.com/kaviyarasu-dev/kaviyarasu-dev/tarball/main antigravity
```

| To do this | Add this |
|---|---|
| Update | Run the same command again |
| See what would change (writes nothing) | `--dry-run` |
| Remove what the installer added | `--uninstall` |

After the install, restart agy.

- Use this https tarball link. Never use `github:owner/repo`: npm gets that over SSH and hangs when you have no key.
- The installer clones the repo over https by itself, because npx keeps an old copy of a URL it has already run.
- For the Claude Code version, use the same command with `claude` (or no name) at the end.

## What it installs

It copies files into `~/.gemini` (or `AGY_GEMINI_DIR`):

| Path | What |
|---|---|
| `tools/plan-runner/` | The runner that builds the plans, and the plan checker |
| `config/skills/` | `plan-audit`, `plan-research`, `plan-feature`, `plan-split`, `plan-replan`, `grill-me` |
| `config/agents/` | `requirements-reviewer`, `plan-cold-reader`, `plan-auditor`, `plan-module-auditor` |
| `config/scripts/planning-context.mjs` and one entry in `config/hooks.json` | A reminder to read the planning files again while a feature is being planned |

- Before it overwrites a file, it saves a copy.
- It removes the known files of the first, hand-copied Antigravity setup (`plan-runner.js`, the `plan_feature` skill).
- It does not touch your history, projects, auth, models, MCP servers, plugins or settings.

## Use in short

| I want... | Start with (in agy) |
|---|---|
| A whole new application | `/plan-research <product>` |
| To check an existing project and build what is missing | `/plan-audit <project>` |
| One feature | `/plan-feature <idea>` |
| A small job, in the current chat | `/goal <what to finish and how we will know it is done>` |

`/goal` is built into agy, so this setup does not install it.

For the first three, then:

```
new agy session  →  /plan-feature <slug> (if you are not there yet)  →  new agy session  →  /plan-split <slug>
```

Then, in a **separate terminal**, from the main repo:

```
node $HOME/.gemini/tools/plan-runner/run.mjs run <slug>
```

- Write `$HOME`, not `~`.
- If it stops, read `$HOME/.gemini/plan-runs/<repo>__<slug>/REPORT.md`. Fix the plan file or the environment (not the code by hand). Run the same command again.

Full steps: [QUICKSTART.md](QUICKSTART.md) or [GUIDE.md](GUIDE.md).

## Folders

```
payload/       what the installer copies into ~/.gemini
tests/         chaos.mjs (fake agy), guard.mjs, drift.mjs, installer.mjs
               real-smoke.mjs and real-run.mjs (these use a little model quota)
install.mjs    the installer
```

Tests that use no model:

| Command | Note |
|---|---|
| `node tests/guard.mjs` | |
| `node tests/drift.mjs` | Also checks that this setup and the Claude setup agree |
| `node tests/installer.mjs` | |
| `node tests/chaos.mjs` | Slow on Windows. Allow an hour or more. |

These files are copies of one person's own agy setup. The installer never installs them: `config/config.json`, `config/mcp_config.json`, `config/projects/`, `config/.migrated`.
