import { request } from 'node:https';
import { createHash, randomUUID, X509Certificate } from 'node:crypto';
import { mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { clipboard, ClipboardItem, dialog, type BrowserWindow } from 'electron';
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
  await receiver.deletePhotos([upload.body.id]);
  await waitFor(win, "document.querySelectorAll('.thumbnail').length === 0 && document.querySelector('.viewer img') === null");
  if (details.nodeExposed) throw new Error('Node exposed in renderer');
  await writeFile('test-results/smoke.json', JSON.stringify({ passed: true, versions: process.versions, details }, null, 2));
}
