import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Receiver } from '../src/main/receiver';

test('real WiFi phone cancels power requests and sends screen off immediately', { skip: !process.env.MOBILEVISION_POWER_TEST_DEVICE, timeout: 180_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mobilevision-power-device-'));
  let executions = 0;
  // No real OS power calls are possible, even if cancellation or the device fails.
  const receiver = new Receiver(path.join(root, 'state'), path.join(root, 'photos'), '0.0.0.0', path.join(root, 'files'), async () => { executions++; });
  try {
    await receiver.initialize(); receiver.power.setEnabled(true);
    const host = process.env.MOBILEVISION_POWER_TEST_HOST;
    assert.ok(host, 'Specify the computer LAN address to test actual WiFi without adb reverse');
    const pairing = Buffer.from(JSON.stringify(receiver.pairing(host))).toString('base64');
    const { stdout } = await promisify(execFile)('D:/Software/AndroidSDK/platform-tools/adb.exe', ['-s', process.env.MOBILEVISION_POWER_TEST_DEVICE!, 'shell', 'am', 'instrument', '-w', '-e', 'pairing', pairing, '-e', 'class', 'com.mobilevision.android.PowerControlTest', 'com.mobilevision.android.test/androidx.test.runner.AndroidJUnitRunner'], { timeout: 150_000, windowsHide: true, maxBuffer: 2 * 1024 ** 2 });
    await mkdir('test-results', { recursive: true }); await writeFile('test-results/power-device.txt', stdout);
    assert.ok(stdout.includes('OK (2 tests)') && !stdout.includes('FAILURES!!!'), stdout);
    assert.equal(executions, 2); assert.equal(receiver.power.status().job?.action, 'screenOn'); assert.equal(receiver.power.status().job?.state, 'submitted'); assert.equal(receiver.power.status().displayOff, false);
  } finally { await receiver.close(); assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)); await rm(root, { recursive: true, force: true }); }
});
