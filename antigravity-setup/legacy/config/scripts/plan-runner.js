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

function executePlan(planFile, planPrompt) {
    return new Promise((resolve) => {
        const getTime = () => new Date().toLocaleTimeString();
        console.log(`  [${getTime()}] [System] Sending plan to agy.exe: ${planFile}...`);
        
        const prompt = `${runnerInstructions}\n\nExecute plan: ${planFile}\n\nPhase Instructions: ${planPrompt || 'Follow the plan file.'}`;
        
        // We spawn a fresh agent per plan using Print mode (-p)
        // This avoids interactive stdin hanging, and naturally provides a fresh "cleared" conversation per plan.
        const agy = spawn('C:\\Users\\Kaviyarasu\\AppData\\Local\\agy\\bin\\agy.exe', [
            '-p', prompt,
            '--output-format', 'json'
        ]);
        
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
            
            const lines = (currentLine + chunk).split('\n');
            currentLine = lines.pop(); // Keep the last incomplete line
            
            for (const line of lines) {
                if (line.trim().startsWith('{')) {
                    try {
                        const parsed = JSON.parse(line);
                        
                        if (parsed.status === 'SUCCESS' || parsed.status === 'ERROR') {
                            console.log(`  [${getTime()}] [System] agy.exe completed for ${planFile}.`);
                            resolve(parsed);
                        } else if (parsed.tool_calls && parsed.tool_calls.length > 0) {
                            for (const tool of parsed.tool_calls) {
                                if (tool.toolAction || tool.toolSummary) {
                                    console.log(`  -> Progress: ${tool.toolAction || tool.toolSummary}...`);
                                } else {
                                    console.log(`  -> Progress: Running ${tool.toolName || 'tool'}...`);
                                }
                            }
                        }
                    } catch (e) {
                        // Ignore parse errors
                    }
                }
            }
        });

        agy.stderr.on('data', (data) => {
            console.error(`  [${getTime()}] [CLI Internal] ${data.toString().trim()}`);
        });
        
        agy.once('close', (code) => {
            if (code !== 0) {
                resolve({ status: 'ERROR', error: 'agy.exe closed unexpectedly with code ' + code });
            }
            // If code is 0, it means it exited gracefully. The resolution should have been handled by the JSON output.
            // But just in case:
            setTimeout(() => resolve({ status: 'SUCCESS' }), 1000);
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
                const result = await executePlan(planFile, plan.prompt);
                
                if (result.status === 'SUCCESS') {
                    console.log(`Plan ${planFile} succeeded.`);
                    plan.status = 'completed';
                    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
                    break;
                } else {
                    if (result.error && result.error.toLowerCase().includes('quota')) {
                        console.log(`Transient quota error on ${planFile}. Retrying (${attempts}/${maxAttempts})...`);
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
        
        console.log("All plans processed successfully.");
        
    } catch (e) {
        console.error("Run aborted:", e.message);
        process.exit(1);
    }
}

module.exports = { validateManifest, executePlan, run };

if (require.main === module) {
    const manifestPath = process.argv[2];
    if (!manifestPath) {
        console.error("Usage: node index.js <path-to-manifest.json>");
        process.exit(1);
    }
    run(manifestPath);
}
