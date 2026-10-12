# Antigravity plan automation: guide

This replaces the old "copy the `.gemini\config` folder by hand" instructions. One command installs everything.

## 1. Install on a new machine

You need Node 20+, Git, and Antigravity CLI (`agy`) signed in once.

```
npx --yes https://github.com/kaviyarasu-dev/kaviyarasu-dev/tarball/main antigravity
```

It prints what it adds (`add`, `update`, `remove old`) and where backups go. Run it with `--dry-run` first if you want to see the changes without making them. Restart agy afterwards so it loads the new skills, agents and hook.

On a machine that already has the first setup (`plan-runner.js`, the `plan_feature` skill), the installer removes those known old files (the originals are in `legacy/`). Nothing else in `~/.gemini` is changed.

**Update:** run the same command again. **Remove:** add `--uninstall`.

## 2. Plan a feature

In your project folder, open agy and type:

```
/plan-feature add an export button to the report screen
```

It reads your code first, asks only what the code cannot answer (in batches, with a question budget by size S, M or L), writes every answer to `docs/plans/<slug>/_planning/requirements.md`, has a fresh agent review it, and writes a spec. Then start a **fresh** agy session and type:

```
/plan-split <slug>
```

It writes the plan folder (`manifest.json`, `INSTRUCTIONS.md`, `NNN-name.md`, `HANDOFF.md`), runs the validator, has a fresh agent read each plan and another audit the whole folder, shows you the table, and after your approval sets `phase: plans-approved`. It never starts the runner itself.

## 3. Run the plans

Every repo in the plan must have no uncommitted changes. Then, in a **separate terminal** (not inside agy), from the main repo:

```
node $HOME/.gemini/tools/plan-runner/run.mjs run <slug>
```

Use `$HOME`, not `~`. PowerShell does not expand `~` when it starts `node` (you would see "Cannot find module ...\~\.gemini\..."). `$HOME` works in PowerShell and in Git Bash. If you installed with `AGY_GEMINI_DIR`, use that folder instead of `$HOME/.gemini`.

Useful variations:

| Command | What it does |
|---|---|
| `run.mjs run <slug> --dry-run` | Checks agy, the model names, the safety guard and the plan folder without using the model. |
| `run.mjs status <slug>` | Shows where the run is. |
| `run.mjs run <slug> --reset` | Starts over (the repos must be clean). |
| `run.mjs run <slug> --no-isolation` | Uses your own agy settings. The session is NOT restricted. Only if agy cannot start in the throwaway HOME. |
| `validate.mjs docs/plans/<slug>` | Checks a plan folder only. |

Stop with Ctrl+C. The runner rolls the current plan back to its last good step the next time you start it.

## 4. When it stops

Read `$HOME/.gemini/plan-runs/<repo>__<slug>/REPORT.md` (a copy is also in the plan folder). It says why it stopped, which files changed, which commands the guard refused, new dependencies, the things only a person can check, and a security review of the whole diff. Fix the cause and run the same command again: it resumes at the plan that stopped. Work thrown away by a rollback is saved as `.patch` files in the run folder.

The runner never commits. When it finishes, review the diff in each repo and commit it yourself.

## 5. Troubleshooting

| You see | Why | Do this |
|---|---|---|
| `Cannot find module ...\~\.gemini\...` | PowerShell does not expand `~` | Use `$HOME` |
| `REFUSED TO START: ... has uncommitted changes` | the runner needs clean repos so a rollback cannot lose your work | commit or stash first |
| `REFUSED TO START: The model "..." is not available` | a model name in `config/models.json` or the manifest is not in `agy models` | fix the name |
| `agy could not start in its isolated HOME` | agy could not sign in or start there (seen as a risk on macOS and Linux) | run `agy` once normally, or use `--no-isolation` |
| `This manifest is in the OLD Antigravity format` | the plan folder was made by the first Antigravity setup | run `/plan-split <slug>` again |
| `Usage limit reached. Waiting ...` | quota or credits ran out | leave it: it waits and retries without using an attempt |
| the session is "BLOCKED" | it needed something it was not allowed to do, or the plan is unclear | read the reason in the report, fix the plan or the rule, run again |

## 6. Differences from the Claude Code runner

- Same plan folders and manifest. `model: sonnet` and `opus` are mapped to agy models in `tools/plan-runner/config/models.json`.
- Each session runs in its own throwaway HOME with a generated settings file and a safety hook, because agy has no "refuse instead of ask" flag and no way to skip your own plugins and rules.
- agy counts tool calls, not turns, so the runner counts tool calls itself (about 3 per manifest turn).
- agy says SUCCESS even when a tool call was refused, so the runner trusts only its own checks, plus a new one: a session that commits or switches branch halts the run.
- Details and measured limits: [CAPABILITY-MATRIX.md](CAPABILITY-MATRIX.md).
