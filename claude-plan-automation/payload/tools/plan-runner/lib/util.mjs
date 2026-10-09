// Small shared helpers: timestamps, logging, atomic JSON, glob matching, sleeping.
import fs from 'node:fs';
import path from 'node:path';

export const stamp = () => `[${new Date().toLocaleTimeString()}]`;

let logFile = null;
export function setLogFile(p) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  logFile = p;
}

/** One line to the terminal and the run log. tag is e.g. System, CLI Internal, Gate. */
export function log(tag, msg) {
  const text = String(msg).replace(/\r?\n$/, '');
  for (const line of text.split(/\r?\n/)) {
    const out = `${stamp()} [${tag}] ${line}`;
    console.log(out);
    if (logFile) {
      try { fs.appendFileSync(logFile, `${new Date().toISOString()} ${out}\n`); } catch { /* log must never crash the run */ }
    }
  }
}
/** Progress lines have their own format: `-> Progress: ...` */
export function progress(msg) {
  const out = `${stamp()} -> Progress: ${msg}`;
  console.log(out);
  if (logFile) { try { fs.appendFileSync(logFile, `${new Date().toISOString()} ${out}\n`); } catch { /* ignore */ } }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function readJson(p, fallback = undefined) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) {
    if (fallback !== undefined) return fallback;
    throw e;
  }
}

/** Write via temp file + rename so a crash never leaves half a file. */
export function writeJsonAtomic(p, data) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, p);
}

export const toPosix = (p) => p.split(path.sep).join('/');

/** Glob to RegExp. Supports **, *, ?, {a,b}. Paths use forward slashes. */
export function globToRegExp(glob) {
  let re = '';
  let i = 0;
  let braces = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') { re += '(?:.*/)?'; i += 3; continue; }
        re += '.*'; i += 2; continue;
      }
      re += '[^/]*'; i++; continue;
    }
    if (c === '?') { re += '[^/]'; i++; continue; }
    if (c === '{') { re += '(?:'; braces++; i++; continue; }
    if (c === '}' && braces) { re += ')'; braces--; i++; continue; }
    if (c === ',' && braces) { re += '|'; i++; continue; }
    re += c.replace(/[.+^$()|[\]\\]/g, '\\$&');
    i++;
  }
  return new RegExp(`^${re}$`);
}

export function matchesAny(globs, file) {
  const f = file.replace(/\\/g, '/');
  return globs.some((g) => globToRegExp(g.replace(/\\/g, '/')).test(f));
}

export const tail = (s, n = 3000) => (s.length > n ? `...${s.slice(-n)}` : s);

export function fmtDuration(ms) {
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h ? `${h}h ${m}m` : m ? `${m}m ${s % 60}s` : `${s}s`;
}
