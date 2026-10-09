#!/usr/bin/env node
// Deterministic plan checker (a machine, not a model).
// Usage: node validate.mjs <plan folder> [--workspace <dir that holds the repo folders>]
// Exit 0 = valid, 1 = errors. The runner runs the same checks before it starts.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { matchesAny } from './lib/util.mjs';

const SECTIONS = ['Goal', 'Read first', 'Steps', 'Do not touch', 'Acceptance', 'If blocked', 'Report back'];
const TEST_FILE = /[\w./\\-]+(?:_test\.php|Test\.php|\.test\.[cm]?[jt]sx?|\.spec\.[cm]?[jt]sx?)/g;

export function validateFolder(dir, { workspace } = {}) {
  const errors = [];
  const warnings = [];
  const err = (m) => errors.push(m);
  const warn = (m) => warnings.push(m);
  const slug = path.basename(dir);
  const ws = workspace || path.dirname(path.dirname(path.dirname(dir))); // <repo>/docs/plans/<slug> -> parent of <repo>

  for (const f of ['INSTRUCTIONS.md', 'HANDOFF.md']) {
    if (!fs.existsSync(path.join(dir, f))) err(`${f} is missing`);
  }
  const mp = path.join(dir, 'manifest.json');
  if (!fs.existsSync(mp)) { err('manifest.json is missing'); return { errors, warnings }; }
  let m;
  try { m = JSON.parse(fs.readFileSync(mp, 'utf8')); } catch (e) { err(`manifest.json is not valid JSON: ${e.message}`); return { errors, warnings }; }

  if (m.feature !== slug) err(`manifest "feature" is "${m.feature}" but the folder is "${slug}"`);
  if (!Array.isArray(m.plans) || m.plans.length === 0) { err('"plans" must be a non-empty array'); return { errors, warnings }; }

  const cmdOk = (c, where, repos) => {
    const cmd = typeof c === 'string' ? c : c?.cmd;
    if (typeof cmd !== 'string' || !cmd.trim()) { err(`${where}: command is empty or not a string`); return; }
    if (typeof c === 'object' && c.repo && repos && !repos.includes(c.repo)) err(`${where}: repo "${c.repo}" is not in this plan's repos`);
  };

  if (m.env !== undefined) {
    if (typeof m.env !== 'object' || Array.isArray(m.env) || Object.values(m.env).some((v) => typeof v !== 'string')) err('"env" must be an object of strings');
  }
  if (m.isolate !== undefined) {
    if (!Array.isArray(m.isolate) || m.isolate.some((k) => !(m.env && k in m.env))) err('"isolate" must list keys that exist in "env"');
  }
  if (m.permissions !== undefined) {
    const p = m.permissions;
    if (!p || typeof p !== 'object' || Array.isArray(p)) err('"permissions" must be an object with optional "allow" and "deny" arrays');
    else for (const k of ['allow', 'deny']) {
      if (p[k] !== undefined && (!Array.isArray(p[k]) || p[k].some((x) => typeof x !== 'string' || !x.trim()))) err(`"permissions.${k}" must be an array of non-empty strings`);
    }
  }
  for (const key of ['setup', 'gates_each', 'full_gates']) {
    if (m[key] === undefined) continue;
    if (!Array.isArray(m[key])) { err(`"${key}" must be an array`); continue; }
    m[key].forEach((c, i) => cmdOk(c, `${key}[${i}]`));
  }

  const seen = new Set();
  const allowedSoFar = [];
  m.plans.forEach((p, idx) => {
    const w = `plan ${p?.id ?? `#${idx + 1}`}`;
    if (!p || typeof p.id !== 'string' || !p.id) { err(`${w}: id must be a non-empty string`); return; }
    if (seen.has(p.id)) err(`${w}: duplicate id`);
    if (p.gate) err(`${w}: "gate" is not supported. Unattended plans must need no approval; use a real verify command or "human_check".`);
    if (typeof p.file !== 'string' || !fs.existsSync(path.join(dir, p.file))) err(`${w}: plan file "${p.file}" does not exist`);
    if (!Array.isArray(p.repos) || p.repos.length === 0) err(`${w}: repos must be a non-empty array`);
    const repos = Array.isArray(p.repos) ? p.repos : [];
    for (const r of repos) if (!fs.existsSync(path.join(ws, r))) err(`${w}: repo folder "${r}" not found in ${ws}`);
    if (!Array.isArray(p.depends_on)) err(`${w}: depends_on must be an array (use [] for none)`);
    else for (const d of p.depends_on) if (!seen.has(d)) err(`${w}: depends_on "${d}" is not an EARLIER plan id`);
    if (!Array.isArray(p.allowed_paths) || p.allowed_paths.length === 0) err(`${w}: allowed_paths must be a non-empty array`);
    else {
      for (const a of p.allowed_paths) {
        if (!repos.some((r) => a === r || a.startsWith(`${r}/`))) err(`${w}: allowed_paths "${a}" must start with one of its repo folders (${repos.join(', ')})`);
        if (/^(\*\*|\*)(\/|$)/.test(a)) err(`${w}: allowed_paths "${a}" is too broad`);
      }
    }
    if (!Array.isArray(p.verify) || p.verify.length === 0) err(`${w}: verify must be a non-empty array of commands`);
    else p.verify.forEach((c, i) => cmdOk(c, `${w} verify[${i}]`, repos));
    if (typeof p.est_turns !== 'number' || p.est_turns <= 0) err(`${w}: est_turns must be a positive number`);
    else if (p.est_turns > 60) warn(`${w}: est_turns ${p.est_turns} is over 60. Split it at a green checkpoint.`);
    if (p.model !== undefined && !['sonnet', 'opus', 'haiku'].includes(p.model)) err(`${w}: model must be sonnet, opus or haiku`);

    // steps
    if (!Array.isArray(p.steps) || p.steps.length === 0) err(`${w}: steps must be a non-empty array`);
    else p.steps.forEach((s, i) => {
      if (s.n !== i + 1) err(`${w}: steps must be numbered 1..N in order (found ${s.n} at position ${i + 1})`);
      if (!s.title) err(`${w} step ${i + 1}: title is missing`);
      if (s.verify !== undefined) {
        if (!Array.isArray(s.verify)) err(`${w} step ${i + 1}: verify must be an array`);
        else s.verify.forEach((c, j) => cmdOk(c, `${w} step ${i + 1} verify[${j}]`, repos));
      }
    });

    // plan body
    if (typeof p.file === 'string' && fs.existsSync(path.join(dir, p.file))) {
      const body = fs.readFileSync(path.join(dir, p.file), 'utf8');
      let pos = -1;
      for (const s of SECTIONS) {
        const re = new RegExp(`^#{1,3}\\s*${s.replace(/ /g, '\\s+')}\\b.*$`, 'im');
        const hit = re.exec(body);
        if (!hit) { err(`${w}: plan file has no "${s}" section`); continue; }
        if (hit.index < pos) err(`${w}: section "${s}" is out of order`);
        pos = hit.index;
      }
      if (Array.isArray(p.steps)) for (const s of p.steps) {
        if (!new RegExp(`^#{2,4}\\s*Step\\s+${s.n}\\b`, 'im').test(body)) err(`${w}: plan file has no heading "### Step ${s.n}: ..."`);
      }
      for (const bad of ['as discussed', 'TBD', 'TODO', 'handle edge cases', 'etc.']) {
        if (body.toLowerCase().includes(bad.toLowerCase())) warn(`${w}: plan file contains "${bad}" (vague)`);
      }
      // files named under "Read first" should exist (warning only: an earlier plan may create them)
      const rf = /^#{1,3}\s*Read first[\s\S]*?(?=^#{1,3}\s)/im.exec(body);
      if (rf) for (const mt of rf[0].matchAll(/`([^`\s]+\.[A-Za-z0-9]+)`/g)) {
        const rel = mt[1].replace(/\\/g, '/');
        if (!fs.existsSync(path.join(ws, rel)) && !fs.existsSync(path.join(dir, rel))) warn(`${w}: "Read first" names "${rel}" which does not exist yet`);
      }
    }

    // test files named in verify must exist or be created by this or an earlier plan
    const thisAllowed = [...allowedSoFar, ...(p.allowed_paths || [])];
    const cmds = [...(p.verify || []), ...(p.steps || []).flatMap((s) => s.verify || [])];
    for (const c of cmds) {
      const cmd = typeof c === 'string' ? c : c?.cmd || '';
      const repo = (typeof c === 'object' && c.repo) || repos[0];
      for (const mt of cmd.matchAll(TEST_FILE)) {
        const rel = mt[0].replace(/\\/g, '/');
        const full = `${repo}/${rel}`;
        if (!fs.existsSync(path.join(ws, repo, rel)) && !matchesAny(thisAllowed, full)) {
          err(`${w}: verify names test file "${full}" which does not exist and no plan up to this one is allowed to create it`);
        }
      }
    }

    // a verify that is only lint/typecheck is weak
    if (Array.isArray(p.verify) && p.verify.length) {
      const weak = p.verify.every((c) => /\b(lint|eslint|typecheck|tsc|php -l)\b/.test(typeof c === 'string' ? c : c?.cmd || ''));
      if (weak && !p.human_check) warn(`${w}: verify is only lint/typecheck. Add a real check, or set "human_check" so the report flags it.`);
    }

    seen.add(p.id);
    allowedSoFar.push(...(p.allowed_paths || []));
  });

  return { errors, warnings };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const args = process.argv.slice(2);
  const wi = args.indexOf('--workspace');
  const workspace = wi >= 0 ? args.splice(wi, 2)[1] : undefined;
  const dir = args[0];
  if (!dir) { console.error('Usage: node validate.mjs <plan folder> [--workspace <dir>]'); process.exit(2); }
  const { errors, warnings } = validateFolder(path.resolve(dir), { workspace: workspace && path.resolve(workspace) });
  for (const w of warnings) console.log(`WARN  ${w}`);
  for (const e of errors) console.log(`ERROR ${e}`);
  console.log(errors.length ? `\nINVALID: ${errors.length} error(s), ${warnings.length} warning(s)` : `\nVALID (${warnings.length} warning(s))`);
  process.exit(errors.length ? 1 : 0);
}
