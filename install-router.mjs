#!/usr/bin/env node
// One command for every installer in this repo (the package has a single bin, so npx always knows which one to run).
//   npx --yes https://github.com/kaviyarasu-dev/kaviyarasu-dev/tarball/main               Claude Code plan automation (as before)
//   npx --yes https://github.com/kaviyarasu-dev/kaviyarasu-dev/tarball/main claude        the same
//   npx --yes https://github.com/kaviyarasu-dev/kaviyarasu-dev/tarball/main antigravity   Antigravity (agy) plan automation
// Everything after the name (--dry-run, --uninstall, --local) goes to the installer unchanged.
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const INSTALLERS = {
  claude: path.join('claude-plan-automation', 'install.mjs'),
  antigravity: path.join('antigravity-setup', 'install.mjs'),
};

const rest = process.argv.slice(2);
let name = 'claude'; // no name means Claude, so the original public command keeps working exactly as before
if (rest[0] && !rest[0].startsWith('-')) {
  name = rest.shift();
  if (!INSTALLERS[name]) {
    console.error(`Unknown installer "${name}". Use: claude or antigravity (then --dry-run or --uninstall if you want).`);
    process.exit(2);
  }
}
if (rest[0] === '--help' || rest[0] === '-h') {
  console.log('Usage: kaviyarasu-dev [claude|antigravity] [--dry-run] [--uninstall]\n  claude       Claude Code plan automation (default)\n  antigravity  Antigravity (agy) plan automation');
  process.exit(0);
}

const r = spawnSync(process.execPath, [path.join(here, INSTALLERS[name]), ...rest], { stdio: 'inherit' });
process.exit(r.status ?? 1);
