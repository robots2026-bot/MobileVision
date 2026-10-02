import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Receiver } from '../src/main/receiver';

test('Android and Windows exchange persistent Unicode text with acknowledgement and deduplication', { skip: !process.env.MOBILEVISION_TEXT_TEST_DEVICE, timeout: 180_000 }, async () => {
  const serial = process.env.MOBILEVISION_TEXT_TEST_DEVICE!; const execute = promisify(execFile);
  const run = async (args: string[]) => (await execute('D:/Software/AndroidSDK/platform-tools/adb.exe', ['-s', serial, ...args], { timeout: 150_000, windowsHide: true, maxBuffer: 2 * 1024 ** 2 })).stdout;
  const root = await mkdtemp(path.join(os.tmpdir(), 'mobilevision-text-device-')); const receiver = new Receiver(path.join(root, 'state'), path.join(root, 'photos'), '127.0.0.1');
  let copied = 0; let seeded = false;
  try {
    await receiver.initialize(); receiver.on('copy-text', () => copied++);
    receiver.on('change', () => { const device = receiver.deviceIdentity(); if (device && !seeded) { seeded = true; receiver.messages.send(device, '电脑文本\n  双向验证😀'); } });
    await run(['reverse', `tcp:${receiver.port}`, `tcp:${receiver.port}`]);
    const pairing = Buffer.from(JSON.stringify(receiver.pairing('127.0.0.1'))).toString('base64');
    const result = await run(['shell', 'am', 'instrument', '-w', '-e', 'pairing', pairing, '-e', 'class', 'com.mobilevision.android.TextTransferTest', 'com.mobilevision.android.test/androidx.test.runner.AndroidJUnitRunner']);
    await mkdir('test-results', { recursive: true }); await writeFile('test-results/text-device.txt', result);
    assert.ok(result.includes('OK (1 test)') && !result.includes('FAILURES!!!'), result);
    const rows = receiver.messages.list(); assert.equal(rows.length, 2); assert.ok(rows.every(m => m.state === 'delivered')); assert.equal(copied, 1);
    assert.equal(rows.find(m => m.source === 'phone')!.text, '手机文本\n  保留缩进\t😀 https://example.com');
  } finally { await run(['reverse', '--remove', `tcp:${receiver.port}`]).catch(() => {}); await receiver.close(); assert.ok(root.startsWith(os.tmpdir() + path.sep)); await rm(root, { recursive: true, force: true }); }
});
