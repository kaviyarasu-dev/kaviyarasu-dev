// The deny rules for unattended sessions. Used by guard.mjs (the PreToolUse hook that agy runs before
// every tool call) and by the offline tests. No dependencies. Best effort: a program that can run code
// can still reach what a rule refuses. The real safety is the git rollback, the scope gate, the secret
// file gate, the HEAD check and the final review in run.mjs.
import { matchesAny } from './util.mjs';

// Where a command can begin: start of the line, after ; & | ( { ` $( or a newline, after an optional
// PowerShell call operator and after any NAME=value prefixes.
const START = String.raw`(?:^|[;&|(){}\n\r\`]|\$\()\s*(?:&\s*)?(?:[A-Za-z_]\w*=(?:"[^"]*"|'[^']*'|\S*)\s+)*(?:(?:then|do|else|elif|exec|command|call|nohup|time|env)\s+)*`;
// The command may be given with a folder in front of it ("C:\Program Files\Git\cmd\git.exe", ./gradlew).
const FOLDER = String.raw`(?:"[^"]*[\\/]|'[^']*[\\/]|[^\s"'|;&(){}]*[\\/])?`;
const EXT = String.raw`(?:\.(?:exe|cmd|bat|ps1))?["']?`;

const esc = (s) => s.replace(/[.+^$()|[\]\\{}?]/g, '\\$&');

/**
 * "git commit*" or "npm publish" or "git branch -*" -> RegExp that matches where a command starts.
 * Words are split on spaces, * is a wildcard. A pattern that ends in * is a prefix match; otherwise the
 * last word must end there (so "git commit" does not match "git commit-tree").
 */
export function commandPattern(pattern) {
  const words = pattern.trim().split(/\s+/);
  const open = words[words.length - 1].endsWith('*');
  const parts = words.map((w) => esc(w).replace(/\*/g, '.*?'));
  const name = parts[0];
  let re = `${START}${FOLDER}${name}${words.length === 1 && !open ? EXT : '(?:\\.(?:exe|cmd|bat))?["\']?'}`;
  for (const p of parts.slice(1)) re += String.raw`\s+` + p;
  if (!open) re += String.raw`(?![\w-])`;
  return new RegExp(re, 'i');
}

const SEP_BEFORE = String.raw`(?:^|[\s"'/\\=:(,])`;
const END_AFTER = String.raw`(?=$|[\s"';|&)\\/,])`;

/** Rules that look at the whole command line, anywhere in it. [regex, reason] */
export const TEXT_RULES = [
  // secret and credential files (but not process.env, and not the .env.example family)
  [new RegExp(`${SEP_BEFORE}\\.env(?:\\.(?!(?:example|sample|template|dist)${END_AFTER})[\\w.-]+)?${END_AFTER}`, 'i'), 'secret files (.env) are off limits'],
  [new RegExp(`${SEP_BEFORE}\\.(?:ssh|aws|gnupg|kube)${END_AFTER}`, 'i'), 'credential folders are off limits'],
  [new RegExp(`${SEP_BEFORE}\\.(?:npmrc|netrc|pypirc)${END_AFTER}`, 'i'), 'credential files are off limits'],
  [/(?:^|[\s"'/\\=])id_(?:rsa|ed25519|ecdsa|dsa)\b/i, 'private keys are off limits'],
  // the repository metadata and the agent's own configuration
  [new RegExp(`${SEP_BEFORE}\\.git[\\\\/]`, 'i'), '.git is managed by the runner'],
  // agent settings, hooks, sub-agents and skills change how the NEXT session behaves; rule and doc files (.claude/rules, .agents/rules) are open
  [new RegExp(`${SEP_BEFORE}\\.claude[\\\\/](?:settings[\\w.-]*\\.json|hooks|agents|skills|commands)(?:[\\\\/]|${END_AFTER})`, 'i'), 'the agent configuration is managed by the runner'],
  [new RegExp(`${SEP_BEFORE}\\.agents?[\\\\/](?:hooks\\.json|hooks|skills|workflows)(?:[\\\\/]|${END_AFTER})`, 'i'), 'the agent configuration is managed by the runner'],
  [new RegExp(`${SEP_BEFORE}\\.gemini[\\\\/](?:config|antigravity[\\w-]*)(?:[\\\\/]|${END_AFTER})`, 'i'), 'the agent configuration is managed by the runner'],
  [/agy-home|plan-runs/i, 'the runner\'s own state is off limits'],
  // recursive deletes
  [/\b(?:remove-item|ri|rm|del|erase|rd|rmdir)\b[^|;&\n]{0,400}\s-r(?:e(?:c(?:u(?:r(?:s(?:e)?)?)?)?)?)?(?=[\s;|&)]|$)/i, 'recursive delete'],
  [/\b[rR][mM]\s+(?:-[a-zA-Z]+\s+)*-[rRfivdI]*[rR][rRfivdI]*(?=\s|$)/, 'recursive delete'], // only the letters rm takes: PowerShell's -Force is not a match
  [/\brm\s+(?:-\S+\s+)*--recursive\b/i, 'recursive delete'],
  [/\b(?:rmdir|rd|del)\b[^|;&\n]{0,400}\s\/s\b/i, 'recursive delete'],
  [/\bfind\b[^|;&\n]{0,400}\s-(?:delete|exec\s+rm)\b/i, 'recursive delete'],
  // network access from PowerShell and .NET
  [/\b(?:Invoke-WebRequest|Invoke-RestMethod|Start-BitsTransfer|Test-NetConnection)\b/i, 'network access'],
  [/\bNet\.WebClient\b|System\.Net\.(?:Http|Sockets|WebClient|WebRequest)|\bDownload(?:String|File|Data)\b/i, 'network access'],
  // running code that could bypass these rules
  [/\bInvoke-Expression\b|\bInvoke-Command\b|\bEnter-PSSession\b|\bStart-Process\b|\bStart-Job\b/i, 'starts another process outside the rules'],
  [/\bHK(?:LM|CU|CR|U|CC):/i, 'registry access'],
  // a branch can be created or switched with "git branch <name>": only the read-only forms are allowed
  [/\bgit\s+branch\s+(?!(?:--show-current|--list|--contains|--merged|--no-merged|-a|-r|-v|-vv|-l)(?=\s|$))\S/i, 'git changes are done by the runner'],
];

/**
 * cfg is config/permissions.json. Command rules are written like the Claude ones: words and * ("git commit*").
 * A manifest's own permissions.deny entries use the same spelling as the Claude runner: "Bash(docker *)" adds a
 * command rule, "Read(glob)" a protected path, "Edit(glob)" or "Write(glob)" a write-protected path.
 */
export function compileRules(cfg = {}, manifestDeny = [], { readOnly = false, scope = null } = {}) {
  const cmds = [...(cfg.deny_commands || [])];
  const denyPaths = [...(cfg.deny_paths || [])];
  const denyWritePaths = [...(cfg.deny_write_paths || [])];
  const unsupported = [];
  for (const entry of manifestDeny) {
    const m = /^(Bash|Read|Edit|Write)\((.*)\)$/.exec(String(entry).trim());
    if (!m) { unsupported.push(entry); continue; }
    if (m[1] === 'Bash') cmds.push(m[2]);
    else if (m[1] === 'Read') denyPaths.push(m[2]);
    else denyWritePaths.push(m[2]);
  }
  const lower = (g) => g.map((x) => x.toLowerCase());
  return {
    commands: cmds.map((p) => ({ pattern: p, re: commandPattern(p) })),
    text: TEXT_RULES,
    denyPaths: lower(denyPaths),
    denyWritePaths: lower(denyWritePaths),
    allowPaths: lower(cfg.allow_paths || []),
    unsupported,
    readOnly, // the final review: no shell and no file edits at all
    // file writes must stay inside the project repos (plus the temp folder and the session's own HOME), and out of the plan folder
    scope: scope ? {
      roots: (scope.roots || []).map(normDir),
      allowWrite: (scope.allowWrite || []).map(normDir),
      planDir: scope.planDir ? normDir(scope.planDir) : null,
    } : null,
  };
}

const normDir = (p) => String(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
const isAbs = (p) => /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('/') || p.startsWith('\\\\');
const under = (file, dir) => file === dir || file.startsWith(`${dir}/`);

/** Why a write to this absolute path is refused, or null. */
function outsideScope(scope, raw) {
  const f = normDir(raw);
  if (scope.planDir && under(f, scope.planDir) && f !== `${scope.planDir}/blocked.md`) return `${raw} is in the plan folder (only BLOCKED.md may be written there)`;
  if (scope.roots.some((r) => under(f, r)) || scope.allowWrite.some((r) => under(f, r))) return null;
  return `${raw} is outside the project folders; only files inside them may be changed`;
}

const WRITE_TOOLS = /^(?:write_to_file|replace_file_content|multi_replace_file_content|sed_file|notebook_edit)$/;
const READ_TOOLS = /^(?:view_file|grep_search|list_dir|find_by_name|read_resource|read_url_content)$/;
const SHELL_TOOLS = /^(?:run_command|send_command_input)$/;

const norm = (p) => String(p).replace(/\\/g, '/');

function strings(v, out = []) {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => strings(x, out));
  else if (v && typeof v === 'object') Object.values(v).forEach((x) => strings(x, out));
  return out;
}

/** A path-looking string: has a separator or a leading dot, so a plain word like "yes" is never a path. */
const looksLikePath = (s) => /[\\/]/.test(s) || /^\.[\w-]/.test(s);

const refuse = (reason) => ({
  decision: 'deny',
  reason: `Refused by the plan runner: ${reason}. This does NOT mean your shell or tools are off. Do not retry the same command: do the same work another way (the runner does all git work itself, so a refused git command needs no replacement). Never drop a task because of this: if the plan truly cannot be done without it, write BLOCKED.md.`,
});

/** The PreToolUse decision for one tool call: { decision: 'deny', reason } or { decision: 'ask' } (= "use the normal permission rules"). */
export function decide(rules, toolCall) {
  const name = String(toolCall?.name || '');
  const args = toolCall?.args || {};

  if (rules.readOnly && (SHELL_TOOLS.test(name) || WRITE_TOOLS.test(name))) return refuse('this session is read-only: it may read files and nothing else');

  if (SHELL_TOOLS.test(name)) {
    const line = String(args.CommandLine ?? args.Input ?? '');
    for (const c of rules.commands) if (c.re.test(line)) return refuse(`"${c.pattern.replace(/\*$/, '')}" is not allowed`);
    for (const [re, why] of rules.text) {
      if (re.test(line)) {
        return refuse(why);
      }
    }
    return { decision: 'ask' };
  }

  const write = WRITE_TOOLS.test(name);
  const read = READ_TOOLS.test(name);
  if (write || read) {
    for (const s of strings(args)) {
      if (!looksLikePath(s) || s.length > 1000) continue;
      const shown = norm(s);
      const p = shown.toLowerCase();
      if (matchesAny(rules.allowPaths, p)) continue;
      if (matchesAny(rules.denyPaths, p)) return refuse(`${shown} is a protected file`);
      if (write && matchesAny(rules.denyWritePaths, p)) return refuse(`${shown} is managed by the runner`);
    }
    // only the target path, never the file content (a file can start with "/**")
    const target = write ? [args.TargetFile, args.AbsolutePath, args.FilePath, args.Path].find((x) => typeof x === 'string' && x) : null;
    if (target && rules.scope && isAbs(target)) {
      const why = outsideScope(rules.scope, target);
      if (why) return refuse(why);
    }
  }
  return { decision: 'ask' };
}
