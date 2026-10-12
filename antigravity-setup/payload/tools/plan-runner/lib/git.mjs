// Snapshots and rollback WITHOUT commits, stashes or branch changes.
// A snapshot is a git tree object of every non-ignored file (tracked or not), built through a
// private index file, so the repo's real index and HEAD are never touched.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

function git(repo, args, { env = {}, input, allowFail = false } = {}) {
  const r = spawnSync('git', args, {
    cwd: repo,
    env: { ...process.env, ...env },
    input,
    encoding: 'utf8',
    maxBuffer: 512 * 1024 * 1024,
    windowsHide: true,
  });
  if (r.error) throw r.error;
  if (r.status !== 0 && !allowFail) {
    throw new Error(`git ${args.join(' ')} failed in ${repo}: ${(r.stderr || '').trim().slice(0, 500)}`);
  }
  return r;
}

export function isGitRepo(dir) {
  const r = git(dir, ['rev-parse', '--is-inside-work-tree'], { allowFail: true });
  return r.status === 0 && r.stdout.trim() === 'true';
}

export function toplevel(dir) {
  const r = git(dir, ['rev-parse', '--show-toplevel'], { allowFail: true });
  return r.status === 0 ? path.normalize(r.stdout.trim()) : null;
}

export function branch(repo) {
  return git(repo, ['branch', '--show-current']).stdout.trim() || '(detached)';
}

export function head(repo) {
  return git(repo, ['rev-parse', 'HEAD']).stdout.trim();
}

/** Paths that differ from HEAD (tracked changes + untracked), ignoring ignored files. */
export function dirtyPaths(repo, { ignorePrefixes = [] } = {}) {
  const r = git(repo, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  const out = [];
  const parts = r.stdout.split('\0').filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    const code = entry.slice(0, 2);
    const p = entry.slice(3);
    if (code[0] === 'R' || code[0] === 'C') i++; // rename/copy has a second path entry
    if (ignorePrefixes.some((pre) => p.startsWith(pre))) continue;
    out.push(p);
  }
  return out;
}

/** Build a tree object of the whole working directory. indexFile is reused so hashing stays fast. */
export function snapshot(repo, indexFile) {
  fs.mkdirSync(path.dirname(indexFile), { recursive: true });
  const env = { GIT_INDEX_FILE: indexFile };
  git(repo, ['add', '-A'], { env });
  return git(repo, ['write-tree'], { env }).stdout.trim();
}

/** Files that differ between two trees: [{status:'A'|'D'|'M'|'T', path}] */
export function changedBetween(repo, treeA, treeB) {
  if (treeA === treeB) return [];
  const r = git(repo, ['diff-tree', '-r', '--name-status', '--no-renames', '-z', treeA, treeB]);
  const parts = r.stdout.split('\0').filter(Boolean);
  const out = [];
  for (let i = 0; i + 1 < parts.length; i += 2) out.push({ status: parts[i][0], path: parts[i + 1] });
  return out;
}

export function patchBetween(repo, treeA, treeB) {
  if (treeA === treeB) return '';
  return git(repo, ['diff', '--binary', treeA, treeB]).stdout;
}

/**
 * Put the working directory back to exactly `tree`. Files added since are deleted; changed or
 * removed files are restored. Ignored files (.env, node_modules) are never touched.
 * Verifies the result and throws if it does not match.
 */
export function restore(repo, tree, indexFile) {
  const cur = snapshot(repo, indexFile);
  if (cur === tree) return { removed: 0, restored: 0 };
  const changes = changedBetween(repo, tree, cur);
  const toRestore = [];
  let removed = 0;
  for (const c of changes) {
    if (c.status === 'A') {
      const abs = path.join(repo, c.path);
      fs.rmSync(abs, { force: true });
      removed++;
      let dir = path.dirname(abs);
      while (dir.length > repo.length) { // drop now-empty parent folders, never the repo root
        try { fs.rmdirSync(dir); } catch { break; }
        dir = path.dirname(dir);
      }
    } else {
      toRestore.push(c.path);
    }
  }
  if (toRestore.length) {
    const tmpIndex = `${indexFile}.restore`;
    const env = { GIT_INDEX_FILE: tmpIndex };
    fs.rmSync(tmpIndex, { force: true });
    git(repo, ['read-tree', tree], { env });
    git(repo, ['checkout-index', '-f', '-z', '--stdin'], { env, input: toRestore.join('\0') + '\0' });
    fs.rmSync(tmpIndex, { force: true });
  }
  const after = snapshot(repo, indexFile);
  if (after !== tree) {
    throw new Error(`Rollback verification failed in ${repo}: tree ${after} != ${tree}`);
  }
  return { removed, restored: toRestore.length };
}

/** Contents of a file inside a tree, or null when it is not there. */
export function fileAt(repo, tree, file) {
  const r = git(repo, ['show', `${tree}:${file}`], { allowFail: true });
  return r.status === 0 ? r.stdout : null;
}
