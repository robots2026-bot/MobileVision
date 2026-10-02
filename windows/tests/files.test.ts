import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Receiver } from '../src/main/receiver';
import { call } from '../src/main/smoke';
import { FILE_LIMIT, CHUNK_SIZE } from '../src/main/files';

test('file queue: authenticated chunks, restart resume, lost acknowledgements, collisions, checksum and cancellation', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mobilevision-files-'));
  let receiver = new Receiver(path.join(root, 'state'), path.join(root, 'photos'), '127.0.0.1', path.join(root, 'downloads'));
  try {
    await receiver.initialize();
    const paired = await call(receiver, 'POST', '/pair', Buffer.from(JSON.stringify({ token: receiver.pairing('127.0.0.1').token, deviceId: randomUUID(), deviceName: 'Files test' })));
    const auth = { Authorization: `Bearer ${paired.body.credential}` };
    const payload = Buffer.alloc(CHUNK_SIZE + 137, 42); const id = randomUUID();
    const metadata = (name = '测试文档.zip', bytes = payload, size = bytes.length) => Buffer.from(JSON.stringify({ name, bytes: size, sha256: createHash('sha256').update(bytes).digest('hex') }));
    assert.equal((await call(receiver, 'POST', `/files/${id}`, metadata())).status, 401);
    assert.equal((await call(receiver, 'POST', `/files/${id}`, metadata(), auth)).body.offset, 0);
    assert.equal((await call(receiver, 'POST', `/files/${id}`, metadata('too-big', payload, FILE_LIMIT + 1), auth)).status, 400);
    assert.equal((await call(receiver, 'POST', `/files/${id}/complete`, Buffer.alloc(0), auth)).body.error.code, 'FILE_INCOMPLETE');
    const chunk = (offset: number, bytes: Buffer) => call(receiver, 'PUT', `/files/${id}/chunk`, bytes, { ...auth, 'X-File-Offset': String(offset) });
    assert.equal((await chunk(1, payload.subarray(0, 4))).body.error.code, 'FILE_OFFSET_MISMATCH');
    const first = await chunk(0, payload.subarray(0, CHUNK_SIZE)); assert.equal(first.body.offset, CHUNK_SIZE, JSON.stringify(first));
    assert.equal((await chunk(0, payload.subarray(0, 4))).body.error.code, 'FILE_OFFSET_MISMATCH');
    // A lost response is reconciled by submitting the same metadata, even after restart.
    await receiver.close(); receiver = new Receiver(path.join(root, 'state'), path.join(root, 'photos'), '127.0.0.1', path.join(root, 'downloads')); await receiver.initialize();
    assert.equal((await call(receiver, 'POST', `/files/${id}`, metadata(), auth)).body.offset, CHUNK_SIZE);
    assert.equal((await chunk(CHUNK_SIZE, payload.subarray(CHUNK_SIZE))).body.offset, payload.length);
    assert.equal((await call(receiver, 'POST', `/files/${id}/complete`, Buffer.alloc(0), auth)).body.state, 'ready');
    assert.deepEqual(await readFile(receiver.files.filePath(id)!), payload);
    assert.equal((await call(receiver, 'POST', `/files/${id}/complete`, Buffer.alloc(0), auth)).body.state, 'ready');
    assert.equal(receiver.files.list().length, 1);
    assert.equal((await call(receiver, 'POST', `/files/${id}`, metadata('other'), auth)).body.error.code, 'FILE_CONFLICT');
    const next = randomUUID(); const small = Buffer.from('important original');
    await call(receiver, 'POST', `/files/${next}`, metadata('测试文档.zip', small), auth);
    await call(receiver, 'PUT', `/files/${next}/chunk`, small, { ...auth, 'X-File-Offset': '0' });
    assert.equal((await call(receiver, 'POST', `/files/${next}/complete`, Buffer.alloc(0), auth)).body.state, 'ready');
    assert.notEqual(receiver.files.filePath(id), receiver.files.filePath(next));
    assert.deepEqual(await readFile(receiver.files.filePath(id)!), payload);
    const corrupt = randomUUID(); await call(receiver, 'POST', `/files/${corrupt}`, metadata('checksum.txt', small), auth);
    await call(receiver, 'PUT', `/files/${corrupt}/chunk`, Buffer.alloc(small.length), { ...auth, 'X-File-Offset': '0' });
    assert.equal((await call(receiver, 'POST', `/files/${corrupt}/complete`, Buffer.alloc(0), auth)).body.error.code, 'CHECKSUM_MISMATCH');
    assert.equal((await call(receiver, 'GET', `/files/${corrupt}`, undefined, auth)).body.offset, 0);
    assert.equal((await call(receiver, 'DELETE', `/files/${corrupt}`, undefined, auth)).body.canceled, true);
    assert.equal((await call(receiver, 'GET', `/files/${corrupt}`, undefined, auth)).status, 404);
    const empty = randomUUID(); await call(receiver, 'POST', `/files/${empty}`, metadata('../CON', Buffer.alloc(0)), auth);
    assert.equal((await call(receiver, 'POST', `/files/${empty}/complete`, Buffer.alloc(0), auth)).body.state, 'ready');
    assert.equal((await stat(receiver.files.filePath(empty)!)).size, 0);
    assert.ok(receiver.files.filePath(empty)!.startsWith(path.join(root, 'downloads') + path.sep));
    const changed = path.join(root, 'other-downloads'); await receiver.files.setDirectory(changed);
    await receiver.close(); receiver = new Receiver(path.join(root, 'state'), path.join(root, 'photos'), '127.0.0.1'); await receiver.initialize();
    assert.equal(receiver.files.directory, changed); assert.equal(receiver.files.list().filter(f => f.state === 'ready').length, 3);
    receiver.revoke(); assert.equal((await call(receiver, 'GET', `/files/${id}`, undefined, auth)).status, 401);
  } finally { await receiver.close(); assert.ok(root.startsWith(os.tmpdir() + path.sep)); await rm(root, { recursive: true, force: true }); }
});
