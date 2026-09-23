import { createServer, request } from 'node:https';
import { randomBytes, createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import type { BrowserWindow } from 'electron';
import type { Receiver } from './receiver';

const execute = promisify(execFile);
const adb = 'D:/Software/AndroidSDK/platform-tools/adb.exe';
const serial = 'emulator-5554';
async function runAdb(args: string[]) { return (await execute(adb, ['-s', serial, ...args], { timeout: 240_000, maxBuffer: 2 * 1024 * 1024, windowsHide: true })).stdout; }

// Isolated, opt-in integration fixture. Never started by the normal desktop app.
export async function runAndroidE2E(receiver: Receiver, win: BrowserWindow) {
  const directory = path.resolve('test-results/android-e2e'); await mkdir(directory, { recursive: true });
  await rm('test-results/smoke-error.txt', { force: true });
  const tls = JSON.parse(await readFile(path.join(receiver.dataDirectory, 'tls.json'), 'utf8'));
  let offline = false; let droppedPairingResponse = false; const controlKey = randomBytes(24).toString('hex');
  const proxy = createServer({ key: tls.private, cert: tls.cert }, (req, res) => {
    if (req.url === '/test/control' && req.headers['x-test-key'] === controlKey) {
      let body = ''; req.on('data', chunk => { body += chunk; }); req.on('end', () => { offline = body === 'offline'; res.writeHead(200); res.end('ok'); }); return;
    }
    if (offline) { req.resume(); res.writeHead(503, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { code: 'STOPPING' } })); return; }
    const upstream = request({ host: '127.0.0.1', port: receiver.port, method: req.method, path: req.url, headers: req.headers, ca: receiver.certificate, checkServerIdentity: (_host, cert) => createHash('sha256').update(cert.raw).digest('hex') === receiver.fingerprint ? undefined : new Error('Pin mismatch') }, response => { if (req.url === '/api/v1/pair' && response.statusCode === 201 && !droppedPairingResponse) { droppedPairingResponse = true; response.resume(); res.destroy(); return; } res.writeHead(response.statusCode || 502, response.headers); response.pipe(res); });
    upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); }); req.pipe(upstream);
  });
  await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
  try {
    const address = proxy.address() as { port: number };
    const pairing = { ...receiver.pairing('10.0.2.2'), address: 'https://10.0.2.2:' + address.port };
    const config = Buffer.from(JSON.stringify({ pairing, controlKey, reconnect: { ...receiver.pairing("10.0.2.2"), token: "", expiresAt: 0 } })).toString('base64');
    if (!(await runAdb(['shell', 'getprop', 'ro.kernel.qemu'])).includes('1')) throw new Error('Tests require an emulator');
    // Only the designated emulator app's synthetic test data is reset.
    await runAdb(['shell', 'pm', 'clear', 'com.mobilevision.android']);
    for (const method of ['captureAndQueueOffline', 'resumeAfterProcessRestart']) {
      if (method === 'resumeAfterProcessRestart') { await runAdb(['shell', 'am', 'force-stop', 'com.mobilevision.android']); offline = false; }
      const output = await runAdb(['shell', 'am', 'instrument', '-w', '-e', 'config', config, '-e', 'class', 'com.mobilevision.android.EndToEndTest#' + method, 'com.mobilevision.android.test/androidx.test.runner.AndroidJUnitRunner']);
      await writeFile(path.join(directory, method + '.txt'), output);
      if (!output.includes('OK (1 test)') || output.includes('FAILURES!!!')) throw new Error('Android test failed: ' + method + '\n' + output);
    }
    if (!droppedPairingResponse) throw new Error('Pairing response loss was not exercised');
    const report = JSON.parse(await runAdb(['shell', 'run-as', 'com.mobilevision.android', 'cat', 'files/e2e-report.json']));
    const photos = receiver.photos();
    if (photos.length !== 2) throw new Error('Expected 2 saved photos after duplicate retry, got ' + photos.length);
    for (const photo of report) {
      const found = photos.find(p => p.photoId === photo.id); if (!found) throw new Error('Missing uploaded photo');
      const bytes = await readFile(receiver.photoPath(found.id)!);
      if (bytes.length !== photo.bytes || createHash('sha256').update(bytes).digest('hex') !== photo.hash) throw new Error('Original image mismatch');
    }
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await win.webContents.executeJavaScript("document.querySelectorAll('.thumbnail').length === 2 && document.querySelector('.viewer img')?.naturalWidth > 0")) break;
      await new Promise(resolve => setTimeout(resolve, 100));
      if (attempt === 99) throw new Error('Windows photo preview not updated');
    }
    await writeFile(path.join(directory, 'windows-received.png'), (await win.webContents.capturePage()).toPNG());
    await runAdb(['shell', 'am', 'start', '-W', '-n', 'com.mobilevision.android/.MainActivity']);
    await new Promise(resolve => setTimeout(resolve, 2000));
    await runAdb(['shell', 'screencap', '-p', '/sdcard/mobilevision-e2e.png']);
    await runAdb(['pull', '/sdcard/mobilevision-e2e.png', path.join(directory, 'android-screen.png')]);
    await writeFile(path.join(directory, 'report.json'), JSON.stringify({ passed: true, emulator: serial, photos: report, checks: ['pairing response loss recovered', 'address change preserves credential', 'different computer and pin rejected', 'fixed shutter and history navigation', 'QR decoder normal and rotated', 'wrong TLS pin rejected', 'UI pairing', 'CameraX real emulator capture', 'offline queue retained', 'process restart resumes upload', 'duplicate upload deduplicated', 'original SHA256 matches', 'Windows preview updated'] }, null, 2));
  } finally { proxy.closeAllConnections(); await new Promise<void>(resolve => proxy.close(() => resolve())); }
}
