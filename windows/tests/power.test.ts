import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { PowerControl, powerCommand } from '../src/main/power';
import { Receiver } from '../src/main/receiver';
import { call } from '../src/main/smoke';

test('display native wrapper compiles with correct INPUT layout without invoking power', { skip: process.platform !== 'win32' }, async () => {
  const [file, args] = powerCommand('screenOff');
  const script = args.at(-1)!;
  const compileOnly = script.slice(0, script.indexOf('; if (-not')) + "; if ($null -eq [MobileVisionDisplay].GetMethod('TurnOff') -or $null -eq [MobileVisionDisplay].GetMethod('TurnOn')) { exit 1 }; $size = [Runtime.InteropServices.Marshal]::SizeOf([type][MobileVisionDisplay+Input]); if ($size -ne $(if ([IntPtr]::Size -eq 8) { 40 } else { 28 })) { throw ('Invalid INPUT layout: ' + $size) }; $offset = [Runtime.InteropServices.Marshal]::OffsetOf([type][MobileVisionDisplay+Input], 'mouse').ToInt32(); if ($offset -ne [IntPtr]::Size) { throw ('Invalid mouse offset: ' + $offset) }";
  await promisify(execFile)(file, [...args.slice(0, -1), compileOnly], { windowsHide: true, timeout: 30_000 });
});

test('power commands do not force-close work and sleep uses the correct typed API', () => {
  for (const action of ['shutdown', 'restart'] as const) { const [, args] = powerCommand(action); assert.ok(!args.includes('/f')); assert.equal(args.at(-1), '0'); }
  assert.match(powerCommand('sleep')[1].at(-1)!, /PowerState\]::Suspend, \$false, \$false/);
  assert.match(powerCommand('hibernate')[1].at(-1)!, /PowerState\]::Hibernate/);
  assert.match(powerCommand('screenOff')[1].at(-1)!, /new UIntPtr\(0xF170u\)/);
  assert.ok(!powerCommand('screenOff')[1].at(-1)!.includes('SetSuspendState'));
});

test('screen off bypasses the countdown and duplicate requests execute only once', async () => {
  const calls: string[] = []; const control = new PowerControl(() => {}, async action => { calls.push(action); }, 15_000);
  try {
    control.setEnabled(true); const id = randomUUID(); const before = Date.now();
    const job = control.schedule(id, 'screenOff'); assert.ok(job.executeAt - before < 100);
    assert.equal(control.schedule(id, 'screenOff'), job);
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.deepEqual(calls, ['screenOff']); assert.equal(job.state, 'submitted');
    control.schedule(id, 'screenOff'); assert.deepEqual(calls, ['screenOff']);
  } finally { control.dispose(); }
});

test('shutdown, hibernate, sleep and restart default to five seconds', () => {
  const control = new PowerControl(() => {}, async () => { throw new Error('Should be canceled'); });
  try {
    control.setEnabled(true);
    for (const action of ['shutdown', 'hibernate', 'sleep', 'restart']) {
      const before = Date.now(); const job = control.schedule(randomUUID(), action);
      assert.ok(job.executeAt - before >= 5000 && job.executeAt - before < 5100);
      control.cancelPending();
    }
  } finally { control.dispose(); }
});

test('display toggle updates only after successful immediate commands and survives other jobs', async () => {
  const calls: string[] = [];
  const control = new PowerControl(() => {}, async action => { calls.push(action); });
  try {
    assert.equal(control.status().displayOff, false);
    const off = control.schedule(randomUUID(), 'screenOff');
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.equal(off.state, 'submitted'); assert.equal(control.status().displayOff, true);
    control.schedule(randomUUID(), 'sleep'); control.cancelPending();
    assert.equal(control.status().displayOff, true);
    const before = Date.now(); const on = control.schedule(randomUUID(), 'screenOn');
    assert.ok(on.executeAt - before < 100);
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.equal(control.status().displayOff, false); assert.deepEqual(calls, ['screenOff', 'screenOn']);
    assert.match(powerCommand('screenOn')[1].at(-1)!, /SendInput\(1, new Input\[\] \{ input \}, Marshal.SizeOf\(typeof\(Input\)\)\) == 1/);
  } finally { control.dispose(); }
  const failed = new PowerControl(() => {}, async () => { throw new Error('Display command denied'); });
  try { failed.schedule(randomUUID(), 'screenOff'); await new Promise(resolve => setTimeout(resolve, 40)); assert.equal(failed.status().displayOff, false); } finally { failed.dispose(); }
});

test('confirmation delay, deduplication, cancellation, disabling and errors use a fake executor', async () => {
  const calls: string[] = []; const control = new PowerControl(() => {}, async action => { calls.push(action); }, 25);
  const id = randomUUID();
  assert.equal(control.enabled, true);
  control.setEnabled(false);
  assert.throws(() => control.schedule(id, 'sleep'), /POWER_DISABLED/);
  control.setEnabled(true);
  const job = control.schedule(id, 'sleep');
  assert.equal(control.schedule(id, 'sleep'), job);
  assert.throws(() => control.schedule(id, 'restart'), /POWER_ID_CONFLICT/);
  assert.throws(() => control.schedule(randomUUID(), 'restart'), /POWER_BUSY/);
  control.cancelPending(); await new Promise(resolve => setTimeout(resolve, 50)); assert.deepEqual(calls, []);
  control.schedule(randomUUID(), 'hibernate'); control.setEnabled(false);
  await new Promise(resolve => setTimeout(resolve, 50)); assert.deepEqual(calls, []);
  control.setEnabled(true); control.schedule(randomUUID(), 'restart');
  await new Promise(resolve => setTimeout(resolve, 50)); assert.deepEqual(calls, ['restart']); assert.equal(control.status().job?.state, 'submitted');
  control.dispose();
  const failed = new PowerControl(() => {}, async () => { throw new Error('denied'); }, 1);
  failed.setEnabled(true); failed.schedule(randomUUID(), 'sleep'); await new Promise(resolve => setTimeout(resolve, 25)); assert.equal(failed.status().job?.state, 'failed'); failed.dispose();
});

test('HTTPS power endpoints require pairing, desktop permission and the expected computer; revoke cancels', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mobilevision-power-'));
  const receiver = new Receiver(path.join(root, 'state'), path.join(root, 'photos'), '127.0.0.1', path.join(root, 'files'), async () => { throw new Error('Real power calls are forbidden in tests'); });
  try {
    await receiver.initialize();
    assert.equal((await call(receiver, 'GET', '/power')).status, 401);
    const pairing = await call(receiver, 'POST', '/pair', Buffer.from(JSON.stringify({ token: receiver.pairing('127.0.0.1').token, deviceId: randomUUID(), deviceName: 'Power test' })));
    const auth = { Authorization: `Bearer ${pairing.body.credential}` };
    const body = { id: randomUUID(), action: 'sleep', computerId: receiver.computerId };
    const post = (value: object) => call(receiver, 'POST', '/power', Buffer.from(JSON.stringify(value)), auth);
    assert.equal(receiver.power.enabled, true);
    receiver.power.setEnabled(false);
    assert.equal((await post(body)).status, 403);
    receiver.power.setEnabled(true);
    assert.equal((await post({ ...body, computerId: randomUUID() })).status, 409);
    assert.equal((await post({ ...body, action: 'arbitrary-command' })).status, 400);
    assert.equal((await post(body)).status, 202);
    assert.equal((await post(body)).status, 202);
    assert.equal((await call(receiver, 'GET', '/power', undefined, auth)).body.job.state, 'pending');
    assert.equal((await call(receiver, 'DELETE', '/power', undefined, auth)).body.job.state, 'canceled');
    assert.equal((await post({ ...body, id: randomUUID() })).status, 202);
    receiver.revoke(); assert.equal(receiver.power.status().job?.state, 'canceled'); assert.equal(receiver.power.enabled, false);
    assert.equal((await call(receiver, 'GET', '/power', undefined, auth)).status, 401);
  } finally { await receiver.close(); assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)); await rm(root, { recursive: true, force: true }); }
});
