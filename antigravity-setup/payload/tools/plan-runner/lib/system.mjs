// Windows touches: toast alert and keeping the PC awake. Both are best effort and never throw.
import { spawn } from 'node:child_process';
import { log } from './util.mjs';

const enc = (s) => Buffer.from(s, 'utf16le').toString('base64');

/** Windows toast (title and body travel in env vars, never inside the script text). */
export function toast(title, body) {
  log('Alert', `${title} - ${body}`);
  if (process.env.PLAN_RUNNER_QUIET) return;
  process.stdout.write('\x07'); // terminal bell
  if (process.platform !== 'win32') return;
  const script = `
$ErrorActionPreference='Stop'
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null
$t=[Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
$n=$t.GetElementsByTagName('text')
$n.Item(0).AppendChild($t.CreateTextNode($env:PR_TITLE)) > $null
$n.Item(1).AppendChild($t.CreateTextNode($env:PR_BODY)) > $null
$app='{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($app).Show([Windows.UI.Notifications.ToastNotification]::new($t))
`;
  try {
    const p = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', enc(script)], {
      env: { ...process.env, PR_TITLE: String(title).slice(0, 120), PR_BODY: String(body).slice(0, 240) },
      windowsHide: true, stdio: 'ignore',
    });
    p.on('error', () => {});
    p.unref();
  } catch { /* ignore */ }
}

/** Stop Windows sleeping while the run is active. Returns a function that stops it. */
export function keepAwake() {
  if (process.platform !== 'win32' || process.env.PLAN_RUNNER_QUIET) return () => {};
  const script = `
Add-Type -Namespace PR -Name K -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint f);'
[void][PR.K]::SetThreadExecutionState(0x80000001)
while ($true) {
  Start-Sleep -Seconds 30
  if (-not (Get-Process -Id ${process.pid} -ErrorAction SilentlyContinue)) { break }
}`;
  try {
    const p = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', enc(script)], {
      windowsHide: true, stdio: 'ignore',
    });
    p.on('error', () => {});
    log('System', 'Keeping Windows awake while the run is active.');
    return () => { try { p.kill(); } catch { /* ignore */ } };
  } catch { return () => {}; }
}
