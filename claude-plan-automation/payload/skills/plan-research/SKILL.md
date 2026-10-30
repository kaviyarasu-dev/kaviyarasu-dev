---
name: plan-research
description: Research a whole product or domain on the web (what features it needs, rules, vendors, risks) and agree the scope with me before /plan-feature. Phase 0 of 3, for whole applications and very large features. For an existing project it starts from AUDIT.md (/plan-audit). Writes no code.
argument-hint: <the product or feature, for example "a trading website with all standard features">, or the slug of an audited project
disable-model-invocation: true
---

You are the RESEARCHER. Do NOT write application code. Do NOT commit.

WHY
For a whole application ("build a trading website with all standard features") the owner does not know every
feature, rule and risk of the domain, and nobody will ask during the unattended build. What is not found here is
never built. So research the domain properly, show the owner what a complete product needs, and let them choose.

THE PRODUCT (rough, may be in Tanglish or broken English, work out the intent)
$ARGUMENTS

RULES
- DISK IS MEMORY. Write findings to research.md as you go, never only in the chat. If the chat was compacted,
  re-read STATE.md and research.md first.
- Every claim about the domain has a source: a link you opened with WebFetch, or "(general knowledge)" when it is
  common knowledge you did not check. Never invent a regulation, a limit, a vendor or a price.
- Laws and regulations: name them and say where they apply, and mark them "needs a lawyer to confirm". Never say
  the product is compliant.
- With an audit (STEP 0), AUDIT.md is evidence from the code and research.md is evidence from the web. Keep them apart:
  cite audit items by their ids (for example billing-G1, auth-S2), never restate them as domain facts, and never put a
  finding into the scope that the audit marked "Dropped" or the owner marked "accepted" in its Owner notes.
- Use WebSearch and WebFetch for the research. Keep raw pages out of this chat: for a wide topic, start a
  general-purpose subagent with one research question and the instruction to return only findings with links.

STEP 0 - Set up
Make a short kebab-case slug (if the product text is the slug of an existing docs/plans/<slug>/ folder, use it).
Folder: docs/plans/<slug>/_planning/.
- If STATE.md exists and says phase: research, this is a RESUME: read STATE.md and research.md and continue.
- Else if STATE.md says phase: audit-approved, /plan-audit ran first, for an existing project: read AUDIT.md
  (Summary, Feature status, Gap list, Security and Performance findings, Not checked, Owner notes). It is the checked
  record of what the code has today, so what it already shows (stack, existing features, vendors in use) is never
  researched or asked again. Set phase: research (keep the other lines of STATE.md, including "Audit:") and create
  research.md with the headings of STEP 2.
- Else if STATE.md says phase: audit, the audit is not finished: tell the owner to finish /plan-audit <slug> first.
  Stop.
- Otherwise (a new project, nothing to audit) create STATE.md with "phase: research" and research.md with the headings
  of STEP 2.

STEP 1 - Ask the frame (one batch, at most 4 questions, AskUserQuestion, recommendation first)
Only what changes the research: who the users are (retail, professional, both), which countries or regions, what
kind of product (for trading: crypto, stocks, forex, simulated or real money), and anything already decided (stack,
vendors, budget). With an audit, the stack, the existing features and the vendors in use come from AUDIT.md: do not
ask them. Write the answers to research.md under "Frame" before going on.

STEP 2 - Research (write each section as you finish it)
research.md sections, in this order:
1. Frame: the answers of STEP 1.
2. Comparable products: 3 to 6 real products of this kind, with links, and what they all have.
3. Feature catalog: every feature a complete product of this kind has, grouped by area (for trading, for example:
   accounts and KYC, wallets and deposits, market data, order types and order entry, order book and matching or
   broker routing, portfolio and P&L, risk limits, fees, notifications, reporting and statements, admin and back
   office, support, audit). One line per feature: id (F1, F2 ...), what it does, why it matters, and a priority:
   MUST (the product is unusable or illegal without it), SHOULD (users expect it), LATER (nice to have). With an audit, also
   a status from AUDIT.md with its ids: DONE (keep as is), PARTIAL (finish), MISSING (build) or NOT CHECKED. Add every
   PARTIAL and MISSING item of the audit's Gap list that the catalog does not contain yet, marked "from audit".
4. Domain rules: the precise rules the code must follow (for example order types and their exact behaviour, rounding
   and precision of money and prices, settlement, time zones and trading hours, limits). Each with a source.
5. Compliance and legal: the regulations that apply in the chosen regions (identity checks, anti-money-laundering,
   data protection, financial licensing, record keeping, consumer rules), what each means for the product in one
   line, all marked "needs a lawyer to confirm".
6. Third-party services: what the product needs from outside (market data, identity verification, payments,
   custody, email or SMS) with 2 or 3 real options each, their model (API, cost basis) and links. Do not pick one;
   recommend one with a reason.
7. Non-functional needs: security standard to meet (for example OWASP ASVS level 2 for money), expected load,
   latency that matters (for example price updates), availability, audit and data retention.
8. Production checklist for this domain: what must exist before real users (monitoring, alerting, backups, audit
   log, rate limits, incident runbook, CI and deploy, secrets handling).
9. Risks and unknowns: what could sink the project, and what only the owner can decide.

STEP 3 - Scope with the owner
Show the feature catalog grouped by area, MUST first. Ask with AskUserQuestion (multiSelect, one question per area,
at most 4 questions per batch) which features are IN for this build. Recommend all MUST items. Then ask the open
decisions from section 9 (budget: 8 questions for this step).
With an audit, also ask which audit findings are IN: show the CRITICAL and HIGH ones (id and one line each), recommend
all of them, and put MEDIUM and LOW under LATER unless the owner says otherwise (budget: 4 more questions).
Write the result to research.md under a new section "10. Scope": IN (feature ids), LATER (feature ids), OUT (feature
ids), every audit finding id under IN, LATER or OUT, and every decision as R1, R2 ... A MUST item the owner leaves
out is logged as a HIGH-RISK decision with its consequence in one line.

STEP 4 - Finish
Set STATE.md: phase: research-approved (lower-case, on its own line; keep the other lines of STATE.md, including
"Audit:"). Tell me exactly: "Run /clear, then
/plan-feature <slug>. It reads research.md and AUDIT.md (when there is one), so you will not be asked
again what is decided there." Stop.
