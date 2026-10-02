import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Receiver } from '../src/main/receiver';
import { call } from '../src/main/smoke';

test('bidirectional durable text, limits, identity, lost acknowledgements, copy once and local cleanup', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mobilevision-text-')); let receiver = new Receiver(path.join(root, 'state'), path.join(root, 'photos'), '127.0.0.1');
  try {
    await receiver.initialize(); const deviceId = randomUUID();
    const pair = await call(receiver, 'POST', '/pair', Buffer.from(JSON.stringify({ token: receiver.pairing('127.0.0.1').token, deviceId, deviceName: 'Text test' })));
    const auth = { Authorization: `Bearer ${pair.body.credential}` }; const id = randomUUID(); const text = '链接 https://example.com\n  缩进\t代码 <script>\n😀';
    let copies = 0; receiver.on('copy-text', value => { assert.equal(value, text); copies++; });
    const body = (value = text, copy = true) => Buffer.from(JSON.stringify({ text: value, copy }));
    assert.equal((await call(receiver, 'POST', `/messages/${id}`, body())).status, 401);
    assert.equal((await call(receiver, 'POST', `/messages/${id}`, body(), auth)).body.state, 'delivered');
    assert.equal(receiver.messages.list()[0].text, text); assert.equal(copies, 1);
    assert.equal((await call(receiver, 'POST', `/messages/${id}`, body(), auth)).status, 200); assert.equal(copies, 1);
    assert.equal((await call(receiver, 'POST', `/messages/${id}`, body('changed'), auth)).body.error.code, 'MESSAGE_CONFLICT');
    assert.equal((await call(receiver, 'POST', `/messages/${randomUUID()}`, body(' '.repeat(2)), auth)).status, 400);
    assert.equal((await call(receiver, 'POST', `/messages/${randomUUID()}`, body('a'.repeat(65537)), auth)).status, 400);
    assert.equal((await call(receiver, 'POST', `/messages/${randomUUID()}`, body('a'.repeat(65536), false), auth)).status, 200);
    receiver.messages.send(deviceId, text); const pending = receiver.messages.list().find(m => m.source === 'desktop')!;
    assert.equal((await call(receiver, 'GET', '/messages', undefined, auth)).body.messages[0].id, pending.id);
    receiver.messages.clean(); assert.equal(receiver.messages.list().length, 1); assert.equal((await call(receiver, 'POST', `/messages/${id}`, body(), auth)).status, 200); assert.equal(copies, 1);
    await receiver.close(); receiver = new Receiver(path.join(root, 'state'), path.join(root, 'photos'), '127.0.0.1'); await receiver.initialize();
    assert.equal((await call(receiver, 'GET', '/messages', undefined, auth)).body.messages[0].text, text);
    assert.equal((await call(receiver, 'POST', `/messages/${pending.id}/ack`, Buffer.alloc(0), auth)).body.state, 'delivered');
    assert.equal((await call(receiver, 'POST', `/messages/${pending.id}/ack`, Buffer.alloc(0), auth)).status, 200);
    assert.equal((await call(receiver, 'GET', '/messages', undefined, auth)).body.messages.length, 0);
    receiver.messages.clean(); assert.equal(receiver.messages.list().length, 0);
    receiver.revoke(); assert.equal((await call(receiver, 'GET', '/messages', undefined, auth)).status, 401);
  } finally { await receiver.close(); assert.ok(root.startsWith(os.tmpdir() + path.sep)); await rm(root, { recursive: true, force: true }); }
});
