# Legacy: the first Antigravity setup

These files were the hand-copied setup that the installer replaced. They are kept for reference only. Nothing here is installed, and the installer removes the same files from a machine that still has them. They still contain the hardcoded user paths they had (`C:\Users\...`), on purpose: do not copy them anywhere.

| File | Replaced by |
|---|---|
| `config/scripts/plan-runner.js` | `payload/tools/plan-runner/run.mjs` (checkpoints, rollback, runner-side checks, resume, tests) |
| `config/scripts/plan-runner-2.js` | retired. It drove ONE long-lived agy session with `--input-format stream-json`; agy keeps one conversation for the whole session (`num_turns` and `usage` are cumulative per the headless docs), so plans shared memory and could not be isolated. A fresh `agy -p` per plan is the design now. |
| `config/scripts/validate-manifest.js` | `payload/tools/plan-runner/validate.mjs` |
| `config/scripts/reminder_hook.js`, `config/hooks.json` | `payload/config/scripts/planning-context.mjs` (reminds only while a feature is being planned) |
| `config/skills/plan_feature/SKILL.md` | `payload/config/skills/plan-feature/SKILL.md` and `plan-split/SKILL.md` |
| `config/agents/plan_reviewer.md`, `plan_cold_reader.md`, `plan_auditor.md` | `payload/config/agents/requirements-reviewer.md`, `plan-cold-reader.md`, `plan-auditor.md` |
| `GUIDE.md`, `INSTRUCTIONS.md` | `../GUIDE.md`, `../INSTRUCTIONS.md` (plain English, `$HOME`) |

The old manifest format (`repo`, `gate`, `verify_command`, `prompt`) is not supported any more. The validator says so and tells you how to convert.
