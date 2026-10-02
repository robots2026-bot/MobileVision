import { request } from 'node:https';
import { createHash, randomUUID, X509Certificate } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { BrowserWindow, clipboard, ClipboardItem, dialog } from 'electron';
import path from 'node:path';
import sharp from 'sharp';
import type { Receiver } from './receiver';

// Test client only: trusts exactly the receiver certificate, and checks its fingerprint.
export function call(receiver: Receiver, method: string, endpoint: string, body?: Buffer, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; body: any }>((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port: receiver.port, path: `/api/v1${endpoint}`, method, ca: receiver.certificate, checkServerIdentity: (_host, certificate) => new X509Certificate(certificate.raw).fingerprint256.replaceAll(':', '').toLowerCase() === receiver.fingerprint ? undefined : new Error('Certificate pin mismatch'), headers: { ...headers, ...(body ? { 'Content-Length': String(body.length) } : {}) } }, res => {
      let text = ''; res.on('data', chunk => { text += chunk; }); res.on('end', () => { try { resolve({ status: res.statusCode!, body: JSON.parse(text) }); } catch (e) { reject(e); } });
    });
    req.setTimeout(10_000, () => req.destroy(new Error('Test request timeout'))); req.on('error', reject); req.end(body);
  });
}
export function photoHeaders(credential: string, image: Buffer, contentType = 'image/jpeg') { return { Authorization: `Bearer ${credential}`, 'Content-Type': contentType, 'X-Content-Sha256': createHash('sha256').update(image).digest('hex'), 'X-Captured-At': new Date().toISOString() }; }
export async function samplePhoto() {
  return sharp(Buffer.from('<svg width="1200" height="800" xmlns="http://www.w3.org/2000/svg"><rect width="1200" height="800" fill="#dbe9e5"/><circle cx="950" cy="160" r="84" fill="#fff0bc"/><path d="M0 580L330 190L660 580L890 310L1200 680V800H0" fill="#648f84"/><path d="M0 710L390 480L780 710L1200 520V800H0" fill="#315f5c"/><text x="70" y="110" font-size="36" font-family="Arial" fill="#315f5c">MobileVision / Test photo</text></svg>')).jpeg({ quality: 90 }).toBuffer();
}
async function waitFor(win: BrowserWindow, expression: string) {
  for (let attempt = 0; attempt < 100; attempt++) { if (await win.webContents.executeJavaScript(expression)) return; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error(`UI timeout: ${expression}`);
}
async function clipboardPngSize() { const item = (await clipboard.read()).find(value => value.types.includes('image/png')); if (!item) return { width: 0, height: 0 }; const info = await sharp(Buffer.from(await ((await item.getType('image/png')) as Blob).arrayBuffer())).metadata(); return { width: info.width || 0, height: info.height || 0 }; }
export async function runSmoke(receiver: Receiver, win: BrowserWindow) {
  await mkdir('test-results', { recursive: true });
  await rm('test-results/smoke-error.txt', { force: true });
  await waitFor(win, "document.body.innerText.includes('等待第一张照片') && document.querySelector('.qr img')?.naturalWidth > 0");
  await win.webContents.capturePage().then(image => writeFile('test-results/windows-empty.png', image.toPNG())).catch(error => writeFile('test-results/visual-capture-warning.txt', String(error)));
  const pair = await call(receiver, 'POST', '/pair', Buffer.from(JSON.stringify({ token: receiver.pairing('127.0.0.1').token, deviceId: randomUUID(), deviceName: '模拟 Android 手机' })), { 'Content-Type': 'application/json' });
  if (pair.status !== 201) throw new Error('Smoke pairing failed');
  const image = await samplePhoto(); const upload = await call(receiver, 'PUT', `/photos/${randomUUID()}`, image, photoHeaders(pair.body.credential, image));
  if (upload.status !== 201) throw new Error(`Smoke upload failed: ${JSON.stringify(upload)}`);
  await waitFor(win, "document.querySelector('.viewer img')?.naturalWidth === 1200 && document.querySelector('.thumbnail img')?.naturalWidth > 0");
  if (await win.webContents.executeJavaScript("document.querySelector('[data-testid=\"show-float\"]') !== null") || BrowserWindow.getAllWindows().length !== 1) throw new Error('Floating window UI or window still exists');
  const secondImage = await sharp(image).tint('#d9e4ff').jpeg({ quality: 90 }).toBuffer(); const secondUpload = await call(receiver, 'PUT', `/photos/${randomUUID()}`, secondImage, { ...photoHeaders(pair.body.credential, secondImage), 'X-Paste-After-Receive': '1' });
  if (secondUpload.status !== 201) throw new Error(`Second smoke upload failed: ${JSON.stringify(secondUpload)}`);
  await waitFor(win, `document.querySelector('.viewer img')?.src.endsWith('${secondUpload.body.id}') && document.querySelectorAll('.thumbnail').length === 2`);
  if (BrowserWindow.getAllWindows().length !== 1) throw new Error('Paste upload unexpectedly created another window');
  let receivedClipboard = await clipboardPngSize(); for (let attempt = 0; attempt < 50 && !receivedClipboard.width; attempt++) { await new Promise(resolve => setTimeout(resolve, 50)); receivedClipboard = await clipboardPngSize(); }
  if (receivedClipboard.width !== 1200 || receivedClipboard.height !== 800) throw new Error('Phone paste request did not place the received image on the clipboard');
  await win.webContents.executeJavaScript("document.querySelectorAll('.thumbnail')[1].click()"); await waitFor(win, `document.querySelector('.viewer img')?.src.endsWith('${upload.body.id}')`);
  if (await win.webContents.executeJavaScript("document.querySelector('.history-modal') !== null")) throw new Error('History thumbnail still opened a separate window overlay');
  const thirdImage = await sharp(image).tint('#ffe4d9').jpeg({ quality: 90 }).toBuffer(); const thirdUpload = await call(receiver, 'PUT', `/photos/${randomUUID()}`, thirdImage, photoHeaders(pair.body.credential, thirdImage));
  if (thirdUpload.status !== 201) throw new Error(`Third smoke upload failed: ${JSON.stringify(thirdUpload)}`);
  await waitFor(win, `document.querySelector('.viewer img')?.src.endsWith('${thirdUpload.body.id}') && document.querySelectorAll('.thumbnail').length === 3`);
  await win.webContents.capturePage().then(image => writeFile('test-results/windows-photo.png', image.toPNG())).catch(error => writeFile('test-results/visual-capture-warning.txt', String(error)));
  const bounds = await win.webContents.executeJavaScript("(() => { const r = document.querySelector('.viewer').getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), width: document.querySelector('.viewer img').width }; })()");
  win.webContents.sendInputEvent({ type: 'mouseWheel', x: bounds.x, y: bounds.y, deltaY: 180, deltaX: 0 });
  await waitFor(win, "document.querySelector('.viewer img').width !== " + bounds.width);
  await win.webContents.executeJavaScript("[...document.querySelectorAll('button')].find(b => b.textContent === '100%').click()");
  await waitFor(win, "document.querySelector('.viewer img').width === 1200");
  const before = await win.webContents.executeJavaScript("document.querySelector('.viewer img').style.left");
  win.webContents.sendInputEvent({ type: 'mouseDown', x: bounds.x, y: bounds.y, button: 'left', clickCount: 1 });
  win.webContents.sendInputEvent({ type: 'mouseMove', x: bounds.x + 40, y: bounds.y + 20 });
  win.webContents.sendInputEvent({ type: 'mouseUp', x: bounds.x + 40, y: bounds.y + 20, button: 'left', clickCount: 1 });
  await waitFor(win, "document.querySelector('.viewer img').style.left !== " + JSON.stringify(before));
  await win.webContents.executeJavaScript(`document.querySelector('.viewer').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: ${bounds.x}, clientY: ${bounds.y} }))`);
  await waitFor(win, "(() => { const viewer = document.querySelector('.viewer').getBoundingClientRect(); const mask = document.querySelector('.crop-mask')?.getBoundingClientRect(); return document.querySelector('.cropping') !== null && mask && Math.abs(mask.width - viewer.width) < 1 && Math.abs(mask.height - viewer.height) < 1 && getComputedStyle(document.querySelector('.crop-mask')).backgroundColor !== 'rgba(0, 0, 0, 0)'; })()");
  await win.webContents.executeJavaScript(`document.querySelector('.viewer').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: ${bounds.x}, clientY: ${bounds.y} }))`);
  await waitFor(win, "document.querySelector('.cropping') === null && document.querySelector('.crop-mask') === null");
  await win.webContents.executeJavaScript(`document.querySelector('.viewer').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: ${bounds.x}, clientY: ${bounds.y} }))`);
  await waitFor(win, "document.querySelector('.cropping') !== null && document.querySelector('.crop-mask') !== null");
  win.webContents.sendInputEvent({ type: 'mouseDown', x: bounds.x, y: bounds.y, button: 'left', clickCount: 1 });
  await waitFor(win, "document.querySelector('.crop-mask') === null && document.querySelector('.crop-region') !== null");
  win.webContents.sendInputEvent({ type: 'mouseMove', x: bounds.x + 80, y: bounds.y + 60 });
  win.webContents.sendInputEvent({ type: 'mouseUp', x: bounds.x + 80, y: bounds.y + 60, button: 'left', clickCount: 1 });
  await waitFor(win, "document.querySelector('.crop-region')?.clientWidth > 0 && document.querySelectorAll('.crop-handle').length === 4 && getComputedStyle(document.querySelector('.crop-region')).cursor === 'pointer'");
  const cropBeforeResize = await win.webContents.executeJavaScript("(() => { const r = document.querySelector('.crop-region').getBoundingClientRect(); return { right: Math.round(r.right), bottom: Math.round(r.bottom), width: r.width, height: r.height, cursor: getComputedStyle(document.querySelector('.crop-handle.se')).cursor }; })()");
  if (cropBeforeResize.cursor !== 'nwse-resize') throw new Error('Southeast crop handle has wrong cursor');
  win.webContents.sendInputEvent({ type: 'mouseDown', x: cropBeforeResize.right - 1, y: cropBeforeResize.bottom - 1, button: 'left', clickCount: 1 });
  win.webContents.sendInputEvent({ type: 'mouseMove', x: cropBeforeResize.right + 29, y: cropBeforeResize.bottom + 19 });
  win.webContents.sendInputEvent({ type: 'mouseUp', x: cropBeforeResize.right + 29, y: cropBeforeResize.bottom + 19, button: 'left', clickCount: 1 });
  await waitFor(win, "document.querySelector('.crop-region').getBoundingClientRect().width > " + cropBeforeResize.width + " && document.querySelector('.crop-region').getBoundingClientRect().height > " + cropBeforeResize.height);
  const cropBeforeMove = await win.webContents.executeJavaScript("({ left: document.querySelector('.crop-region').style.left, top: document.querySelector('.crop-region').style.top, imageLeft: document.querySelector('.viewer img').style.left })");
  win.webContents.sendInputEvent({ type: 'mouseDown', x: bounds.x + 40, y: bounds.y + 30, button: 'left', clickCount: 1 });
  await waitFor(win, "getComputedStyle(document.querySelector('.crop-region')).cursor === 'grabbing' && getComputedStyle(document.querySelector('.interactive-viewer')).cursor === 'grabbing'");
  win.webContents.sendInputEvent({ type: 'mouseMove', x: bounds.x + 70, y: bounds.y + 50 });
  await waitFor(win, "getComputedStyle(document.querySelector('.interactive-viewer')).cursor === 'grabbing'");
  win.webContents.sendInputEvent({ type: 'mouseUp', x: bounds.x + 70, y: bounds.y + 50, button: 'left', clickCount: 1 });
  await waitFor(win, "document.querySelector('.crop-region').style.left !== " + JSON.stringify(cropBeforeMove.left) + " && document.querySelector('.crop-region').style.top !== " + JSON.stringify(cropBeforeMove.top));
  await waitFor(win, "getComputedStyle(document.querySelector('.crop-region')).cursor === 'pointer'");
  const imageAfterMove = await win.webContents.executeJavaScript("document.querySelector('.viewer img').style.left");
  if (imageAfterMove !== cropBeforeMove.imageLeft) throw new Error('Moving crop region moved photo content');
  await win.webContents.executeJavaScript(`document.querySelector('.crop-region').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: ${bounds.x + 70}, clientY: ${bounds.y + 50} }))`);
  await waitFor(win, "document.querySelector('.cropping') === null && document.querySelector('.crop-region') === null");
  await win.webContents.executeJavaScript(`document.querySelector('.viewer').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: ${bounds.x}, clientY: ${bounds.y} }))`);
  win.webContents.sendInputEvent({ type: 'mouseDown', x: bounds.x, y: bounds.y, button: 'left', clickCount: 1 });
  win.webContents.sendInputEvent({ type: 'mouseMove', x: bounds.x + 80, y: bounds.y + 60 });
  win.webContents.sendInputEvent({ type: 'mouseUp', x: bounds.x + 80, y: bounds.y + 60, button: 'left', clickCount: 1 });
  await waitFor(win, "document.querySelector('.crop-region')?.clientWidth > 0");
  const previousClipboard = await clipboard.read();
  win.webContents.sendInputEvent({ type: 'mouseDown', x: bounds.x + 40, y: bounds.y + 30, button: 'left', clickCount: 2 });
  win.webContents.sendInputEvent({ type: 'mouseUp', x: bounds.x + 40, y: bounds.y + 30, button: 'left', clickCount: 2 });
  await waitFor(win, "document.body.innerText.includes('截图已复制到剪贴板')");
  await waitFor(win, "document.querySelector('.cropping') === null && document.querySelector('.crop-region') === null");
  const clipboardItems = await clipboard.read();
  const clipboardImage = clipboardItems.find(item => item.types.includes('image/png'));
  if (!clipboardImage) throw new Error('Clipboard has no PNG image');
  const copied = await sharp(Buffer.from(await ((await clipboardImage.getType('image/png')) as Blob).arrayBuffer())).metadata();
  if (!copied.width || !copied.height || copied.width < 80 || copied.width > 81 || copied.height < 60 || copied.height > 61) throw new Error('Clipboard crop dimensions mismatch: ' + JSON.stringify(copied));
  const restorableClipboard = previousClipboard.filter(item => item.types.length > 0);
  if (restorableClipboard.length) {
    const restored = await Promise.all(restorableClipboard.map(async item => new ClipboardItem(Object.fromEntries(await Promise.all(item.types.map(async type => [type, await item.getType(type)]))))));
    await clipboard.write(restored);
  } else clipboard.clear();
  await win.webContents.executeJavaScript(`document.querySelector('.viewer').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: ${bounds.x}, clientY: ${bounds.y} }))`);
  win.webContents.sendInputEvent({ type: 'mouseDown', x: bounds.x, y: bounds.y, button: 'left', clickCount: 1 });
  win.webContents.sendInputEvent({ type: 'mouseMove', x: bounds.x + 80, y: bounds.y + 60 });
  win.webContents.sendInputEvent({ type: 'mouseUp', x: bounds.x + 80, y: bounds.y + 60, button: 'left', clickCount: 1 });
  await waitFor(win, "document.querySelector('.crop-region')?.clientWidth > 0");
  const originalDialog = dialog.showSaveDialog; const output = path.resolve('test-results/cropped-photo.png');
  try {
    dialog.showSaveDialog = (async () => ({ canceled: false, filePath: output })) as typeof dialog.showSaveDialog;
    await win.webContents.executeJavaScript("document.querySelector('button[aria-label=\"保存 PNG\"]').click()");
    await waitFor(win, "document.body.innerText.includes('截图已保存：')");
  } finally { dialog.showSaveDialog = originalDialog; }
  const cropInfo = await sharp(await readFile(output)).metadata();
  if (!cropInfo.width || !cropInfo.height || cropInfo.width < 80 || cropInfo.width > 81 || cropInfo.height < 60 || cropInfo.height > 61) throw new Error('Screenshot coordinates mismatch: ' + JSON.stringify(cropInfo));
  await win.webContents.capturePage().then(image => writeFile('test-results/windows-viewer.png', image.toPNG())).catch(error => writeFile('test-results/visual-capture-warning.txt', String(error)));
  const details = await win.webContents.executeJavaScript("({ title: document.title, previewWidth: document.querySelector('.viewer img').naturalWidth, thumbnails: document.querySelectorAll('.thumbnail').length, nodeExposed: typeof window.require !== 'undefined' })");
  await win.webContents.executeJavaScript("[...document.querySelectorAll('button')].find(b => b.textContent === '多选删除').click()");
  await waitFor(win, "document.querySelector('.selection-mark') !== null");
  await win.webContents.executeJavaScript("document.querySelector('.thumbnail').click()");
  await waitFor(win, "document.body.innerText.includes('已选 1 张') && document.querySelector('.thumbnail').getAttribute('aria-pressed') === 'true'");
  await receiver.deletePhotos([upload.body.id, secondUpload.body.id, thirdUpload.body.id]);
  await waitFor(win, "document.querySelectorAll('.thumbnail').length === 0 && document.querySelector('.viewer img') === null");
  const fileId = randomUUID(); const payload = Buffer.from('MobileVision 文件传输 smoke'); const auth = { Authorization: `Bearer ${pair.body.credential}` };
  const metadata = Buffer.from(JSON.stringify({ name: '文档.txt', bytes: payload.length, sha256: createHash('sha256').update(payload).digest('hex') }));
  await call(receiver, 'POST', `/files/${fileId}`, metadata, auth);
  await call(receiver, 'PUT', `/files/${fileId}/chunk`, payload, { ...auth, 'X-File-Offset': '0' });
  const fileResult = await call(receiver, 'POST', `/files/${fileId}/complete`, Buffer.alloc(0), auth); if (fileResult.body.state !== 'ready') throw new Error('File smoke upload failed');
  await win.webContents.executeJavaScript("[...document.querySelectorAll('.content-tabs button')].find(b => b.textContent === '文件').click()");
  await waitFor(win, "document.querySelector('.file-row strong')?.textContent === '文档.txt' && !document.querySelector('.file-row button').disabled && document.querySelector('.viewer') === null");
  const desktopFile = path.resolve('test-results/to-phone.bin'); await writeFile(desktopFile, payload);
  const originalOpenDialog = dialog.showOpenDialog;
  try {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [desktopFile] })) as typeof dialog.showOpenDialog;
    await win.webContents.executeJavaScript("[...document.querySelectorAll('.files-card button')].find(b => b.textContent === '选择文件发送到手机').click()");
    await waitFor(win, "document.querySelectorAll('.file-row').length === 2 && document.body.innerText.includes('电脑 → 手机')");
  } finally { dialog.showOpenDialog = originalOpenDialog; }
  const download = (await call(receiver, 'GET', '/downloads', undefined, auth)).body.files[0]; if (!download || download.name !== 'to-phone.bin') throw new Error('Desktop file picker queue failed');
  if (!Buffer.from((await call(receiver, 'GET', `/downloads/${download.id}/chunk?offset=0`, undefined, auth)).body.data, 'base64').equals(payload)) throw new Error('Download bytes mismatch');
  await call(receiver, 'POST', `/downloads/${download.id}/ack`, Buffer.from(JSON.stringify({ offset: payload.length, complete: true, canceled: false, sha256: createHash('sha256').update(payload).digest('hex') })), auth);
  await waitFor(win, "[...document.querySelectorAll('.file-row button')].every(b => !b.disabled)");
  const droppedFile = path.resolve('test-results/拖入文件.bin'); const secondDrop = path.resolve('test-results/drop-second.bin'); await writeFile(droppedFile, payload); await writeFile(secondDrop, payload);
  win.webContents.debugger.attach('1.3');
  try {
    await win.webContents.executeJavaScript("(() => { const input = document.createElement('input'); input.type = 'file'; input.multiple = true; input.id = 'smoke-drop-input'; input.hidden = true; document.body.appendChild(input); })()");
    const doc = await win.webContents.debugger.sendCommand('DOM.getDocument'); const node = await win.webContents.debugger.sendCommand('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#smoke-drop-input' });
    await win.webContents.debugger.sendCommand('DOM.setFileInputFiles', { nodeId: node.nodeId, files: [droppedFile, secondDrop] });
    await win.webContents.executeJavaScript("(() => { const data = new DataTransfer(); for (const file of document.querySelector('#smoke-drop-input').files) data.items.add(file); document.querySelector('.file-dropzone').dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data })); })()");
    await waitFor(win, "document.querySelectorAll('.file-row').length === 4 && document.body.innerText.includes('拖入文件.bin')");
  } finally { await win.webContents.executeJavaScript("document.querySelector('#smoke-drop-input')?.remove()"); win.webContents.debugger.detach(); }
  const pastedFile = path.resolve("test-results/paste-文档's.bin"); const secondPaste = path.resolve("test-results/paste-second.bin"); await writeFile(pastedFile, payload); await writeFile(secondPaste, payload);
  const setFileClipboard = "Add-Type -AssemblyName System.Windows.Forms; $items = [System.Collections.Specialized.StringCollection]::new(); $paths = ConvertFrom-Json $env:MOBILEVISION_CLIPBOARD_TEST_FILES; foreach ($item in $paths) { [void]$items.Add([string]$item) }; [System.Windows.Forms.Clipboard]::SetFileDropList($items)";
  await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-WindowStyle', 'Hidden', '-Command', setFileClipboard], { windowsHide: true, timeout: 10000, env: { ...process.env, MOBILEVISION_CLIPBOARD_TEST_FILES: JSON.stringify([pastedFile, secondPaste]) } });
  win.showInactive();
  await win.webContents.executeJavaScript("document.querySelector('.file-dropzone').focus()");
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'V', modifiers: ['control'] }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'V', modifiers: ['control'] });
  await waitFor(win, `document.querySelectorAll('.file-row').length === 6 && document.body.innerText.includes("paste-文档's.bin")`);
  const pendingDownloads = receiver.outgoing.list().filter(f => f.state === 'pending'); if (pendingDownloads.length !== 4) throw new Error('Drop or paste created duplicate tasks');
  for (const pending of pendingDownloads) { const bytes = (await call(receiver, 'GET', `/downloads/${pending.id}/chunk?offset=0`, undefined, auth)).body.data; if (!Buffer.from(bytes, 'base64').equals(payload)) throw new Error('File ingress changed bytes'); }
  await clipboard.writeText('纯文字'); await win.webContents.executeJavaScript("[...document.querySelectorAll('.file-dropzone button')].find(b => b.textContent === '粘贴文件').click()");
  await waitFor(win, "document.body.innerText.includes('剪贴板里是文字')");
  if (receiver.outgoing.list().length !== 5) throw new Error('Text clipboard incorrectly queued a file');
  await win.webContents.executeJavaScript("[...document.querySelectorAll('.alert button')].find(b => b.textContent === '知道了').click()");
  await new Promise(resolve => setTimeout(resolve, 500));
  await writeFile('test-results/windows-files.png', (await win.webContents.capturePage()).toPNG());
  await win.webContents.executeJavaScript("[...document.querySelectorAll('.content-tabs button')].find(b => b.textContent === '照片').click()");
  await waitFor(win, "document.querySelector('.viewer') !== null && document.querySelector('.files-card') === null");
  const messageId = randomUUID(); const text = '测试消息\n  保留空格与换行 😀';
  const messageResult = await call(receiver, 'POST', `/messages/${messageId}`, Buffer.from(JSON.stringify({ text, copy: true })), auth);
  if (messageResult.body.state !== 'delivered' || await clipboard.readText() !== text) throw new Error('Text receive/copy failed');
  await win.webContents.executeJavaScript("[...document.querySelectorAll('.content-tabs button')].find(b => b.textContent === '文本').click()");
  await waitFor(win, "document.querySelector('.message pre')?.textContent.includes('测试消息')");
  await win.webContents.executeJavaScript("(() => { const e = document.querySelector('textarea'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(e, '电脑发送\\n第二行'); e.dispatchEvent(new Event('input', { bubbles: true })); })()");
  await waitFor(win, "!document.querySelector('.text-card .button-row button').disabled");
  await win.webContents.executeJavaScript("document.querySelector('textarea').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }))");
  await waitFor(win, "document.querySelectorAll('.message').length === 2 && document.querySelector('textarea').value === ''");
  const outgoing = await call(receiver, 'GET', '/messages', undefined, auth); if (outgoing.body.messages[0]?.text !== '电脑发送\n第二行') throw new Error('Text UI send failed');
  await call(receiver, 'POST', `/messages/${outgoing.body.messages[0].id}/ack`, Buffer.alloc(0), auth);
  await waitFor(win, "[...document.querySelectorAll('.message .muted')].every(e => e.textContent.includes('已送达'))");
  await new Promise(resolve => setTimeout(resolve, 500)); await writeFile('test-results/windows-text.png', (await win.webContents.capturePage()).toPNG());
  if (details.nodeExposed) throw new Error('Node exposed in renderer');
  await writeFile('test-results/smoke.json', JSON.stringify({ passed: true, versions: process.versions, details }, null, 2));
}
