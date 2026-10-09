// Runs ONE `claude -p` session, streams its events to the terminal, and reports what happened.
// The runner never trusts the session's own "done": this only collects facts.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { log, progress } from './util.mjs';

/** Where Git Bash lives. Claude Code needs it (we turn the PowerShell tool off, see below). */
export function findGitBash() {
  if (process.platform !== 'win32') return null;
  const candidates = [];
  if (process.env.CLAUDE_CODE_GIT_BASH_PATH) candidates.push(process.env.CLAUDE_CODE_GIT_BASH_PATH);
  const w = spawnSync('where', ['git'], { encoding: 'utf8', windowsHide: true });
  for (const g of (w.stdout || '').split(/\r?\n/).filter(Boolean)) {
    const root = path.dirname(path.dirname(g)); // ...\Git\cmd\git.exe -> ...\Git
    candidates.push(path.join(root, 'bin', 'bash.exe'), path.join(root, 'usr', 'bin', 'bash.exe'));
  }
  candidates.push('C:\\Program Files\\Git\\bin\\bash.exe');
  return candidates.find((c) => c && fs.existsSync(c)) || null;
}

export const activePids = new Set();

/** Kill a process and all its children (the shell tool spawns grandchildren). */
export function killTree(pid) {
  if (!pid) return;
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
    else process.kill(-pid, 'SIGKILL');
  } catch { /* already gone */ }
}

function describeTool(b) {
  const i = b.input || {};
  const target = i.file_path || i.path || i.pattern || i.command || i.description || i.url || '';
  return `${b.name} ${String(target).replace(/\s+/g, ' ').slice(0, 110)}`.trim();
}

/**
 * opts: { args, prompt, cwd, env, idleMs, timeoutMs, rawLog, label, turnLimit, onCheckpointStop }
 * Returns facts: { exitCode, killedFor, result, turns, rateLimit, denials, stderrTail, sawCheckpointStop }
 */
export function runClaude(opts) {
  return new Promise((resolve) => {
    const override = process.env.PLAN_RUNNER_CLAUDE_CMD; // chaos tests point this at a fake claude
    const [cmd, ...pre] = override ? JSON.parse(override) : ['claude'];
    const child = spawn(cmd, [...pre, ...opts.args], {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32',
    });
    activePids.add(child.pid);
    const raw = opts.rawLog ? fs.createWriteStream(opts.rawLog, { flags: 'a' }) : null;
    const facts = {
      exitCode: null, killedFor: null, result: null, turns: 0, rateLimit: null,
      denials: [], stderrTail: '', sawCheckpointStop: false, spawnError: null,
    };
    const seenMsg = new Set();
    let last = Date.now();
    let buf = '';
    let done = false;

    const kill = (why) => {
      if (facts.killedFor) return;
      facts.killedFor = why;
      log('System', `Stopping the claude session (${why}).`);
      killTree(child.pid);
    };

    const idleTimer = setInterval(() => {
      if (Date.now() - last > opts.idleMs) kill(`idle for ${Math.round(opts.idleMs / 60000)} min`);
    }, 5000);
    const hardTimer = setTimeout(() => kill(`timeout after ${Math.round(opts.timeoutMs / 60000)} min`), opts.timeoutMs);

    const handle = (line) => {
      raw?.write(line + '\n');
      let ev;
      try { ev = JSON.parse(line); } catch { log('CLI Internal', `(non-JSON stdout) ${line.slice(0, 300)}`); return; }
      switch (ev.type) {
        case 'system':
          if (ev.subtype === 'init') log('System', `Session started (model ${ev.model}, ${ev.tools?.length ?? '?'} tools).`);
          else if (ev.subtype === 'permission_denied') {
            facts.denials.push(ev.tool_name);
            log('Denied', `${ev.tool_name} was refused by the permission rules.`);
          } else if (ev.subtype === 'api_retry') {
            log('System', `API retry ${ev.attempt}/${ev.max_retries}: ${JSON.stringify(ev.error || '').slice(0, 160)}`);
          }
          break;
        case 'rate_limit_event': {
          const info = ev.rate_limit_info || {};
          if (info.status && info.status !== 'allowed') {
            facts.rateLimit = { status: info.status, resetsAt: info.resetsAt, type: info.rateLimitType };
            log('System', `Usage limit event: ${info.status} (${info.rateLimitType}), resets ${info.resetsAt ? new Date(info.resetsAt * 1000).toLocaleTimeString() : 'unknown'}.`);
          }
          break;
        }
        case 'assistant': {
          const id = ev.message?.id;
          if (id && !seenMsg.has(id)) { seenMsg.add(id); facts.turns++; }
          else if (!id) facts.turns++;
          for (const b of ev.message?.content || []) {
            if (b.type === 'tool_use') progress(describeTool(b));
            else if (b.type === 'text' && b.text?.trim()) progress(`says: ${b.text.trim().replace(/\s+/g, ' ').slice(0, 140)}`);
          }
          break;
        }
        case 'user':
          for (const b of ev.message?.content || []) {
            if (b.type !== 'tool_result') continue;
            const text = typeof b.content === 'string' ? b.content : JSON.stringify(b.content);
            if (/CHECKPOINT \d+ OK/.test(text)) {
              log('System', text.match(/CHECKPOINT \d+ OK[^"\\]*/)[0]);
              if (opts.stopAfterCheckpoint?.(facts.turns)) { // turn budget exceeded: continue in a fresh session
                facts.sawCheckpointStop = true;
                kill('turn budget exceeded, continuing from this checkpoint in a fresh session');
              }
            }
          }
          break;
        case 'result':
          facts.result = ev;
          break;
        default:
      }
    };

    child.stdout.on('data', (d) => {
      last = Date.now();
      buf += d.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line) handle(line);
      }
    });
    child.stderr.on('data', (d) => {
      last = Date.now();
      const s = d.toString('utf8');
      facts.stderrTail = (facts.stderrTail + s).slice(-4000);
      raw?.write(`#stderr ${s}\n`);
      log('CLI Internal', s);
    });
    child.on('error', (e) => { facts.spawnError = e.message; });
    child.on('close', (code) => {
      if (done) return;
      done = true;
      activePids.delete(child.pid);
      clearInterval(idleTimer);
      clearTimeout(hardTimer);
      if (buf.trim()) handle(buf.trim());
      raw?.end();
      facts.exitCode = code;
      resolve(facts);
    });

    child.stdin.on('error', () => { /* EPIPE if the child dies early */ });
    child.stdin.end(opts.prompt);
  });
}
