# Rules every plan session follows

`/plan-split` writes these rules into `docs/plans/<slug>/INSTRUCTIONS.md`, and the runner tells every session to read that file first. This copy is the reference. If you write a plan folder by hand, copy it.

An unattended session is started by the plan runner. Nobody can answer its questions.

1. Do only the plan you are given. Do not start another plan or fix unrelated problems.
2. Never ask the user a question. If you cannot continue, write the reason and what you tried to `BLOCKED.md` in the plan folder, then stop.
3. Never commit, push or change git state. The runner snapshots and rolls back by itself. A session that moves HEAD or switches branch stops the whole run.
4. Check the current state of the files before you change anything. A plan can be retried or resumed after a crash, and some steps may already be done.
5. Follow the project rules (`GEMINI.md`, `AGENTS.md`, `CLAUDE.md`): find the root cause, think about security, performance and edge cases, reuse existing code.
6. After each numbered step run the checkpoint command from your prompt. Go to the next step only when it prints `CHECKPOINT <n> OK`. If it refuses, fix the problem and run it again.
7. Run the plan's Acceptance commands before you report that you are done.
8. Do not edit `manifest.json`, `HANDOFF.md`, checkpoint or state files, `.git/`, the real `.env` and `.env.*` (the `.env.example` family is fine), or agent settings (`.agents/hooks.json`, `.agents/hooks`, `.agents/skills`, `.agents/workflows`, `.gemini/`, `.claude/settings*.json`, `.claude/hooks`, `.claude/agents`, `.claude/skills`). Rule and doc files such as `.agents/rules` are fine. Never change files outside the project folders. The runner checks all of this and fails the try (or stops the run) if it finds such a change. Files outside the plan's allowed paths may change, but they are listed in the report, so stay inside them where you can.
9. Use the database named in the environment. Never use another one.
10. A refused tool call (git change, network, deploy, publish, secret file, recursive delete, a file outside the project) does not mean the shell is off. Do not retry the same command: do the same work another way. Never drop a task because of a refusal. Write `BLOCKED.md` only if the plan cannot be done without it.
11. Create and edit files with the file tools, not with `>` redirects: the shell on Windows is PowerShell, which writes redirected text as UTF-16. Join commands with `;`, not `&&`.
12. Never skip a step or a part of a step. Anything the plan asks for that you did not do goes in `not_done` of the final report; the run then stops so a person can decide.
13. When every step is checkpointed and the Acceptance commands pass, end with the final JSON report described in your prompt (every step done or not, `not_done`, `different_from_plan` with a reason, `needs_person_check`). The plan's "Report back" section goes in its `summary`.
