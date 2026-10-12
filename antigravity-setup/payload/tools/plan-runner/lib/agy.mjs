// Runs ONE `agy -p` session, streams its events to the terminal, and reports what happened.
// The runner never trusts the session's own "done": this only collects facts.
// Event shapes were measured on agy 1.3.x with --output-format stream-json (see CAPABILITY-MATRIX.md):
//   {"event":"init","init":{model,tools,permission_mode,...}}
//   {"event":"step_update","step_update":{step_index,state:ACTIVE|DONE|ERROR,step_type:user_input|agent_response|tool,tool_name,tool_info:{parameters,output,error},text_delta}}
//   {"event":"result","result":{status:SUCCESS|ERROR|...,response,error,num_turns,denied_actions,structured_output,usage}}
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { log, progress } from './util.mjs';

const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };

/** Where agy lives. No user name is hard coded: AGY_BIN, then PATH, then the folder the agy installer uses. */
export function findAgy() {
  const found = [];
  if (process.env.AGY_BIN) found.push(process.env.AGY_BIN);
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['agy'], { encoding: 'utf8', windowsHide: true });
  for (const l of (r.stdout || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean)) found.push(l);
  if (process.platform === 'win32') { if (process.env.LOCALAPPDATA) found.push(path.join(process.env.LOCALAPPDATA, 'agy', 'bin', 'agy.exe')); }
  else found.push(path.join(os.homedir(), '.local', 'bin', 'agy'));
  return found.find(isFile) || null;
}

/** [command, ...leading args]. PLAN_RUNNER_AGY_CMD (a JSON array) points the chaos tests at a fake agy. */
export function agyCommand() {
  if (process.env.PLAN_RUNNER_AGY_CMD) return JSON.parse(process.env.PLAN_RUNNER_AGY_CMD);
  const bin = findAgy();
  if (!bin) throw new Error('The "agy" command was not found. Install Antigravity CLI, or set AGY_BIN to the full path of agy.');
  return [bin];
}

export const activePids = new Set();

/** Kill a process and all its children (agy starts a shell for every command, and the shell starts the real program). */
export function killTree(pid) {
  if (!pid) return;
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
    else process.kill(-pid, 'SIGKILL');
  } catch { /* already gone */ }
}

const DENIED = /permission check failed|denied by pre-tool hook|permission denied|user denied permission|JSON hook .{0,80} failed/i;
const QUOTA = /quota|credits? balance|rate.?limit|resource.?exhausted|too many requests|usage limit|model capacity|\b429\b/i;

/** True when a failed session looks like a usage limit, a rate limit or a spent credit balance. */
export function quotaError(f) {
  if (f.result?.status === 'SUCCESS') return false;
  const text = [f.result?.error, f.agyError ? JSON.stringify(f.agyError) : '', f.stderrTail].filter(Boolean).join('\n');
  return QUOTA.test(text);
}

/** Seconds the server asked us to wait, when agy's AGY_ERROR line carries it (the field name is not documented, so look for the usual ones). */
export function retryAfterMs(f) {
  const e = f.agyError || {};
  for (const k of ['retry_after_seconds', 'retryAfterSeconds', 'retry_after', 'retryDelaySeconds', 'retry_delay_seconds']) {
    if (Number(e[k]) > 0) return Number(e[k]) * 1000;
  }
  return null;
}

function describeTool(u) {
  const p = u.tool_info?.parameters || {};
  const target = p.toolSummary || p.toolAction || p.CommandLine || p.TargetFile || p.AbsolutePath || p.SearchPath || p.Query || '';
  return `${u.tool_name} ${String(target).replace(/\s+/g, ' ').slice(0, 110)}`.trim();
}

/**
 * opts: { args, prompt, cwd, env, idleMs, timeoutMs, maxToolSteps, rawLog, stopAfterCheckpoint(toolSteps) }
 * Returns facts: { exitCode, killedFor, result, toolSteps, denials, agyError, stderrTail, sawCheckpointStop, spawnError, lingered }
 */
export function runAgy(opts) {
  return new Promise((resolve) => {
    const [cmd, ...pre] = agyCommand();
    const child = spawn(cmd, [...pre, '-p', opts.prompt, '--output-format', 'stream-json', ...opts.args], {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32',
      shell: /\.(cmd|bat)$/i.test(cmd),
    });
    activePids.add(child.pid);
    const raw = opts.rawLog ? fs.createWriteStream(opts.rawLog, { flags: 'a' }) : null;
    const facts = {
      exitCode: null, killedFor: null, result: null, toolSteps: 0, denials: [], agyError: null,
      stderrTail: '', sawCheckpointStop: false, spawnError: null, lingered: false,
    };
    const announced = new Set();
    const counted = new Set();
    const text = new Map();
    let last = Date.now();
    let buf = '';
    let errBuf = '';
    let done = false;
    let lingerTimer = null;

    const kill = (why) => {
      if (facts.killedFor) return;
      facts.killedFor = why;
      log('System', `Stopping the agy session (${why}).`);
      killTree(child.pid);
    };

    const idleTimer = setInterval(() => {
      if (Date.now() - last > opts.idleMs) kill(`idle for ${Math.round(opts.idleMs / 60000)} min`);
    }, 5000);
    const hardTimer = setTimeout(() => kill(`timeout after ${Math.round(opts.timeoutMs / 60000)} min`), opts.timeoutMs);

    const handle = (line) => {
      raw?.write(`${line}\n`);
      let ev;
      try { ev = JSON.parse(line); } catch { log('CLI Internal', `(non-JSON stdout) ${line.slice(0, 300)}`); return; }
      if (ev.event === 'init') {
        log('System', `Session started (model ${ev.init?.model ?? '?'}, ${ev.init?.tools?.length ?? '?'} tools, permissions ${ev.init?.permission_mode ?? '?'}).`);
      } else if (ev.event === 'step_update') {
        const u = ev.step_update || {};
        if (u.step_type === 'tool') {
          if (!announced.has(u.step_index)) { announced.add(u.step_index); progress(describeTool(u)); }
          if (u.state === 'DONE' || u.state === 'ERROR') {
            if (!counted.has(u.step_index)) { counted.add(u.step_index); facts.toolSteps++; }
            const msg = u.tool_info?.error?.message || '';
            if (u.state === 'ERROR' && DENIED.test(msg)) {
              facts.denials.push({ tool: u.tool_name, why: msg.slice(0, 200) });
              log('Denied', `${describeTool(u)} was refused: ${msg.split('\n')[0].slice(0, 160)}`);
            }
            const out = u.tool_info?.output;
            if (typeof out === 'string' && /CHECKPOINT \d+ OK/.test(out)) {
              log('System', out.match(/CHECKPOINT \d+ OK[^\r\n]*/)[0]);
              if (opts.stopAfterCheckpoint?.(facts.toolSteps)) { // turn budget exceeded: continue in a fresh session
                facts.sawCheckpointStop = true;
                kill('turn budget exceeded, continuing from this checkpoint in a fresh session');
              }
            }
            if (opts.maxToolSteps && facts.toolSteps > opts.maxToolSteps) kill(`turn limit of ${opts.maxToolSteps} tool calls reached`);
          }
        } else if (u.step_type === 'agent_response') {
          if (u.text_delta) text.set(u.step_index, (text.get(u.step_index) || '') + u.text_delta);
          if (u.state === 'DONE' && text.get(u.step_index)?.trim()) progress(`says: ${text.get(u.step_index).trim().replace(/\s+/g, ' ').slice(0, 140)}`);
        }
      } else if (ev.event === 'result') {
        facts.result = ev.result;
        // agy may keep waiting for background tasks (a dev server the session started). The answer is in: do not wait 30 minutes.
        lingerTimer = setTimeout(() => { if (!done) { facts.lingered = true; killTree(child.pid); } }, opts.lingerMs ?? Number(process.env.PLAN_RUNNER_LINGER_MS || 20000));
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
      errBuf += s;
      let i;
      while ((i = errBuf.indexOf('\n')) >= 0) {
        const m = /AGY_ERROR:\s*(\{.*\})/.exec(errBuf.slice(0, i));
        errBuf = errBuf.slice(i + 1);
        if (m) { try { facts.agyError = JSON.parse(m[1]); } catch { facts.agyError = { raw: m[1].slice(0, 300) }; } }
      }
    });
    child.on('error', (e) => { facts.spawnError = e.message; });
    child.on('close', (code) => {
      if (done) return;
      done = true;
      activePids.delete(child.pid);
      if (buf.trim()) handle(buf.trim());
      clearInterval(idleTimer);
      clearTimeout(hardTimer);
      clearTimeout(lingerTimer);
      raw?.end();
      facts.exitCode = code;
      resolve(facts);
    });
  });
}
