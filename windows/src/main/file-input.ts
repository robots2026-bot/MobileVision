import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

export function validateFilePaths(value: unknown): string[] {
  if (!Array.isArray(value) || !value.length || value.length > 200 || value.some(p => typeof p !== 'string' || !p || p.length > 32767 || p.includes('\0') || !path.isAbsolute(p))) throw new Error('请选择或拖入磁盘上的文件，每次最多 200 个');
  return [...new Map(value.map(p => [path.normalize(p).toLowerCase(), path.normalize(p)])).values()];
}

export async function clipboardFilePaths(): Promise<string[]> {
  const script = "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); Add-Type -AssemblyName System.Windows.Forms; $items = [System.Windows.Forms.Clipboard]::GetFileDropList(); $kind = if ($items.Count -gt 0) { 'files' } elseif ([System.Windows.Forms.Clipboard]::ContainsText()) { 'text' } else { 'empty' }; ConvertTo-Json -InputObject @{kind=$kind;files=@($items)} -Compress";
  const { stdout } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-WindowStyle', 'Hidden', '-Command', script], { windowsHide: true, timeout: 10000, maxBuffer: 2 * 1024 * 1024, encoding: 'utf8' });
  const result = JSON.parse(stdout.replace(/^\uFEFF/, '').trim());
  if (result.kind === 'text') throw new Error('剪贴板里是文字，请到“文本”页发送');
  if (result.kind !== 'files') throw new Error('请先在资源管理器中复制文件，再粘贴到这里');
  return validateFilePaths(result.files);
}
