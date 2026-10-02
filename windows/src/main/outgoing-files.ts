import { DatabaseSync } from 'node:sqlite';
import { copyFile, mkdir, open, rm, stat, readdir } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import type { IncomingMessage } from 'node:http';
import { FileError, FILE_LIMIT, CHUNK_SIZE } from './files';
import type { ReceivedFile } from '../shared';

type Row = { id: string; deviceId: string; name: string; bytes: number; hash: string; filepath: string; original: string; offset: number; state: string; createdAt: string; receivedAt: string };
export class OutgoingFiles {
  private db: DatabaseSync;
  private directory: string;
  constructor(data: string, private changed: () => void) {
    this.directory = path.join(data, 'outgoing-files'); this.db = new DatabaseSync(path.join(data, 'outgoing-files.sqlite'));
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS files(id TEXT PRIMARY KEY,deviceId TEXT NOT NULL,name TEXT NOT NULL,bytes INTEGER NOT NULL,hash TEXT NOT NULL,filepath TEXT NOT NULL,original TEXT NOT NULL,offset INTEGER NOT NULL DEFAULT 0,state TEXT NOT NULL DEFAULT 'pending',createdAt TEXT NOT NULL,receivedAt TEXT NOT NULL DEFAULT '')");
  }
  async initialize() { await mkdir(this.directory, { recursive: true }); for (const row of this.db.prepare("SELECT * FROM files WHERE state IN ('sent','canceled')").all() as Row[]) await rm(row.filepath, { force: true }); const known = new Set((this.db.prepare('SELECT id FROM files').all() as {id: string}[]).map(x => x.id + '.bin')); for (const name of await readdir(this.directory)) if (/^[0-9a-f-]{36}\.bin$/.test(name) && !known.has(name)) await rm(path.join(this.directory, name), { force: true }); }
  list() { return this.db.prepare("SELECT id,name,bytes,offset,state,createdAt,receivedAt,'desktop' AS direction FROM files ORDER BY createdAt DESC LIMIT 500").all() as unknown as ReceivedFile[]; }
  original(id: string) { return (this.db.prepare('SELECT original FROM files WHERE id=?').get(id) as {original: string} | undefined)?.original; }
  async add(deviceId: string, original: string) {
    const info = await stat(original); if (!info.isFile()) throw new Error('暂不支持文件夹，请选择文件'); if (info.size > FILE_LIMIT) throw new Error('仅支持不超过 2 GB 的文件');
    const id = randomUUID(); const filename = path.join(this.directory, id + '.bin');
    try {
      await copyFile(original, filename); const bytes = (await stat(filename)).size; if (bytes > FILE_LIMIT) throw new Error('文件超过 2 GB');
      const hash = createHash('sha256'); for await (const chunk of createReadStream(filename)) hash.update(chunk);
      const file = await open(filename, 'r+'); try { await file.sync(); } finally { await file.close(); }
      this.db.prepare('INSERT INTO files(id,deviceId,name,bytes,hash,filepath,original,createdAt) VALUES(?,?,?,?,?,?,?,?)').run(id, deviceId, path.basename(original).slice(0, 240), bytes, hash.digest('hex'), filename, original, new Date().toISOString()); this.changed(); return id;
    } catch (error) { await rm(filename, { force: true }); throw error; }
  }
  private row(id: string, deviceId: string) { const row = this.db.prepare('SELECT * FROM files WHERE id=? AND deviceId=?').get(id, deviceId) as Row | undefined; if (!row) throw new FileError(404, 'DOWNLOAD_NOT_FOUND'); return row; }
  async cancel(id: string) { const row = this.db.prepare('SELECT * FROM files WHERE id=?').get(id) as Row | undefined; if (!row || row.state !== 'pending') return; this.db.prepare("UPDATE files SET state='canceled' WHERE id=?").run(id); this.changed(); await rm(row.filepath, { force: true }); }
  async handle(req: IncomingMessage, deviceId: string, id?: string, action = '', offsetText = '') {
    if (req.method === 'GET' && !id) { const row = this.db.prepare("SELECT id,name,bytes,hash AS sha256 FROM files WHERE deviceId=? AND state='pending' ORDER BY createdAt LIMIT 1").get(deviceId); return { files: row ? [row] : [] }; }
    if (!id) throw new FileError(405, 'METHOD_NOT_ALLOWED'); const row = this.row(id, deviceId);
    if (req.method === 'GET' && action === 'chunk') {
      if (row.state !== 'pending') throw new FileError(409, row.state === 'canceled' ? 'DOWNLOAD_CANCELED' : 'DOWNLOAD_COMPLETE');
      const offset = Number(offsetText); if (!/^\d+$/.test(offsetText) || !Number.isSafeInteger(offset) || offset < 0 || offset >= row.bytes) throw new FileError(400, 'INVALID_OFFSET');
      const file = await open(row.filepath, 'r'); let buffer: Buffer;
      try {
        if ((await file.stat()).size !== row.bytes) throw new FileError(409, 'LOCAL_FILE_CHANGED');
        buffer = Buffer.alloc(Math.min(CHUNK_SIZE, row.bytes - offset)); let length = 0;
        while (length < buffer.length) { const result = await file.read(buffer, length, buffer.length - length, offset + length); if (!result.bytesRead) throw new FileError(409, 'LOCAL_FILE_CHANGED'); length += result.bytesRead; }
      } finally { await file.close(); }
      return { id, offset, data: buffer.toString('base64') };
    }
    if (req.method !== 'POST' || action !== 'ack') throw new FileError(405, 'METHOD_NOT_ALLOWED');
    let body = ''; for await (const chunk of req) { body += chunk; if (Buffer.byteLength(body) > 1024) throw new FileError(413, 'INVALID_ACK'); }
    let ack: any; try { ack = JSON.parse(body); } catch { throw new FileError(400, 'INVALID_JSON'); }
    if (!Number.isSafeInteger(ack.offset) || ack.offset < 0 || ack.offset > row.bytes || typeof ack.complete !== 'boolean' || typeof ack.canceled !== 'boolean' || (ack.complete && ack.canceled) || (ack.complete && (ack.offset !== row.bytes || ack.sha256 !== row.hash))) throw new FileError(400, 'INVALID_ACK');
    if (row.state === 'pending') {
      const state = ack.canceled ? 'canceled' : ack.complete ? 'sent' : 'pending';
      this.db.prepare('UPDATE files SET offset=?,state=?,receivedAt=? WHERE id=?').run(ack.offset, state, state === 'sent' ? new Date().toISOString() : '', id); this.changed();
      if (state !== 'pending') await rm(row.filepath, { force: true });
    }
    return { id, state: this.row(id, deviceId).state };
  }
  close() { this.db.close(); }
}
