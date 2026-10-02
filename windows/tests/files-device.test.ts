import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Receiver } from '../src/main/receiver';

test('Android and Windows exchange files, resume and save into Android Downloads without overwriting', { skip: !process.env.MOBILEVISION_FILE_TEST_DEVICE, timeout: 180_000 }, async () => {
  const adb = 'D:/Software/AndroidSDK/platform-tools/adb.exe'; const serial = process.env.MOBILEVISION_FILE_TEST_DEVICE!;
  const execute = promisify(execFile); const run = async (args: string[]) => (await execute(adb, ['-s', serial, ...args], { timeout: 150_000, windowsHide: true, maxBuffer: 2 * 1024 ** 2 })).stdout;
  const root = await mkdtemp(path.join(os.tmpdir(), 'mobilevision-file-device-')); const receiver = new Receiver(path.join(root, 'state'), path.join(root, 'photos'), '127.0.0.1');
  let seedPromise: Promise<string> | undefined;
  try {
    const payload = Buffer.alloc(4 * 1024 ** 2 + 137); for (let i = 0; i < payload.length; i++) payload[i] = i % 251;
    const source = path.join(root, 'MobileVision-device-test-' + Date.now() + '.bin'); await writeFile(source, payload);
    await receiver.initialize();
    receiver.on('change', () => { const device = receiver.deviceIdentity(); if (device && !seedPromise) { seedPromise = Promise.resolve().then(() => receiver.outgoing.add(device, source)); } }); await run(['reverse', `tcp:${receiver.port}`, `tcp:${receiver.port}`]);
    const pairing = Buffer.from(JSON.stringify(receiver.pairing('127.0.0.1'))).toString('base64');
    const result = await run(['shell', 'am', 'instrument', '-w', '-e', 'pairing', pairing, '-e', 'class', 'com.mobilevision.android.FileTransferTest', 'com.mobilevision.android.test/androidx.test.runner.AndroidJUnitRunner']);
    await mkdir('test-results', { recursive: true }); await writeFile('test-results/file-device.txt', result);
    assert.ok(result.includes('OK (1 test)') && !result.includes('FAILURES!!!'), result);
    const sent = receiver.outgoing.list(); assert.equal(sent.length, 1); assert.equal(sent[0].state, 'sent');
    const ready = receiver.files.list().filter(f => f.state === 'ready'); assert.equal(ready.length, 1);
    const received = await readFile(receiver.files.filePath(ready[0].id)!); assert.equal(received.length, 4 * 1024 ** 2 + 137);
    for (let i = 0; i < received.length; i++) assert.equal(received[i], i % 251);
  } finally { await run(['reverse', '--remove', `tcp:${receiver.port}`]).catch(() => {}); await receiver.close(); assert.ok(root.startsWith(os.tmpdir() + path.sep)); await rm(root, { recursive: true, force: true }); }
});
