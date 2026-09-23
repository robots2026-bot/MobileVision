import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, mkdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { Receiver } from '../src/main/receiver';
import { call, photoHeaders, samplePhoto } from '../src/main/smoke';

test('HTTPS pairing, authenticated upload, deduplication, validation, restart and revocation', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mobilevision-test-'));
  let receiver = new Receiver(path.join(root, 'state'), path.join(root, 'photos'), '127.0.0.1');
  try {
    await receiver.initialize();
    assert.equal((await call(receiver, 'GET', '/status')).status, 401);
    assert.equal((await call(receiver, 'POST', '/pair', Buffer.from(JSON.stringify({ token: 'wrong', deviceId: randomUUID(), deviceName: 'bad' })))).status, 401);
    const oldToken = receiver.pairing('127.0.0.1').token; receiver.refreshPairing();
    assert.equal((await call(receiver, 'POST', '/pair', Buffer.from(JSON.stringify({ token: oldToken, deviceId: randomUUID(), deviceName: 'old token' })))).status, 401);
    const pair = await call(receiver, 'POST', '/pair', Buffer.from(JSON.stringify({ token: receiver.pairing('127.0.0.1').token, deviceId: randomUUID(), deviceName: 'Android test' })));
    assert.equal(pair.status, 201); const credential = pair.body.credential;
    const auth = { Authorization: `Bearer ${credential}` };
    assert.equal((await call(receiver, 'GET', '/status', undefined, auth)).status, 200);
    assert.equal(receiver.pairing('127.0.0.1').token, '');
    const image = await samplePhoto(); const headers = photoHeaders(credential, image); const photoId = randomUUID();
    const upload = await call(receiver, 'PUT', `/photos/${photoId}`, image, headers);
    assert.equal(upload.status, 201, JSON.stringify(upload));
    assert.deepEqual(await readFile(receiver.photoPath(upload.body.id)!), image);
    assert.equal(receiver.photos()[0].width, 1200);
    const duplicate = await call(receiver, 'PUT', `/photos/${photoId}`, image, headers);
    assert.equal(duplicate.status, 200); assert.equal(duplicate.body.id, upload.body.id); assert.equal(receiver.photos().length, 1);
    assert.equal((await call(receiver, 'PUT', `/photos/${photoId}`, image, { ...headers, 'X-Content-Sha256': '0'.repeat(64) })).status, 409);
    assert.equal((await call(receiver, 'PUT', `/photos/${randomUUID()}`, image, { ...headers, 'X-Content-Sha256': '0'.repeat(64) })).body.error.code, 'CHECKSUM_MISMATCH');
    const invalid = Buffer.from('not an image');
    assert.equal((await call(receiver, 'PUT', `/photos/${randomUUID()}`, invalid, photoHeaders(credential, invalid))).body.error.code, 'INVALID_IMAGE');
    assert.equal((await call(receiver, 'PUT', `/photos/${randomUUID()}`, image, { ...headers, 'Content-Type': 'image/png' })).status, 415);
    for (let i = 0; i < 19; i++) assert.equal((await call(receiver, 'PUT', `/photos/${randomUUID()}`, image, headers)).status, 201);
    assert.equal(receiver.photos().length, 20);
    const nextFolder = path.join(root, 'new-photos'); await receiver.setDirectory(nextFolder);
    const next = await call(receiver, 'PUT', `/photos/${randomUUID()}`, image, headers); assert.equal(next.status, 201); assert.ok(receiver.photoPath(next.body.id)!.startsWith(nextFolder));
    const fingerprint = receiver.fingerprint; const rememberedPort = receiver.port;
    await receiver.close(); receiver = new Receiver(path.join(root, 'state'), path.join(root, 'photos'), '127.0.0.1'); await receiver.initialize();
    assert.equal(receiver.fingerprint, fingerprint); assert.equal(receiver.port, rememberedPort); assert.equal(receiver.photos().length, 21); assert.equal(receiver.directory, nextFolder);
    assert.equal((await call(receiver, 'GET', `/photos/${photoId}/status`, undefined, auth)).status, 200);
    assert.equal((await call(receiver, 'PUT', `/photos/${photoId}`, image, headers)).status, 200);
    await writeFile(receiver.photoPath(upload.body.id)!, 'externally changed');
    assert.equal((await call(receiver, 'PUT', `/photos/${photoId}`, image, headers)).body.error.code, 'SAVED_FILE_CHANGED');
    receiver.revoke(); assert.equal((await call(receiver, 'GET', '/status', undefined, auth)).status, 401);
  } finally { await receiver.close(); assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)); await rm(root, { recursive: true, force: true }); }
});


test('restart recovers verified pending files and rejects corrupt or incomplete files', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mobilevision-recovery-'));
  let receiver = new Receiver(path.join(root, 'state'), path.join(root, 'photos'), '127.0.0.1');
  try {
    await receiver.initialize(); await receiver.close();
    const db = new DatabaseSync(path.join(root, 'state', 'receiver.sqlite'));
    const image = await samplePhoto();
    const pending = [];
    for (const kind of ['valid', 'renamed', 'corrupt', 'incomplete']) {
      const id = randomUUID(); const filepath = path.join(root, 'photos', id + '.jpg'); const temporary = filepath + '.part';
      const content = kind === 'corrupt' ? Buffer.from('corrupt JPEG') : image;
      await writeFile(kind === 'renamed' ? filepath : temporary, kind === 'incomplete' ? content.subarray(0, 10) : content);
      db.prepare('INSERT INTO photos VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id, randomUUID(), randomUUID(), 'recovery', new Date().toISOString(), new Date().toISOString(), content.length, createHash('sha256').update(content).digest('hex'), 0, 0, id + '.jpg', filepath, temporary, 'pending');
      pending.push({ kind, id, temporary });
    }
    db.close();
    receiver = new Receiver(path.join(root, 'state'), path.join(root, 'photos'), '127.0.0.1'); await receiver.initialize();
    assert.equal(receiver.photos().length, 2);
    assert.ok(receiver.photos().every(p => p.width === 1200 && p.height === 800));
    for (const item of pending) await assert.rejects(stat(item.temporary));
  } finally { await receiver.close(); assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)); await rm(root, { recursive: true, force: true }); }
});


test('pre-saved pairing credential recovers after lost response and diagnostics exclude secrets', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mobilevision-pair-'));
  let receiver = new Receiver(path.join(root, 'state'), path.join(root, 'photos'), '127.0.0.1');
  try {
    await receiver.initialize();
    const credential = 'ab'.repeat(32); const token = receiver.pairing('127.0.0.1').token;
    const result = await call(receiver, 'POST', '/pair', Buffer.from(JSON.stringify({ token, deviceId: randomUUID(), deviceName: 'private-phone-name', credential })));
    assert.equal(result.status, 201);
    await receiver.close(); receiver = new Receiver(path.join(root, 'state'), path.join(root, 'photos'), '127.0.0.1'); await receiver.initialize();
    assert.equal((await call(receiver, 'GET', '/status', undefined, { Authorization: 'Bearer ' + credential })).status, 200);
    const log = JSON.stringify(receiver.diagnostics());
    for (const secret of [credential, token, 'private-phone-name', root]) assert.ok(!log.includes(secret));
    assert.ok(log.includes('PAIRED'));
  } finally { await receiver.close(); assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)); await rm(root, { recursive: true, force: true }); }
});


test('bulk deletion removes originals and thumbnails, preserves unselected photos and resumes interrupted deletion', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mobilevision-delete-'));
  let receiver = new Receiver(path.join(root, 'state'), path.join(root, 'photos'), '127.0.0.1');
  try {
    await receiver.initialize();
    const paired = await call(receiver, 'POST', '/pair', Buffer.from(JSON.stringify({ token: receiver.pairing('127.0.0.1').token, deviceId: randomUUID(), deviceName: 'delete-test' })));
    const image = await samplePhoto(); const ids: string[] = []; const files: string[] = [];
    for (let index = 0; index < 3; index++) {
      if (index === 1) await receiver.setDirectory(path.join(root, 'other-folder'));
      const response = await call(receiver, 'PUT', '/photos/' + randomUUID(), image, photoHeaders(paired.body.credential, image));
      assert.equal(response.status, 201); ids.push(response.body.id); files.push(receiver.photoPath(response.body.id)!);
      await receiver.thumbnail(response.body.id);
    }
    await assert.rejects(receiver.deletePhotos(['../outside'])); assert.equal(receiver.photos().length, 3);
    await rm(files[0]); // Missing original should not prevent clearing its thumbnail and row.
    await receiver.deletePhotos([ids[0], ids[1], ids[1]]);
    assert.deepEqual(receiver.photos().map(p => p.id), [ids[2]]);
    for (let i = 0; i < 2; i++) { await assert.rejects(stat(files[i])); await assert.rejects(stat(path.join(root, 'state', 'thumbnails', ids[i] + '.jpg'))); }
    assert.deepEqual(await readFile(files[2]), image);
    await receiver.close();
    const db = new DatabaseSync(path.join(root, 'state', 'receiver.sqlite')); db.prepare("UPDATE photos SET status='deleting' WHERE id=?").run(ids[2]); db.close();
    receiver = new Receiver(path.join(root, 'state'), path.join(root, 'photos'), '127.0.0.1'); await receiver.initialize();
    assert.equal(receiver.photos().length, 0); await assert.rejects(stat(files[2])); await assert.rejects(stat(path.join(root, 'state', 'thumbnails', ids[2] + '.jpg')));
  } finally { await receiver.close(); assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)); await rm(root, { recursive: true, force: true }); }
});
