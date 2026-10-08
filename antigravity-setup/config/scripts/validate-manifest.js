const fs = require('fs');
const file = process.argv[2];
if (!file) {
  console.error("Usage: node validate-manifest.js <manifest.json>");
  process.exit(1);
}
try {
  const content = fs.readFileSync(file, 'utf8');
  const manifest = JSON.parse(content);
  if (!manifest.plans || !Array.isArray(manifest.plans)) {
    throw new Error("Missing 'plans' array");
  }
  manifest.plans.forEach(plan => {
    if (!plan.id || !plan.file || !plan.repo || !plan.prompt) {
      throw new Error("Plan is missing required fields (id, file, repo, prompt)");
    }
  });
  console.log("Manifest is valid.");
} catch (e) {
  console.error("Manifest validation failed:", e.message);
  process.exit(1);
}
