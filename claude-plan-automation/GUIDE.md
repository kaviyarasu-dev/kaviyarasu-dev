# Plan automation: easy guide

Tell Claude your idea. Claude plans it. A runner builds it. You check and save it.

## The big picture

```
 YOU                 💬 CLAUDE CHAT            🖥️ TERMINAL              YOU
 give an idea  ───►  makes the plan    ───►   runner builds     ───►   read the report,
                     (you answer               the code, one plan       check the code,
                      some questions)          at a time                commit it
```

Three kinds of marks are used in this guide:

| Mark | Meaning |
|---|---|
| 💬 CHAT | You type in the Claude Code chat |
| 🖥️ TERMINAL | You type in a separate terminal (not inside Claude) |
| ⚙️ AUTO | It happens by itself |

The runner never commits and never pushes. You do that at the end.

---

## Step 0. Install (one time)

You need: Node 20+, Git, and Claude Code.

```
npx --yes --prefer-online https://github.com/kaviyarasu-dev/kaviyarasu-dev/tarball/main
```

- To update later: run the same command again.
- For Antigravity (agy): add the word `antigravity` at the end of the command.
- After the install, restart Claude Code.

---

## What do you want to do?

| I want to... | Go to |
|---|---|
| Build a **new product** ("make a trading website") | [Path 1](#path-1-a-new-product) |
| **Check my existing project** and build what is missing | [Path 2](#path-2-an-existing-project) |
| Do a **small job** (one bug, one small feature) | [Path 3](#path-3-a-small-job) |

How to read the steps:

- **Command** = what you type.
- **What happens** = what Claude does.
- **You** = what you must do.
- A `/clear` step means: type `/clear` first, so the chat is fresh. The files on disk are the memory, so nothing is lost.

---

## Path 1: a new product

A whole application. Big work: 30 to 100 plans. The runner stops after each part (epic) so you can look at the app.

```
 💬 /plan-research ─► /clear ─► 💬 /plan-feature ─► /clear ─► 💬 /plan-split
                                                                    │
                                                                    ▼
                          ┌──────────────────────────────── 🖥️ run.mjs run
                          │                                         │
                          │                                  stops at a milestone?
                          ▼                                         │
                  💬 /plan-replan ◄─────────────────────────────────┘
                          │
                          └──► 🖥️ run the same command again ──► ⚙️ done ──► YOU commit
```

### 1. Research 💬

```
/plan-research a trading website with all standard features
```

- **What happens:** Claude searches the web. It finds similar products, the features a full product has, the rules, the laws and the vendors. Every claim has a source.
- **You:** Answer 3 or 4 questions (who are the users, which country, what kind of product). Then choose which features are IN. Claude recommends all MUST items.

`/clear`

### 2. Interview and spec 💬

```
/plan-feature <slug>
```

- **What happens:** Claude does not ask again what you chose in step 1. It asks about the stack, data, API, login, tests and deploy. Then it writes the spec and `ARCHITECTURE.md` (the locked decisions).
- **You:** Answer the questions (up to 45). Approve the spec and the architecture. If you say "skip", Claude picks a default and writes it down as an assumption.

`/clear`

### 3. Split into plans 💬

```
/plan-split <slug>
```

- **What happens:** Claude cuts the work into epics and plan files. Plan 001 builds the skeleton. The last epic is "ready for production". A script and fresh reviewers check the plans.
- **You:** Look at the plan table. Approve it. Then `STATE.md` says `phase: plans-approved`.

### 4. Build 🖥️ (separate terminal)

```
node $HOME/.claude/tools/plan-runner/run.mjs run <slug>
```

- **Note:** Write `$HOME`, not `~`. PowerShell does not understand `~` here.
- **What happens:** Each plan runs in its own fresh Claude session. Each step has a check. A failed step is rolled back. Each step gets 3 tries. At the end of an epic, it pauses at a milestone.
- **You:** Watch. When it pauses, look at the app.

### 5. Milestone pause, or a failure 💬

```
/plan-replan <slug>
```

- **What happens:** If the pause is fine, just run the same command again. If a whole-app check failed, `/plan-replan` writes a repair plan.
- **You:** Approve the replan table. Then run the same build command again.

### 6. Finish ⚙️

- **What happens:** A final security review goes into the report. You see `Result: DONE`.
- **You:** Read `REPORT.md`. Look at the diff. Commit it.

---

## Path 2: an existing project

The project already has code. First Claude checks it and tells you what is missing. Then it plans and builds.

```
 💬 /plan-audit ─► /clear ─► 💬 /plan-research ─► /clear ─► 💬 /plan-feature ─► /clear ─► 💬 /plan-split ─► 🖥️ run
                              (optional)
```

### 1. Audit 💬

```
/plan-audit the shop backend
```

- **What happens:** One read-only agent reads each module. It finds gaps (done, half done, missing), security problems and speed problems. Every finding has `file:line` proof. It does not run anything and does not write code.
- **You:** Approve the module list. Then approve the summary and the CRITICAL and HIGH findings.

### 2. Research (optional) 💬

```
/plan-research <slug>
```

- **What happens:** Claude searches the web only for what the audit could not show. You can skip this step for a small change.
- **You:** Choose which audit findings are IN. Claude recommends all CRITICAL and HIGH.

`/clear`

### 3. Interview and spec 💬

```
/plan-feature <slug>
```

- **What happens:** It does not ask again what the audit and research already settled. It asks only the rest.
- **You:** Answer. Approve the spec.

`/clear`

### 4. Split into plans 💬

```
/plan-split <slug>
```

- **What happens:** Claude writes the plans.
- **You:** Approve the plan table. Remember: the runner needs clean repos.

### 5. Build 🖥️ (separate terminal)

```
node $HOME/.claude/tools/plan-runner/run.mjs run <slug>
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

- **What happens:** Claude works in this chat. It writes a checklist, runs each check and keeps going until all checks pass. It stops only when it needs you (a secret, a deploy, a big choice).
- **You:** Say the goal and how we know it is done. The rest is automatic.
- **Note:** This setup installs `/goal` for Claude Code. Antigravity (agy) already has `/goal` built in.

### Way 2: let the runner build it 💬 then 🖥️

```
/plan-feature add CSV export to the orders page
```

- **What happens:** A small job (size S or M) becomes one plan file. There are fewer questions (6 to 15).
- **You:** Answer. Approve the spec.

`/clear`, then:

```
/plan-split <slug>
```

- **What happens:** One plan file with steps. Each step has a check.
- **You:** Approve.

Then, in a separate terminal 🖥️:

```
node $HOME/.claude/tools/plan-runner/run.mjs run <slug>
```

- **What happens:** It runs with nobody there.
- **You:** Read `REPORT.md`. Look at the diff. Commit.

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

### How to read REPORT.md

Read these three parts first:

1. **Done differently from the plan.** Something was built another way.
2. **Changed outside the allowed paths.** Some extra files changed.
3. **You must check.** Things a machine cannot check, such as how a screen looks.

Where is it? `$HOME/.claude/plan-runs/<repo>__<slug>/REPORT.md`
Every failed try is saved in `plans/<id>/failures.log`.

---

## Cheat sheet

| Command | What it does |
|---|---|
| `/plan-audit` | Reads your code module by module. Writes `AUDIT.md` (gaps, security, speed). |
| `/plan-research` | Searches the web. Shows the feature list. You pick what is IN. |
| `/plan-feature` | Asks questions. Writes the spec. For big work also `ARCHITECTURE.md`. |
| `/plan-split` | Cuts the spec into plan files. Fresh agents check them. |
| `/plan-replan` | After a milestone pause, updates the plans that have not run yet. |
| `/goal` | Small job. Works in this chat until it is finished. |
| `run.mjs status <slug>` | Shows where the run is. Runs nothing. |
| `run.mjs run <slug> --dry-run` | Shows what would happen. Runs nothing. |
| `run.mjs run <slug> --reset` | Starts again from the beginning (repos must be clean). |

Remember: the runner never commits and never pushes. After it finishes, you check the diff and commit it yourself.
