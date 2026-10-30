# Antigravity plan automation: easy guide

Tell agy your idea. agy plans it. A runner builds it. You check and save it.

This is the short, simple guide. The full English guide is [GUIDE.md](GUIDE.md). The Claude Code version is [../claude-plan-automation/GUIDE.md](../claude-plan-automation/GUIDE.md).

## The big picture

```
 YOU                 💬 AGY CHAT               🖥️ TERMINAL              YOU
 give an idea  ───►  makes the plan    ───►   runner builds     ───►   read the report,
                     (you answer               the code, one plan       check the code,
                      some questions)          at a time                commit it
```

| Mark | Meaning |
|---|---|
| 💬 CHAT | You type in the agy chat |
| 🖥️ TERMINAL | You type in a separate terminal (not inside agy) |
| ⚙️ AUTO | It happens by itself |

The runner never commits and never pushes. You do that at the end.

---

## Step 0. Install (one time)

You need: Node 20+, Git, and Antigravity CLI (`agy`). Sign in to `agy` once before.

```
npx --yes https://github.com/kaviyarasu-dev/kaviyarasu-dev/tarball/main antigravity
```

- To see the changes first, without writing anything: add `--dry-run`.
- To update: run the same command again. To remove: add `--uninstall`.
- After the install, restart agy. Then it loads the new skills, agents and hook.
- Everything goes into `~/.gemini` (or the folder in `AGY_GEMINI_DIR`).
- Use this https tarball link. Do not use `github:owner/repo`. That one goes through SSH and hangs when you have no key.

---

## What is different from Claude Code?

| Claude Code | Antigravity (agy) |
|---|---|
| `/clear` | Start a **new agy session** (close agy, then type `agy` again) |
| `~/.claude/tools/plan-runner/run.mjs` | `$HOME/.gemini/tools/plan-runner/run.mjs` |
| `~/.claude/plan-runs/...` | `$HOME/.gemini/plan-runs/...` |
| `/goal` is installed by this setup | `/goal` is **built into agy**. This setup does not install it. |
| `AskUserQuestion` | `ask_question` (we have not yet tested how it works when you type live) |

The plan folders are the same for both tools. A plan folder made in Claude can be run by the agy runner. A plan folder made in agy can be run by the Claude runner.

---

## What do you want to do?

| I want to... | Go to |
|---|---|
| Build a **new product** ("make a trading website") | [Path 1](#path-1-a-new-product) |
| **Check my existing project** and build what is missing | [Path 2](#path-2-an-existing-project) |
| Do a **small job** (one bug, one small feature) | [Path 3](#path-3-a-small-job) |

How to read the steps:

- **Command** = what you type.
- **What happens** = what agy does.
- **You** = what you must do.
- 🔄 **New session** = close agy and start `agy` again. The files on disk are the memory, so nothing is lost.

---

## Path 1: a new product

A whole application. Big work: 30 to 100 plans. The runner stops after each part (epic) so you can look at the app.

```
 💬 /plan-research ─► 🔄 ─► 💬 /plan-feature ─► 🔄 ─► 💬 /plan-split
                                                          │
                                                          ▼
                          ┌─────────────────────── 🖥️ run.mjs run
                          │                               │
                          │                        stops at a milestone?
                          ▼                               │
                  💬 /plan-replan ◄───────────────────────┘
                          │
                          └──► 🖥️ run the same command again ──► ⚙️ done ──► YOU commit
```

### 1. Research 💬

```
/plan-research a trading website with all standard features
```

- **What happens:** agy searches the web. It finds similar products, the features a full product has, the rules, the laws and the vendors. Every claim has a source.
- **You:** Answer 3 or 4 questions (who are the users, which country, what kind of product). Then choose which features are IN. agy recommends all MUST items.

🔄 New session

### 2. Interview and spec 💬

```
/plan-feature <slug>
```

- **What happens:** agy does not ask again what you chose in step 1. It asks about the stack, data, API, login, tests and deploy. Then it writes the spec and `ARCHITECTURE.md`. All your answers are saved in `docs/plans/<slug>/_planning/requirements.md`.
- **You:** Answer the questions. Approve the spec and the architecture.

🔄 New session

### 3. Split into plans 💬

```
/plan-split <slug>
```

- **What happens:** agy cuts the work into epics and plan files (`manifest.json`, `INSTRUCTIONS.md`, `NNN-name.md`, `HANDOFF.md`). A validator runs. Fresh agents read every plan and check it. Plan 001 builds the skeleton. The last epic is "ready for production".
- **You:** Look at the plan table. Approve it. Then `STATE.md` says `phase: plans-approved`. This step does not start the runner.

### 4. Build 🖥️ (separate terminal, not inside agy)

Every repo must have no uncommitted changes.

```
node $HOME/.gemini/tools/plan-runner/run.mjs run <slug>
```

- **Note:** Write `$HOME`, not `~`. PowerShell does not understand `~` here. `$HOME` works in PowerShell and in Git Bash.
- **What happens:** Each plan runs in its own fresh `agy -p` session. Each step has a check. A failed step is rolled back. Each step gets 3 tries. At the end of an epic, it pauses at a milestone.
- **You:** Watch. When it pauses, look at the app.

### 5. Milestone pause, or a failure 💬

```
/plan-replan <slug>
```

- **What happens:** If the pause is fine, just run the same command again. If a whole-app check or the final review failed, `/plan-replan` writes a repair plan.
- **You:** Approve the replan table. Then run the same build command again.

### 6. Finish ⚙️

- **What happens:** A final security review goes into the report.
- **You:** Read `REPORT.md`. Look at the diff in each repo. Commit it.

---

## Path 2: an existing project

The project already has code. First agy checks it and tells you what is missing. Then it plans and builds.

```
 💬 /plan-audit ─► 🔄 ─► 💬 /plan-research ─► 🔄 ─► 💬 /plan-feature ─► 🔄 ─► 💬 /plan-split ─► 🖥️ run
                          (optional)
```

### 1. Audit 💬

```
/plan-audit the shop backend
```

- **What happens:**
  - The module list goes to `docs/plans/<slug>/_planning/audit/MODULES.md`. You confirm it.
  - One read-only agent reads each module. It finds gaps (done, half done, missing), security problems and speed problems.
  - All reports are merged into `AUDIT.md`.
  - Every finding has `file:line` proof, a severity (CRITICAL, HIGH, MEDIUM, LOW) and a fix.
  - What it cannot prove is written as "not checked". It does not guess.
  - It runs nothing: no test, no linter, no scanner. It does not open `.env` or keys. It writes no code.
- **You:** Approve the module list. Then approve the summary and the CRITICAL and HIGH findings. Then `STATE.md` says `phase: audit-approved`.

If it stops in the middle: start a new session and run the same command. `STATE.md` lists each module as pending, done or failed. Only the unfinished modules are checked again.

🔄 New session

### 2. Research (optional) 💬

```
/plan-research <slug>
```

- **What happens:** agy reads `AUDIT.md`. It searches the web only for what the code could not show. You can skip this step for a small change.
- **You:** Choose which audit findings are IN. agy recommends all CRITICAL and HIGH.

🔄 New session

### 3. Interview and spec 💬

```
/plan-feature <slug>
```

- **What happens:** agy reads `AUDIT.md` and the research. It does not ask again what is already settled. It asks only the rest.
- **You:** Answer. Approve the spec.

🔄 New session

### 4. Split into plans 💬

```
/plan-split <slug>
```

- **What happens:** agy writes the plans.
- **You:** Approve the plan table. Remember: the runner needs clean repos.

### 5. Build 🖥️ (separate terminal)

```
node $HOME/.gemini/tools/plan-runner/run.mjs run <slug>
```

- **What happens:** Same as Path 1. The git tree must be clean. The runner does not commit.
- **You:** Make a new branch first. Then watch and read `REPORT.md`.

---

## Path 3: a small job

Do not use plans for tiny work. You have two ways.

### Way 1: do it in this chat 💬

```
/goal fix login redirect, done when npm test passes
```

- **What happens:** agy works in this chat until the goal is done.
- **You:** Say the goal and how we know it is done.
- **Note:** `/goal` is already built into agy. This setup does not install it. That is why it is not in the install list.

### Way 2: let the runner build it

#### 1. Plan the feature 💬

```
/plan-feature add an export button to the report screen
```

- **What happens:** agy reads your code first. It asks only what the code cannot answer. The number of questions depends on the size (S, M, L). Each answer is saved in `requirements.md`. A fresh agent reviews it. Then it writes the spec.
- **You:** Answer. Approve the spec.

🔄 New session

#### 2. Split 💬

```
/plan-split <slug>
```

- **What happens:** A small job (size S or M) becomes one plan file with steps. Each step has a check.
- **You:** Approve.

#### 3. Build 🖥️

```
node $HOME/.gemini/tools/plan-runner/run.mjs run <slug>
```

- **What happens:** It runs with nobody there.
- **You:** Read `REPORT.md`. Look at the diff. Commit.

---

## Runner options

| Command | What it does |
|---|---|
| `run.mjs run <slug> --dry-run` | Checks agy, the model names, the safety guard and the plan folder. Does not use the model. |
| `run.mjs status <slug>` | Shows where the run is. |
| `run.mjs run <slug> --reset` | Starts again from the beginning (repos must be clean). |
| `run.mjs run <slug> --reset --from <id>` | Starts again. Plans before `<id>` count as done (their work must be committed). |
| `run.mjs run <slug> --no-isolation` | Uses your own agy settings. The session is **not restricted**. Use it only if agy cannot start in the throwaway HOME. |
| `validate.mjs docs/plans/<slug>` | Checks only the plan folder. |

To stop: press Ctrl+C. The next time you start, the runner rolls the current plan back to its last good step.

---

## The runner stopped. Do not panic.

```
 stopped ─► read REPORT.md ─► fix the PLAN FILE (not the code) ─► run the same command ─► continues
```

| Do this | Why |
|---|---|
| Read `REPORT.md` first | It tells you what went wrong |
| Fix the plan file or the environment | The problem is there, not in the code |
| Run the same `run` command again | Steps that passed are kept and checked again |

| Never do this | Why |
|---|---|
| Edit the code by hand while it is stopped | The runner will refuse to start |
| Start with a dirty git tree | Commit or stash first |
| Run two runners for one feature | There is a lock |

Work that a rollback threw away is saved as `.patch` files in the run folder.

### How to read REPORT.md

Read these three parts first:

1. **Done differently from the plan.** Something was built another way.
2. **Changed outside the allowed paths.** Some extra files changed.
3. **You must check.** Things a machine cannot check, such as how a screen looks.

After these, the report shows: why it stopped, what was not done, weak checks, every failed try (full reason in `plans/<id>/failures.log`), commands the guard refused, changed files, new dependencies, the session reports, and a security review of the whole diff.

Where is it? `$HOME/.gemini/plan-runs/<repo>__<slug>/REPORT.md`. A copy is also in the plan folder.

---

## Problems and fixes

| You see | Why | What to do |
|---|---|---|
| `Cannot find module ...\~\.gemini\...` | PowerShell does not understand `~` | Use `$HOME` |
| `REFUSED TO START: ... has uncommitted changes` | The runner wants clean repos, so a rollback cannot lose your work | Commit or stash first |
| `REFUSED TO START: The model "..." is not available` | The model name in `config/models.json` or in the manifest is not in `agy models` | Fix the name |
| `agy could not start in its isolated HOME` | agy could not sign in or start in the throwaway HOME (a risk on macOS and Linux) | Run `agy` once normally, or use `--no-isolation` |
| `This manifest is in the OLD Antigravity format` | The plan folder was made by the first Antigravity setup | Run `/plan-split <slug>` again |
| `Usage limit reached. Waiting ...` | Your quota or credits ran out | Leave it. It waits and tries again. It does not use up a try. |
| The session is "BLOCKED" | It needed something that is not allowed, or the plan is not clear | Read the reason in the report. Fix the plan or the rule. Run again. |

---

## How the agy runner is different from the Claude runner

- The plan folder and the manifest are the same. In the manifest, `model: sonnet` and `opus` are mapped to agy models in `tools/plan-runner/config/models.json`.
- Each session runs in its own throwaway HOME, with a generated settings file and a safety hook. The reason: agy has no "refuse instead of ask" flag and no way to skip your own plugins and rules.
- agy counts tool calls, not turns. So the runner counts tool calls itself (about 3 per manifest turn).
- agy says SUCCESS even when a tool call was refused. So the runner trusts only its own checks. If a session commits or switches branch, the run stops.
- `--sandbox` cannot be used in agy (it hid node, git and npm). Quota errors were never produced in our tests. Details: [CAPABILITY-MATRIX.md](CAPABILITY-MATRIX.md).

Remember: the runner never commits and never pushes. After it finishes, you check the diff and commit it yourself.
