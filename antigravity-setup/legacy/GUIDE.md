### 1. Antigravity Global Config (The Brain)
Puthu system-la Antigravity-oda background engine ah set panna:
- **Copy:** Pazhaya system-la ulla `C:\Users\<UserName>\.gemini\config\` folder-ah appadiye copy pannunga.
- **Paste:** Puthu system-oda `C:\Users\<UserName>\.gemini\` kulla paste pannidunga.
*(Ithu unga `plan-runner.js`, `plan_feature` skill, ellam custom agents-ayum automatic ah kondu vanthudum).*

### 2. Project Specific Files (The Workflow)
Puthu system-la neenga work panna pora project folder (e.g., `my-new-app`) ulla intha 2 files-ayum kandippa podanum:
- **`INSTRUCTIONS.md`**: Runner-ku theviyana core instructions.
- **`.agentignore`**: Speed-ah work aagurathukkana performance file (node_modules/ etc., include aagi irukkanum).

### 3. Eppadi Run Pandrathu? (Execution)
Setup mudinjathum velaiya start panna intha 2 simple steps-ah follow pannunga:

**Step A: Plan ah Create Panna**
Unga puthu project folder-la Antigravity ah open panni intha command ah adinga:
> `/plan-feature` (Appuram unga requirements ah kudunga. Ithu automatic ah `manifest.json` and plan files ah create pannidum).

**Step B: Plan ah Execute Panna (Automation)**
Terminal-ah antha project root folder-la vechukittu intha node command ah run pannunga:
```bash
node C:\Users\<UserName>\.gemini\config\scripts\plan-runner.js path\to\manifest.json
```
*(Path example: `.\docs\plans\my-feature\manifest.json`)*

Avlothaan! Runner antha manifest ah paathu ovvoru file ah automatic ah execute panni mudichidum.
### 1. Antigravity Global Config (The Brain)
Puthu system-la Antigravity-oda background engine ah set panna:
- **Copy:** Pazhaya system-la ulla `C:\Users\<UserName>\.gemini\config\` folder-ah appadiye copy pannunga.
- **Paste:** Puthu system-oda `C:\Users\<UserName>\.gemini\` kulla paste pannidunga.
*(Ithu unga `plan-runner.js`, `plan_feature` skill, ellam custom agents-ayum automatic ah kondu vanthudum).*

### 2. Project Specific Files (The Workflow)
Puthu system-la neenga work panna pora project folder (e.g., `my-new-app`) ulla intha 2 files-ayum kandippa podanum:
- **`INSTRUCTIONS.md`**: Runner-ku theviyana core instructions.
- **`.agentignore`**: Speed-ah work aagurathukkana performance file (node_modules/ etc., include aagi irukkanum).

### 3. Eppadi Run Pandrathu? (Execution)
Setup mudinjathum velaiya start panna intha 2 simple steps-ah follow pannunga:

**Step A: Plan ah Create Panna**
Unga puthu project folder-la Antigravity ah open panni intha command ah adinga:
> `/plan-feature` (Appuram unga requirements ah kudunga. Ithu automatic ah `manifest.json` and plan files ah create pannidum).

**Step B: Plan ah Execute Panna (Automation)**
Terminal-ah antha project root folder-la vechukittu intha node command ah run pannunga:
```bash
node C:\Users\<UserName>\.gemini\config\scripts\plan-runner.js path\to\manifest.json
```
*(Path example: `.\docs\plans\my-feature\manifest.json`)*

Avlothaan! Runner antha manifest ah paathu ovvoru file ah automatic ah execute panni mudichidum.