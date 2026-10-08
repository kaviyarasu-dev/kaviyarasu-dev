const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const MAX_PLAN_SIZE = 50000; // Size gate
const AGY_EXE = 'C:\\Users\\inc3241\\AppData\\Local\\agy\\bin\\agy.exe';

async function validateManifest(manifestPath) {
    if (!fs.existsSync(manifestPath)) throw new Error("Manifest not found");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (!manifest.plans || !Array.isArray(manifest.plans)) throw new Error("Missing 'plans' array");

    for (const plan of manifest.plans) {
        if (!plan.id || !plan.file || !plan.repo) throw new Error("Plan missing required fields");
        const filePath = path.join(path.dirname(manifestPath), plan.file);
        if (fs.existsSync(filePath)) {
            const stats = fs.statSync(filePath);
            if (stats.size > MAX_PLAN_SIZE) {
                throw new Error(`Size Gate Failed: ${plan.file} exceeds ${MAX_PLAN_SIZE} bytes`);
            }
        }
    }
    return manifest;
}

const runnerInstructions = `
Runner Instructions:
1. Read the plan file specified.
2. Ensure you ONLY modify paths listed in "Allowed Paths" / Deliverables.
3. Execute the steps precisely.
4. Run the verification commands. If they fail, fix the code and retry.
5. Exit when done.
`;

// =============================================================================
// AgentSession: Keeps ONE agy.exe alive across all plans using the official
// headless streaming mode:
//   --input-format stream-json  (reads one NDJSON {"event":"user",...} per line)
//   --output-format stream-json (emits NDJSON events; ends with {"event":"result",...})
//
// Official docs: https://antigravity.google/docs/cli/headless
//
// WHY NOT /clear:
//   Slash commands (including /clear) are explicitly UNSUPPORTED in stream-json
//   mode. Sending one aborts the session with exit code 2 and an ERROR result.
//   Source: https://antigravity.google/docs/cli/headless (Section 5)
//
// WHY NOT --prompt-interactive (-i):
//   That flag launches the interactive TUI — it is not pipe-safe and has no
//   documented JSON output behavior for programmatic use.
//
// CONTEXT ISOLATION STRATEGY:
//   Full runner instructions + plan file path are embedded in every single
//   prompt, making each turn self-contained. Previous turns accumulate in the
//   session's conversation history, but since every prompt restates the full
//   task, the agent does not rely on or get confused by prior context.
// =============================================================================

class AgentSession {
    constructor() {
        this.process    = null;
        this.lineBuffer = '';
        this.currentResolve = null;
        this.currentReject  = null;
        this.dead = false;
    }

    /**
     * Spawn agy.exe in stream-json headless mode.
     * The process stays alive until session.end() or session.kill() is called.
     */
    start() {
        const getTime = () => new Date().toLocaleTimeString();
        console.log(`[${getTime()}] [Session] Starting persistent agy.exe (stream-json mode)...`);

        this.process = spawn(AGY_EXE, [
            '--input-format',  'stream-json',
            '--output-format', 'stream-json',
            '--dangerously-skip-permissions'
        ]);

        this.process.stdout.on('data', (data) => this._onData(data));

        this.process.stderr.on('data', (data) => {
            const msg = data.toString().trim();
            if (msg) console.error(`  [CLI Internal] ${msg}`);
        });

        this.process.once('close', (code) => {
            this.dead = true;
            console.log(`[${new Date().toLocaleTimeString()}] [Session] agy.exe closed (code=${code}).`);
            if (this.currentReject) {
                this.currentReject(new Error(`agy.exe closed unexpectedly with code ${code}`));
                this.currentResolve = null;
                this.currentReject  = null;
            }
        });
    }

    /**
     * Parse the NDJSON output stream. Each newline-terminated JSON object is
     * one event. The terminal event for a turn is {"event":"result",...}.
     */
    _onData(data) {
        const getTime = () => new Date().toLocaleTimeString();
        const chunk = data.toString();
        const lines = (this.lineBuffer + chunk).split('\n');
        this.lineBuffer = lines.pop(); // keep incomplete trailing fragment

        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;

            let parsed;
            try {
                parsed = JSON.parse(trimmed);
            } catch (_) {
                continue; // not a JSON line — ignore
            }

            const event = parsed.event;

            if (event === 'result') {
                // Terminal event — carries the final status for this turn.
                const res    = parsed.result || {};
                const status = res.status === 'SUCCESS' ? 'SUCCESS' : 'ERROR';
                console.log(`  [${getTime()}] [Session] Turn complete: ${status}`);

                if (this.currentResolve) {
                    const cb = this.currentResolve;
                    this.currentResolve = null;
                    this.currentReject  = null;
                    cb({ status, error: res.error || null, response: res.response || '' });
                }

            } else if (event === 'step_update') {
                // Mid-turn progress event — log tool activity.
                const su = parsed.step_update || {};
                if (su.tool_calls && su.tool_calls.length > 0) {
                    for (const tool of su.tool_calls) {
                        const label = tool.toolAction || tool.toolSummary || tool.toolName || 'tool';
                        console.log(`  -> Progress: ${label}...`);
                    }
                }
            }
            // event === 'init' and unrecognised events are silently ignored.
        }
    }

    /**
     * Send one prompt turn to the running session via stdin.
     * Input format: NDJSON line — {"event":"user","message":{"content":"<text>"}}
     * Returns Promise<{status, error?, response?}> resolving on the "result" event.
     */
    sendPrompt(promptText) {
        return new Promise((resolve, reject) => {
            if (this.dead) { reject(new Error('Session is dead')); return; }
            this.currentResolve = resolve;
            this.currentReject  = reject;

            const msg = JSON.stringify({
                event:   'user',
                message: { content: promptText }
            });
            this.process.stdin.write(msg + '\n');
        });
    }

    /**
     * Gracefully close the session by ending stdin.
     * agy.exe will flush its last events and exit with code 0.
     */
    end() {
        if (this.process && !this.dead) {
            try { this.process.stdin.end(); } catch (_) {}
        }
    }

    kill() {
        if (this.process && !this.dead) this.process.kill();
    }
}

// =============================================================================
// executePlanOnSession: build the prompt and dispatch one turn.
// =============================================================================

async function executePlanOnSession(session, planFile, planPrompt) {
    const getTime = () => new Date().toLocaleTimeString();
    const prompt = [
        runnerInstructions.trim(),
        `Execute plan: ${planFile}`,
        `Phase Instructions: ${planPrompt || 'Follow the plan file.'}`
    ].join('\n\n');

    console.log(`  [${getTime()}] [Session] Sending plan: ${planFile}...`);
    return session.sendPrompt(prompt);
}

// =============================================================================
// run: Main orchestrator — one persistent session, plans sent sequentially.
// =============================================================================

async function run(manifestPath) {
    let manifest;
    try {
        manifest = await validateManifest(manifestPath);
    } catch (e) {
        console.error("Manifest validation failed:", e.message);
        process.exit(1);
    }
    console.log("Manifest valid. Starting persistent stream-json session...\n");

    const session = new AgentSession();
    session.start();

    try {
        for (const plan of manifest.plans) {
            const planFile = plan.file;

            if (plan.status === 'completed') {
                console.log(`Skipping ${planFile} (already completed)...`);
                continue;
            }

            console.log(`\nExecuting ${planFile}...`);
            let attempts      = 0;
            const maxAttempts = 3;

            while (attempts < maxAttempts) {
                attempts++;

                if (session.dead) throw new Error('Agent session died unexpectedly.');

                const result = await executePlanOnSession(session, planFile, plan.prompt);

                if (result.status === 'SUCCESS') {
                    console.log(`Plan ${planFile} succeeded.`);
                    plan.status = 'completed';
                    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
                    break;

                } else {
                    const errMsg = (result.error || '').toLowerCase();
                    if (errMsg.includes('quota')) {
                        console.log(`Quota error on ${planFile}. Retrying (${attempts}/${maxAttempts}) after back-off...`);
                        await new Promise(r => setTimeout(r, 5000));
                        continue;
                    } else {
                        console.error(`Agent failed on ${planFile}:`, result.error || 'Unknown error');
                        throw new Error(`Fatal execution error on ${planFile}`);
                    }
                }
            }

            if (attempts >= maxAttempts) throw new Error("Max retries exceeded for quota errors");
        }

        console.log("\nAll plans processed successfully.");

    } catch (e) {
        console.error("Run aborted:", e.message);
        session.kill();
        process.exit(1);
    }

    session.end(); // graceful shutdown
}

module.exports = { validateManifest, run };

if (require.main === module) {
    const manifestPath = process.argv[2];
    if (!manifestPath) {
        console.error("Usage: node plan-runner.js <path-to-manifest.json>");
        process.exit(1);
    }
    run(manifestPath);
}
