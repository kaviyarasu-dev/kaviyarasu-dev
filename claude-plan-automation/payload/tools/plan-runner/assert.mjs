#!/usr/bin/env node
// Small, language-neutral checks for a plan's verify commands. Dependencies: none (Node 20).
//   node assert.mjs has    <file> <regex> [flags]   the file contains a match
//   node assert.mjs none   <file> <regex> [flags]   the file contains NO match
//   node assert.mjs count  <file> <regex> <n>       exactly n matches (flags: gm)
//   node assert.mjs exists <path> [<path> ...]      every path exists
//   node assert.mjs json   <file> <dotted.key> [expected]   the JSON key exists (and equals expected, compared as text)
// Exit 0 = the check passed, 1 = the check failed, 2 = the command itself is wrong (bad usage, unreadable file,
// INVALID REGEX). A check that cannot run must never pass silently, so it exits 2, not 0.
// validate.mjs reads the regex arguments of these commands and compiles them before a run starts.
import fs from 'node:fs';

const [kind, ...rest] = process.argv.slice(2);
const bad = (msg) => { console.error(`assert: ${msg}`); process.exit(2); };
const fail = (msg) => { console.error(`assert FAILED: ${msg}`); process.exit(1); };

function regex(src, flags = 'm') {
  if (src === undefined) bad('a regex is required');
  try { return new RegExp(src, flags); } catch (e) { return bad(`invalid regex /${src}/${flags}: ${e.message}`); }
}
function read(file) {
  if (!file) bad('a file is required');
  try { return fs.readFileSync(file, 'utf8'); } catch (e) { return bad(`cannot read ${file}: ${e.code || e.message}`); }
}

switch (kind) {
  case 'has': {
    const [file, src, flags] = rest;
    if (!regex(src, flags).test(read(file))) fail(`${file} has no match for /${src}/`);
    break;
  }
  case 'none': {
    const [file, src, flags] = rest;
    const m = regex(src, flags).exec(read(file));
    if (m) fail(`${file} matches /${src}/ near "${m[0].slice(0, 60)}"`);
    break;
  }
  case 'count': {
    const [file, src, n] = rest;
    if (!/^\d+$/.test(n ?? '')) bad('count needs a number as the last argument');
    const found = (read(file).match(regex(src, 'gm')) || []).length;
    if (found !== Number(n)) fail(`${file} has ${found} match(es) for /${src}/, expected ${n}`);
    break;
  }
  case 'exists': {
    if (!rest.length) bad('at least one path is required');
    for (const p of rest) if (!fs.existsSync(p)) fail(`${p} does not exist`);
    break;
  }
  case 'json': {
    const [file, dotted, expected] = rest;
    if (!dotted) bad('a dotted key is required');
    let node;
    try { node = JSON.parse(read(file)); } catch (e) { bad(`${file} is not valid JSON: ${e.message}`); }
    for (const part of dotted.split('.')) {
      if (node === null || typeof node !== 'object' || !(part in node)) fail(`${file} has no key ${dotted}`);
      node = node[part];
    }
    if (expected !== undefined && String(typeof node === 'object' ? JSON.stringify(node) : node) !== expected) fail(`${dotted} is ${JSON.stringify(node)}, expected ${expected}`);
    break;
  }
  default:
    bad('usage: assert.mjs has|none|count|exists|json ...  (see the top of this file)');
}
