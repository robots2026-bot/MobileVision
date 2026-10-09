import { execFile } from 'node:child_process';
import path from 'node:path';

export type PowerAction = 'shutdown' | 'hibernate' | 'sleep' | 'restart' | 'screenOff' | 'screenOn';
export interface PowerJob { id: string; action: PowerAction; executeAt: number; state: 'pending' | 'executing' | 'submitted' | 'canceled' | 'failed'; }
export class PowerError extends Error { constructor(public status: number, public code: string) { super(code); } }

// Arguments are selected locally; no phone input is interpolated into a command.
export function powerCommand(action: PowerAction): [string, string[]] {
  const system = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
  if (action === 'shutdown' || action === 'restart') return [path.join(system, 'shutdown.exe'), [action === 'shutdown' ? '/s' : '/r', '/t', '0']];
  if (action === 'screenOff' || action === 'screenOn') return [path.join(system, 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', `$ErrorActionPreference = 'Stop'; Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class MobileVisionDisplay { [DllImport("user32.dll", EntryPoint = "SendNotifyMessageW", ExactSpelling = true, SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool SendNotifyMessage(IntPtr hWnd, uint msg, UIntPtr wParam, IntPtr lParam); public static bool ${action === 'screenOff' ? 'TurnOff' : 'TurnOn'}() { return SendNotifyMessage(new IntPtr(65535), 0x0112, new UIntPtr(0xF170u), new IntPtr(${action === 'screenOff' ? 2 : -1})); } }'; if (-not [MobileVisionDisplay]::${action === 'screenOff' ? 'TurnOff' : 'TurnOn'}()) { throw ('SendNotifyMessageW failed: ' + [Runtime.InteropServices.Marshal]::GetLastWin32Error()) }`]];
  const state = action === 'sleep' ? 'Suspend' : 'Hibernate';
  return [path.join(system, 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', `Add-Type -AssemblyName System.Windows.Forms; if (-not [System.Windows.Forms.Application]::SetSuspendState([System.Windows.Forms.PowerState]::${state}, $false, $false)) { exit 1 }`]];
}
export async function executePower(action: PowerAction) {
  if (process.platform !== 'win32') throw new PowerError(503, 'POWER_UNSUPPORTED');
  const [file, args] = powerCommand(action);
  await new Promise<void>((resolve, reject) => execFile(file, args, { windowsHide: true }, error => error ? reject(error) : resolve()));
}

export class PowerControl {
  enabled = true;
  private displayOff = false;
  private jobs = new Map<string, PowerJob>();
  private timer?: ReturnType<typeof setTimeout>;
  constructor(private changed: () => void, private execute = executePower, private delay = 5_000) {}
  status() { return { enabled: this.enabled, displayOff: this.displayOff, job: [...this.jobs.values()].at(-1) || null }; }
  setEnabled(value: boolean) { this.enabled = value; if (!value) this.cancelPending(); this.changed(); }
  schedule(id: unknown, action: unknown) {
    if (!this.enabled) throw new PowerError(403, 'POWER_DISABLED');
    if (typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) || !['shutdown', 'hibernate', 'sleep', 'restart', 'screenOff', 'screenOn'].includes(action as string)) throw new PowerError(400, 'INVALID_POWER_REQUEST');
    const previous = this.jobs.get(id);
    if (previous) { if (previous.action !== action) throw new PowerError(409, 'POWER_ID_CONFLICT'); return previous; }
    if (this.jobs.size >= 100) throw new PowerError(429, 'POWER_LIMIT');
    if ([...this.jobs.values()].some(job => job.state === 'pending' || job.state === 'executing')) throw new PowerError(409, 'POWER_BUSY');
    const delay = action === 'screenOff' || action === 'screenOn' ? 0 : this.delay;
    const job: PowerJob = { id, action: action as PowerAction, executeAt: Date.now() + delay, state: 'pending' };
    this.jobs.set(id, job);
    this.timer = setTimeout(() => {
      if (job.state !== 'pending' || !this.enabled) return;
      job.state = 'executing'; this.changed();
      void this.execute(job.action).then(() => { job.state = 'submitted'; if (job.action === 'screenOff') this.displayOff = true; if (job.action === 'screenOn') this.displayOff = false; }, error => { job.state = 'failed'; console.error(`Power action ${job.action} failed:`, error); }).finally(this.changed);
    }, delay);
    this.changed(); return job;
  }
  cancelPending() { clearTimeout(this.timer); for (const job of this.jobs.values()) if (job.state === 'pending') job.state = 'canceled'; this.changed(); }
  dispose() { this.setEnabled(false); }
}
