import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { Receiver } from '../src/main/receiver';
import { call } from '../src/main/smoke';
import { CHUNK_SIZE } from '../src/main/files';

test('desktop file snapshots, authenticated download chunks, restart, acknowledgements and cancellation', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mobilevision-outgoing-')); let receiver = new Receiver(path.join(root, 'state'), path.join(root, 'photos'), '127.0.0.1');
  try {
    await receiver.initialize(); const device = randomUUID();
    const pair = await call(receiver, 'POST', '/pair', Buffer.from(JSON.stringify({ token: receiver.pairing('127.0.0.1').token, deviceId: device, deviceName: 'Download test' })));
    const auth = { Authorization: `Bearer ${pair.body.credential}` }; const bytes = Buffer.alloc(CHUNK_SIZE + 91, 37); const original = path.join(root, '文档.zip'); await writeFile(original, bytes);
    await assert.rejects(receiver.outgoing.add(device, root), /文件夹/);
    const id = await receiver.outgoing.add(device, original); await writeFile(original, 'changed later');
    assert.equal((await call(receiver, 'GET', '/downloads')).status, 401);
    let metadata = (await call(receiver, 'GET', '/downloads', undefined, auth)).body.files[0]; assert.equal(metadata.bytes, bytes.length); assert.equal(metadata.sha256, createHash('sha256').update(bytes).digest('hex'));
    const first = await call(receiver, 'GET', `/downloads/${id}/chunk?offset=0`, undefined, auth); assert.deepEqual(Buffer.from(first.body.data, 'base64'), bytes.subarray(0, CHUNK_SIZE));
    const ack = (offset: number, complete = false, canceled = false, sha256 = metadata.sha256) => call(receiver, 'POST', `/downloads/${id}/ack`, Buffer.from(JSON.stringify({ offset, complete, canceled, sha256 })), auth);
    assert.equal((await ack(CHUNK_SIZE)).status, 200); assert.equal(receiver.outgoing.list()[0].offset, CHUNK_SIZE);
    assert.equal((await ack(bytes.length, true, false, '0'.repeat(64))).status, 400);
    await receiver.close(); receiver = new Receiver(path.join(root, 'state'), path.join(root, 'photos'), '127.0.0.1'); await receiver.initialize();
    metadata = (await call(receiver, 'GET', '/downloads', undefined, auth)).body.files[0]; assert.equal(metadata.id, id);
    assert.deepEqual(Buffer.from((await call(receiver, 'GET', `/downloads/${id}/chunk?offset=${CHUNK_SIZE}`, undefined, auth)).body.data, 'base64'), bytes.subarray(CHUNK_SIZE));
    assert.equal((await ack(bytes.length, true)).body.state, 'sent'); assert.equal((await ack(bytes.length, true)).body.state, 'sent'); assert.equal((await call(receiver, 'GET', '/downloads', undefined, auth)).body.files.length, 0);
    assert.equal(await stat(path.join(root, 'state', 'outgoing-files', id + '.bin')).then(() => true).catch(() => false), false);
    const next = await receiver.outgoing.add(device, original); await receiver.outgoing.cancel(next);
    assert.equal((await call(receiver, 'GET', `/downloads/${next}/chunk?offset=0`, undefined, auth)).body.error.code, 'DOWNLOAD_CANCELED');
    assert.equal((await call(receiver, 'GET', '/downloads', undefined, auth)).body.files.length, 0);
    const empty = path.join(root, 'empty'); await writeFile(empty, ''); const emptyId = await receiver.outgoing.add(device, empty);
    assert.equal((await call(receiver, 'POST', `/downloads/${emptyId}/ack`, Buffer.from(JSON.stringify({ offset: 0, complete: true, canceled: false, sha256: createHash('sha256').update('').digest('hex') })), auth)).body.state, 'sent');
    receiver.revoke(); assert.equal((await call(receiver, 'GET', '/downloads', undefined, auth)).status, 401);
  } finally { await receiver.close(); assert.ok(root.startsWith(os.tmpdir() + path.sep)); await rm(root, { recursive: true, force: true }); }
});
