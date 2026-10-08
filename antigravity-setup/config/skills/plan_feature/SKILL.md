---
name: plan-feature
description: Start this skill only when the user explicitly requests to plan a feature or asks you to run the planning system. Do not run this automatically.
---
# Plan Feature Skill
1. Create or resume `docs/plans/{slug}/_planning/STATE.md` and `requirements.md`.
2. Review project rules and deployed code.
3. Ask the user questions to define the requirements, respecting the question budget based on size (S: 6, M: 15, L: 30).
4. After finalizing requirements, invoke `invoke_subagent` with the `plan-reviewer` agent.
5. Create the plan files and `manifest.json`.
   - **Directory Structure**: Group plans into numbered requirement folders (e.g., `docs/plans/{slug}/01-setup/`).
   - **Task Files**: Number task files starting from `001` inside each folder (e.g., `01-setup/001-setup.md`).
   - **File Splitting Rule (CRITICAL for Performance)**:
     - Small/Medium Requirements: Keep the entire plan in a SINGLE file (e.g., `01-setup/001-setup.md`). Do not split small tasks into multiple files.
     - Large Requirements: Split into multiple files based on logical size only if strictly necessary.
     - Too Large Requirements: Split into medium/large segments.
     - *Why? Each plan file requires a full cold-boot of the CLI. Minimizing files for small tasks saves massive execution time.*
   - **Mandatory Plan Markdown Blueprint (CRITICAL FOR QUALITY)**:
     Every plan file you generate MUST strictly follow this high-depth structure. Adapt sections like Math/Domain to the context (e.g. replace Math with UX guidelines for frontend), but the rigor must remain extreme.
     1. **`EXECUTION_CONTRACT` (YAML block)**: Must include `depends_on`, `reads`, `produces`, `exposes`, `must_not_modify`, `test_plan` (with exact commands), `definition_of_done` (with list of items and exact verification scripts/commands), `failure_modes_and_recovery`, and `handoff`.
     2. **Goal & Scope / User Jobs Served**: Highly detailed explanation of what this phase achieves.
     3. **Architecture / SOLID Principles Application**: Explicit mapping of which classes/modules handle which responsibilities (SRP, OCP, DIP, etc.).
     4. **Domain/Math/Core Logic Specifications**: Explicit formulas, exact state machine logic, edge-case handling rules, or strict UX rules. Do not be vague. Use actual equations, SQL snippets, or JSON payload examples.
     5. **Domain Contracts & Service Interfaces**: Exact Python abstract classes, TypeScript interfaces, or API contracts.
     6. **Implementation Steps**: Numbered, actionable, explicit steps.
     7. **Verification & Acceptance Criteria**: Bullet points of exact metrics and thresholds (e.g. "Latency < 120ms", "Zero lookahead bias").
   - **Manifest**: You MUST strictly use the following JSON template for `manifest.json`. Never omit fields:
     ```json
     {
       "feature": "<slug>",
       "version": "1.0.0",
       "plans": [
         {
           "id": "01-001",
           "name": "<task-name>",
           "repo": "<repo-name>",
           "file": "01-setup/001-setup.md",
           "depends_on": [],
           "gate": false,
           "verify_command": "<command or null>",
           "prompt": "<instructions to execute this plan>"
         }
       ]
     }
     ```
6. Invoke `invoke_subagent` with `plan-cold-reader` and `plan-auditor` to verify the plan. If they reject it, you MUST rewrite the plan to fix the depth and issues before finishing.
