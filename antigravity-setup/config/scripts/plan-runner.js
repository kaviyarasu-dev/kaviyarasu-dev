const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const MAX_PLAN_SIZE = 50000; // Size gate

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

function runAgent(planFile) {
    return new Promise((resolve) => {
        const getTime = () => new Date().toLocaleTimeString();
        console.log(`  [${getTime()}] [System] Starting agy.exe for ${planFile}...`);
        const prompt = `${runnerInstructions}\n\nExecute plan: ${planFile}`;
        const agy = spawn('C:\\Users\\inc3241\\AppData\\Local\\agy\\bin\\agy.exe', ['-p', prompt, '--output-format', 'json']);
        
        let stdoutData = '';
        let currentLine = '';
        let hasLoggedProcessing = false;
        
        agy.stdout.on('data', (data) => {
            if (!hasLoggedProcessing) {
                console.log(`  [${getTime()}] [System] Agent processing prompt (Processing...)...`);
                hasLoggedProcessing = true;
            }
            const chunk = data.toString();
            stdoutData += chunk;
            
            // Simple live progress logging
            const lines = (currentLine + chunk).split('\n');
            currentLine = lines.pop(); // Keep the last incomplete line
            
            for (const line of lines) {
                if (line.trim().startsWith('{')) {
                    try {
                        const parsed = JSON.parse(line);
                        // If the agent makes a tool call, print a simple progress message
                        if (parsed.tool_calls && parsed.tool_calls.length > 0) {
                            for (const tool of parsed.tool_calls) {
                                if (tool.toolAction || tool.toolSummary) {
                                    console.log(`  -> Progress: ${tool.toolAction || tool.toolSummary}...`);
                                } else {
                                    console.log(`  -> Progress: Running ${tool.toolName || 'tool'}...`);
                                }
                            }
                        }
                    } catch (e) {
                        // Ignore parse errors on incomplete chunks
                    }
                }
            }
        });

        agy.stderr.on('data', (data) => {
            console.error(`  [${getTime()}] [CLI Internal] ${data.toString().trim()}`);
        });
        
        agy.on('close', (code) => {
            console.log(`  [${getTime()}] [System] agy.exe completed for ${planFile}.`);
            try {
                // agy outputs JSON per-line, we grab the last status object
                const lines = stdoutData.trim().split('\n').filter(l => l.trim().startsWith('{'));

                if (lines.length === 0) return resolve({ status: 'ERROR', error: 'No JSON output' });
                
                const lastLine = JSON.parse(lines[lines.length - 1]);
                resolve(lastLine);
            } catch (e) {
                resolve({ status: 'ERROR', error: 'Failed to parse JSON output: ' + e.message });
            }
        });
    });
}

async function run(manifestPath) {
    try {
        const manifest = await validateManifest(manifestPath);
        console.log("Manifest valid. Starting run...");
        
        for (const plan of manifest.plans) {
            const planFile = plan.file;
            
            if (plan.status === 'completed') {
                console.log(`Skipping ${planFile} (already completed)...`);
                continue;
            }

            console.log(`Executing ${planFile}...`);
            let attempts = 0;
            const maxAttempts = 3;
            
            while (attempts < maxAttempts) {
                attempts++;
                const result = await runAgent(planFile);
                
                if (result.status === 'SUCCESS') {
                    console.log(`Plan ${planFile} succeeded.`);
                    // Save progress to manifest
                    plan.status = 'completed';
                    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
                    break;
                } else {
                    if (result.error && result.error.toLowerCase().includes('quota')) {
                        console.log(`Transient quota error on ${planFile}. Retrying (${attempts}/${maxAttempts})...`);
                        await new Promise(r => setTimeout(r, 5000));
                        continue;
                    } else {
                        console.error(`Agent failed on ${planFile}:`, result.error);
                        throw new Error(`Fatal execution error on ${planFile}`);
                    }
                }
            }
            if (attempts >= maxAttempts) throw new Error("Max retries exceeded for quota errors");
        }
    } catch (e) {
        console.error("Run aborted:", e.message);
        process.exit(1);
    }
}

module.exports = { validateManifest, runAgent, run };

// If executed directly
if (require.main === module) {
    const manifestPath = process.argv[2];
    if (!manifestPath) {
        console.error("Usage: node index.js <path-to-manifest.json>");
        process.exit(1);
    }
    run(manifestPath);
}
