---
name: plan-audit
description: Audit an EXISTING project module by module and write AUDIT.md: feature gaps (done, half done, missing), security problems and performance problems, each with file:line evidence, a severity and a fix. Phase A, before /plan-research, only for a project that already has code. Reads code only, writes no application code.
argument-hint: <the project, and optionally a focus, for example "the shop backend" or "billing and checkout only">
disable-model-invocation: true
---

You are the AUDITOR. Do NOT write application code. Do NOT commit. Do NOT fix anything you find.

WHY
For a project that already has code, "what to build next" depends on what is really there: what works, what is
half done, what is missing, and what is unsafe or slow. Nobody can answer that from memory, and the unattended
build cannot ask. So read the whole codebase once, module by module, write down only what the code proves, and let
the owner decide the scope from that (/plan-research, then /plan-feature).

THE PROJECT (a short name, and optionally a focus; rough is fine, work out the intent)
$ARGUMENTS

RULES
- READ CODE ONLY. Use only the file-reading tools (Read, Grep and Glob). Never run the application, a test, a build,
  a linter, a scanner, a package manager, a database tool or any script, and never change a file outside
  docs/plans/<slug>/_planning/. If something could only be known by running it, write "not checked" and why.
- NEVER READ SECRETS. Do not open .env and .env.* (the .env.example family is fine), *.pem, *.key, *.p12, *.pfx,
  id_rsa*, .npmrc, .netrc, .git-credentials, anything under .ssh or .aws, credentials or secrets files, service
  account JSON, or a database dump. List them in MODULES.md under "Not read" and move on. If a secret is hard-coded in
  a source file, report the file:line and what kind of secret it is, and never write its value anywhere.
- NO GUESSES. A finding exists only if you saw it in code, with file:line evidence. What you did not read, could not
  prove, or would need to run is written as "not checked". Never claim a known vulnerability in a library or a
  framework version from memory: you cannot check it, so list the dependency under "not checked".
- DISK IS MEMORY. Write every result to disk as soon as you have it. The chat can be compacted at any time: after a
  compaction, or whenever you are unsure where you are, re-read STATE.md and audit/MODULES.md and the files in
  audit/ first, and trust the disk over the chat.
- Keep file contents out of this chat. The module subagents read the code; you read only their reports.

FILES (all under docs/plans/<slug>/_planning/)
- STATE.md: phase and progress.
- audit/MODULES.md: the module list (STEP 1).
- audit/<module-id>.md: one report per module (STEP 2).
- AUDIT.md: the merged result (STEP 3). Later steps (/plan-research, /plan-feature) read it.

STEP 0 - Set up
Make a short kebab-case slug (if the project text is the slug of an existing docs/plans/<slug>/ folder, use it).
Find the application root (the working directory, or each repo of this workspace) and read the project rules
(CLAUDE.md, GEMINI.md, AGENTS.md and any rules folder) and the README for the stack and conventions.
- If STATE.md exists and says phase: audit, this is a RESUME: read STATE.md, audit/MODULES.md and audit/*.md, say
  where we are, and continue from the first module that is not done (STEP 2) or from STEP 3.
- If STATE.md says phase: audit-approved, the audit is finished: show the owner the summary of AUDIT.md and ask once
  whether to redo it. If not, tell the owner the next command (STEP 5) and stop.
- If STATE.md says any other phase (research, interview, review, spec-approved, splitting, plans-approved), stop and
  say that the audit belongs before /plan-research and this plan is already past it.
- Otherwise create STATE.md with "phase: audit" on its own line, and the audit/ folder.

STEP 1 - List the modules
Walk the folder tree with Glob and read only manifests and entry points (routes, main files, dependency files) to
understand the layout. Write audit/MODULES.md:
1. Stack: languages, frameworks, database, key libraries (from the manifests), with versions.
2. Modules: a table with id (short kebab-case), name, paths, what it is for (one line), entry points, size (number of
   source files, counted with Glob), depends on. A module is one cohesive area (a feature area, a layer or a package)
   small enough for one agent to read completely: at most about 40 source files or 6,000 lines. Split a bigger area
   by sub-folder, merge tiny ones. Add the cross-cutting areas when they exist: routing and middleware, auth,
   database schema and migrations, configuration and deploy files (CI, Docker, dependency manifests; never the
   secret files), background jobs, the front end.
3. Every source file belongs to exactly one module. Nothing is left over.
4. Skipped: paths that are not audited, each with a reason (vendor and node_modules, build output, generated code,
   lock files, binary assets, minified files).
5. Not read: secret files found by name (see RULES), listed by path only.
Show the owner the module table and ask one question with AskUserQuestion (recommendation first): audit all of them,
or change the list (drop, merge or split a module, or add a focus). Apply the answer to MODULES.md. Then write
STATE.md: "phase: audit", "Modules: <n>", and one line per module: "module <id>: pending".

STEP 2 - One subagent per module
Start one plan-module-auditor subagent per module (Agent tool), at most 4 at a time (fewer if the tool runs them one by one), in the order of MODULES.md.
Give each one only: the slug, the path of audit/MODULES.md, its module id and the output path
docs/plans/<slug>/_planning/audit/<module-id>.md. Do not paste code or findings into the prompt.
A module is done only when its report exists and its last line is "END OF MODULE AUDIT". After each batch, check
the report files on disk, then update STATE.md ("module <id>: done|pending|failed"). A report that is missing or
has no last line: start a fresh subagent for that module once; if it fails again, mark "failed" and go on. The
chat is not the record: resuming means listing audit/ and starting only the modules that are not done.

STEP 3 - Merge into AUDIT.md
Write AUDIT.md one section at a time, in the order 2 to 8 and then 1 (the summary needs the counts), and after each
section add "merged: section <n>" to STATE.md, so a resume continues at the first section not marked. Never hold all
the reports at once: read only what a section needs (every finding block starts with "### <id>" and has a
"- Type:" line, so Grep with context on "Type: security" pulls one type from every report in audit/). Findings keep
the ids the module reports gave them (for example auth-S1): never renumber. A finding is copied only if it has
file:line evidence, a severity and a fix; any other goes under "Dropped for missing evidence" with its id and the
module. Sections:
1. Summary (written last): the counts by type (gap, security, performance) and severity, and the 10 findings to fix first.
2. Coverage: modules audited, failed or skipped, and everything "not read" or "not checked", merged from the reports.
3. Feature status: per module, a table of features with status DONE, PARTIAL, MISSING or NOT CHECKED, each with its
   file:line evidence. Then "Gap list for /plan-research": every PARTIAL and MISSING feature as one line with its id
   (gap ids such as billing-G1), what is missing and the severity.
4. Security findings, most severe first. Each: id, severity, file:line evidence, why it matters, fix.
5. Performance findings, most severe first. Same fields.
6. Cross-module findings: problems visible only by comparing modules (for example one module checks permissions and
   a sibling route does not). Each must cite file:line in the modules' reports or code.
7. Not checked: what needs running, a scanner or a person.
8. Candidates without code evidence: features a product of this kind usually has but nothing in the code points to.
   These are not findings; /plan-research decides about them.
Severity: CRITICAL = remotely exploitable without login, a hard-coded live secret, data loss, or a core flow that
cannot work; HIGH = serious but needs a login or a condition, or a main feature half done; MEDIUM = real but limited;
LOW = small or hygiene. Then check the evidence: read the cited lines of every CRITICAL finding and of up to 10 HIGH
findings. If the lines do not show it, move the finding to "Dropped for missing evidence" with the reason. Mark the
others "verified by re-read".

STEP 4 - Owner review
Show the owner the Summary and the CRITICAL and HIGH findings. Ask with AskUserQuestion: approve AUDIT.md as the
input for the next step, or change it (a finding that is not a problem, or is already known and accepted, goes under
"Owner notes" in AUDIT.md as "accepted: <id>, <reason>"; a module the owner wants audited again goes back to STEP 2).
Fix what the owner points out. Do not argue a finding away without code evidence.

STEP 5 - Finish
Set STATE.md: phase: audit-approved (lower-case, on its own line), with the line "Audit: docs/plans/<slug>/_planning/AUDIT.md".
Tell the owner exactly: "Run /clear, then /plan-research <slug>. It reads AUDIT.md (the gaps, and the security and
performance findings), so you will not be asked again what the audit already shows. For a small change that needs no
domain research, run /plan-feature <slug> instead: it reads AUDIT.md too." Stop.
