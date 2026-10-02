import { validateFilePaths, clipboardFilePaths } from './file-input';
import { app, BrowserWindow, dialog, ipcMain, protocol, net, shell, clipboard, ClipboardItem } from 'electron';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import sharp from 'sharp';
import QRCode from 'qrcode';
import { cropPhoto } from './crop';
import { Receiver, addresses } from './receiver';
import type { DesktopState } from '../shared';

protocol.registerSchemesAsPrivileged([{ scheme: 'mv-photo', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
const smoke = process.argv.includes('--smoke-test');
const androidE2E = process.argv.includes('--android-e2e');
const testing = smoke || androidE2E;
if (testing) app.setPath('userData', path.join(process.cwd(), '.smoke-data', String(Date.now())));
const single = app.requestSingleInstanceLock();
if (!single) app.quit();
let win: BrowserWindow | undefined; let receiver: Receiver | undefined; let closing = false; let exitCode = 0; let selectedAddress = '';
const uiPath = path.join(__dirname, '../renderer/index.html');

let preparingSend = false;
async function enqueueFiles(value: unknown) {
  if (preparingSend) throw new Error('正在准备文件，请稍后再添加');
  const device = receiver!.deviceIdentity(); if (!device) throw new Error('请先配对手机');
  const files = validateFilePaths(value); preparingSend = true;
  try { const failures: string[] = []; for (const filename of files) { try { await receiver!.outgoing.add(device, filename); } catch (error: any) { failures.push(path.basename(filename) + '：' + error.message); } } if (failures.length) throw new Error(failures.join('\n')); }
  finally { preparingSend = false; }
}
async function state(): Promise<DesktopState> {
  const list = addresses(); if (!list.includes(selectedAddress)) selectedAddress = list[0] || '127.0.0.1';
  const pair = receiver!.pairing(selectedAddress);
  return { directory: receiver!.directory, addresses: list, selectedAddress, port: receiver!.port, running: receiver!.port > 0, pairing: { qr: await QRCode.toDataURL(JSON.stringify(pair), { width: 260, margin: 2, errorCorrectionLevel: 'M' }), expiresAt: pair.expiresAt }, device: receiver!.getDevice(), messages: receiver!.messages.list(), filesDirectory: receiver!.files.directory, files: [...receiver!.files.list(), ...receiver!.outgoing.list()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 500), photos: receiver!.photos(), error: receiver!.error };
}
function handler(name: string, callback: (...args: any[]) => any) {
  ipcMain.handle(name, (event, ...args) => {
    const mainSender = !!win && event.sender === win.webContents && event.senderFrame === win.webContents.mainFrame;
    if (!mainSender) throw new Error('Untrusted sender');
    return callback(...args);
  });
}

async function createMainWindow(show = true) {
  if (win && !win.isDestroyed()) { if (win.isMinimized()) win.restore(); if (show) { win.show(); win.focus(); } return win; }
  win = new BrowserWindow({ width: 1260, height: 850, minWidth: 1000, minHeight: 700, show, backgroundColor: '#f4f6f9', title: 'MobileVision · 手机图片助手', autoHideMenuBar: true, webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' })); win.webContents.on('will-navigate', event => event.preventDefault()); win.on('closed', () => { win = undefined; });
  await win.loadFile(uiPath); return win;
}
async function pastePng(bytes: Buffer) {
  await clipboard.write([new ClipboardItem({ 'image/png': new Blob([new Uint8Array(bytes)], { type: 'image/png' }) })]);
  if (testing) return;
  await new Promise<void>((resolve, reject) => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('^v')"], { windowsHide: true }, error => error ? reject(error) : resolve()));
}
async function pastePhoto(id: string) {
  const filename = receiver?.photoPath(id); if (!filename) throw new Error('照片不存在'); await pastePng(await sharp(filename).rotate().png().toBuffer());
}

if (single) app.whenReady().then(async () => {
  receiver = new Receiver(app.getPath('userData'), testing ? path.join(app.getPath('userData'), 'photos') : path.join(app.getPath('pictures'), 'MobileVision'), testing ? '127.0.0.1' : '0.0.0.0', path.join(testing ? app.getPath('userData') : app.getPath('downloads'), 'MobileVision'));
  await receiver.initialize();
  receiver.on('change', () => { if (win && !win.isDestroyed()) win.webContents.send('changed'); });
  receiver.on('paste', (id: string) => { void pastePhoto(id).catch(error => console.error('Paste failed', error)); });
  protocol.handle('mv-photo', async request => {
    try {
      const url = new URL(request.url); const id = url.pathname.slice(1);
      if (!/^[0-9a-f-]{36}$/.test(id) || !['image', 'thumb'].includes(url.hostname)) return new Response(null, { status: 404 });
      if (url.hostname === 'thumb') { const bytes = await receiver!.thumbnail(id); return bytes ? new Response(new Uint8Array(bytes), { headers: { 'Content-Type': 'image/jpeg' } }) : new Response(null, { status: 404 }); }
      const filename = receiver!.photoPath(id); return filename ? net.fetch(pathToFileURL(filename).toString()) : new Response(null, { status: 404 });
    } catch { return new Response(null, { status: 404 }); }
  });
  receiver.on('copy-text', (text: string) => clipboard.writeText(text));
  handler('open-text-link', async (value: unknown) => { if (typeof value !== 'string') throw new Error('无效链接'); const url = new URL(value); if (!['http:', 'https:'].includes(url.protocol)) throw new Error('仅支持网页链接'); await shell.openExternal(url.toString()); });
  handler('send-text', (text: unknown) => { const device = receiver!.deviceIdentity(); if (!device) throw new Error('请先配对手机'); receiver!.messages.send(device, text); });
  handler('copy-text', (id: unknown) => { if (typeof id !== 'string') throw new Error('无效消息'); const text = receiver!.messages.text(id); if (text === undefined) throw new Error('消息不存在'); clipboard.writeText(text); });
  handler('clean-messages', () => receiver!.messages.clean());
  handler('state', state);
  handler('copy-crop', async (id: unknown, region: any) => {
    if (typeof id !== 'string') throw new Error('无效照片');
    const filename = receiver!.photoPath(id); if (!filename) throw new Error('照片不存在');
    const bytes = await cropPhoto(filename, region);
    await clipboard.write([new ClipboardItem({ 'image/png': new Blob([new Uint8Array(bytes)], { type: 'image/png' }) })]);
  });
  handler('save-crop', async (id: unknown, region: any) => {
    if (typeof id !== 'string') throw new Error('无效照片');
    const filename = receiver!.photoPath(id); if (!filename) throw new Error('照片不存在');
    const bytes = await cropPhoto(filename, region);
    const result = await dialog.showSaveDialog(win!, { title: '保存照片截图', defaultPath: path.join(path.dirname(filename), path.basename(filename, path.extname(filename)) + '-截图.png'), filters: [{ name: 'PNG 图片', extensions: ['png'] }] });
    if (result.canceled || !result.filePath) return null;
    if (path.resolve(result.filePath).toLowerCase() === path.resolve(filename).toLowerCase()) throw new Error('截图不能覆盖原照片');
    await writeFile(result.filePath, bytes); return result.filePath;
  });
  handler('delete-photos', async (ids: unknown) => {
    if (!Array.isArray(ids) || !ids.length || ids.length > 500 || ids.some(id => typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id))) throw new Error('无效的照片选择');
    const unique = [...new Set<string>(ids)];
    const result = await dialog.showMessageBox(win!, { type: 'warning', message: '删除选中的 ' + unique.length + ' 张照片？', detail: '将永久删除电脑原图、缩略图和列表记录，不进入回收站。手机上的副本不受影响。', buttons: ['取消', '删除'], defaultId: 0, cancelId: 0, noLink: true });
    if (result.response !== 1) return false;
    await receiver!.deletePhotos(unique); return true;
  });
  handler('copy-pairing', () => { clipboard.writeText(JSON.stringify(receiver!.pairing(selectedAddress))); });
  handler('export-diagnostics', async () => {
    const result = await dialog.showSaveDialog(win!, { defaultPath: 'MobileVision-diagnostics.json', filters: [{ name: 'JSON', extensions: ['json'] }] });
    if (!result.canceled && result.filePath) await writeFile(result.filePath, JSON.stringify({ version: app.getVersion(), platform: process.platform, ...receiver!.diagnostics() }, null, 2));
  });
  handler('choose-directory', async () => { const result = await dialog.showOpenDialog(win!, { properties: ['openDirectory', 'createDirectory'] }); if (!result.canceled) await receiver!.setDirectory(result.filePaths[0]); });
  handler('send-file-paths', (value: unknown) => enqueueFiles(value));
  handler('paste-files', async () => { if (!receiver!.deviceIdentity()) throw new Error('请先配对手机'); await enqueueFiles(await clipboardFilePaths()); });
  handler('send-files', async () => { if (!receiver!.deviceIdentity()) throw new Error('请先配对手机'); const result = await dialog.showOpenDialog(win!, { title: '发送文件到手机', properties: ['openFile', 'multiSelections'] }); if (!result.canceled) await enqueueFiles(result.filePaths); });
  handler('cancel-send-file', (id: unknown) => { if (typeof id !== 'string') throw new Error('无效文件'); return receiver!.outgoing.cancel(id); });
  handler('choose-files-directory', async () => { const result = await dialog.showOpenDialog(win!, { properties: ['openDirectory', 'createDirectory'] }); if (!result.canceled) await receiver!.files.setDirectory(result.filePaths[0]); });
  handler('open-files-directory', async () => { const error = await shell.openPath(receiver!.files.directory); if (error) throw new Error(error); });
  handler('open-file', async (id: unknown) => { if (typeof id !== 'string') throw new Error('无效文件'); const filename = receiver!.files.filePath(id) || receiver!.outgoing.original(id); if (!filename) throw new Error('文件尚未接收完成'); const error = await shell.openPath(filename); if (error) throw new Error(error); });
  handler('reveal-file', (id: unknown) => { if (typeof id !== 'string') throw new Error('无效文件'); const filename = receiver!.files.filePath(id) || receiver!.outgoing.original(id); if (!filename) throw new Error('文件尚未接收完成'); shell.showItemInFolder(filename); });
  handler('refresh-pairing', () => receiver!.refreshPairing());
  handler('select-address', (address: unknown) => { if (typeof address !== 'string' || !addresses().includes(address)) throw new Error('无效网卡地址'); selectedAddress = address; receiver!.refreshPairing(); });
  handler('revoke', async () => { const result = await dialog.showMessageBox(win!, { type: 'question', message: '解除手机配对？', detail: '解除后，手机需要重新扫码才能继续上传。已接收的照片会保留。', buttons: ['取消', '解除配对'], defaultId: 0, cancelId: 0 }); if (result.response === 1) receiver!.revoke(); });
  handler('open-directory', async () => { const error = await shell.openPath(receiver!.directory); if (error) throw new Error(error); });
  handler('reveal-photo', (id: unknown) => { if (typeof id !== 'string') throw new Error('无效照片'); const filename = receiver!.photoPath(id); if (!filename) throw new Error('照片不存在'); shell.showItemInFolder(filename); });
  const mainWindow = await createMainWindow(!testing);
  if (androidE2E) {
    const { runAndroidE2E } = await import('./android-e2e.js');
    await runAndroidE2E(receiver, mainWindow);
    app.quit();
  }
  if (smoke) {
    const { runSmoke } = await import('./smoke.js');
    await runSmoke(receiver, mainWindow);
    app.quit();
  }
}).catch(async error => {
  if (testing) { await mkdir('test-results', { recursive: true }); await writeFile('test-results/smoke-error.txt', String(error.stack || error)); exitCode = 1; }
  else dialog.showErrorBox('MobileVision 启动失败', error.message);
  app.quit();
});
app.on('second-instance', () => { void createMainWindow(true); });
app.on('window-all-closed', () => app.quit());
app.on('before-quit', event => { if (receiver && !closing) { event.preventDefault(); closing = true; void receiver.close().finally(() => app.exit(exitCode)); } });
