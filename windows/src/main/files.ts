import { DatabaseSync } from 'node:sqlite';
import { mkdir, open, stat, truncate, rm, link, copyFile } from 'node:fs/promises';
import { constants, createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import type { ReceivedFile } from '../shared';
import type { IncomingMessage } from 'node:http';

export const FILE_LIMIT = 2 * 1024 ** 3;
export const CHUNK_SIZE = 4 * 1024 ** 2;
export class FileError extends Error { constructor(public status: number, public code: string) { super(code); } }
type Row = { id: string; deviceId: string; name: string; bytes: number; hash: string; offset: number; state: string; createdAt: string; receivedAt: string; temporary: string; filepath: string };
export class FileReceiver {
  private db: DatabaseSync;
  private busy = false;
  directory: string;
  constructor(private data: string, defaultDirectory: string, private changed: () => void) {
    this.db = new DatabaseSync(path.join(data, 'files.sqlite'));
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS files(id TEXT PRIMARY KEY,deviceId TEXT NOT NULL,name TEXT NOT NULL,bytes INTEGER NOT NULL,hash TEXT NOT NULL,offset INTEGER NOT NULL DEFAULT 0,state TEXT NOT NULL DEFAULT 'pending',createdAt TEXT NOT NULL,receivedAt TEXT NOT NULL DEFAULT '',temporary TEXT NOT NULL,filepath TEXT NOT NULL DEFAULT ''); CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL)");
    this.directory = (this.db.prepare("SELECT value FROM settings WHERE key='directory'").get() as { value: string } | undefined)?.value || defaultDirectory;
  }
  async initialize() {
    await mkdir(path.join(this.data, 'incoming-files'), { recursive: true }); await mkdir(this.directory, { recursive: true });
    for (const row of this.db.prepare("SELECT * FROM files WHERE state='pending'").all() as Row[]) {
      // A verified final file can finish the journal after a crash; existing content is never overwritten.
      if (row.filepath && await this.valid(row.filepath, row)) { this.finish(row); await rm(row.temporary, { force: true }); continue; }
      // A collision may refer to a pre-existing user file: never remove it during recovery.
      const length = await stat(row.temporary).then(x => x.size).catch(() => 0);
      const offset = Math.min(length, row.offset); if (length > offset) await truncate(row.temporary, offset);
      this.db.prepare("UPDATE files SET offset=?,filepath='' WHERE id=?").run(offset, row.id);
    }
  }
  list() { return this.db.prepare('SELECT id,name,bytes,offset,state,createdAt,receivedAt FROM files ORDER BY createdAt DESC LIMIT 500').all() as unknown as ReceivedFile[]; }
  filePath(id: string) { return (this.db.prepare("SELECT filepath FROM files WHERE id=? AND state='ready'").get(id) as { filepath: string } | undefined)?.filepath; }
  async setDirectory(directory: string) { if (this.busy) throw new Error('正在接收文件'); await mkdir(directory, { recursive: true }); const name = path.join(directory, '.mv-write-' + Date.now()); const f = await open(name, 'wx'); await f.close(); await rm(name); this.directory = directory; this.db.prepare("INSERT OR REPLACE INTO settings VALUES('directory',?)").run(directory); this.changed(); }
  private row(id: string, deviceId: string) { const row = this.db.prepare('SELECT * FROM files WHERE id=? AND deviceId=?').get(id, deviceId) as Row | undefined; if (!row) throw new FileError(404, 'FILE_NOT_FOUND'); return row; }
  private async valid(filename: string, row: Row) { if (await stat(filename).then(x => x.size).catch(() => -1) !== row.bytes) return false; const hash = createHash('sha256'); for await (const chunk of createReadStream(filename)) hash.update(chunk); return hash.digest('hex') === row.hash; }
  private finish(row: Row) { this.db.prepare("UPDATE files SET state='ready',offset=bytes,receivedAt=? WHERE id=?").run(new Date().toISOString(), row.id); this.changed(); }
  async handle(req: IncomingMessage, deviceId: string, id: string, action: string) {
    if (this.busy) throw new FileError(409, 'RECEIVER_BUSY');
    this.busy = true;
    try {
      if (req.method === 'POST' && !action) {
        const parts: Buffer[] = []; let size = 0; for await (const chunk of req) { size += chunk.length; if (size > 4096) throw new FileError(413, 'FILE_METADATA_TOO_LARGE'); parts.push(chunk); } const text = Buffer.concat(parts).toString('utf8');
        let body: any; try { body = JSON.parse(text); } catch { throw new FileError(400, 'INVALID_JSON'); }
        if (typeof body.name !== 'string' || !body.name.trim() || body.name.length > 240 || !Number.isSafeInteger(body.bytes) || body.bytes < 0 || body.bytes > FILE_LIMIT || typeof body.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(body.sha256)) throw new FileError(400, 'INVALID_FILE_METADATA');
        const name = body.name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[ .]+$/g, '') || 'file';
        const safeName = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name) ? '_' + name : name;
        const old = this.db.prepare('SELECT * FROM files WHERE id=?').get(id) as Row | undefined;
        if (old && (old.deviceId !== deviceId || old.hash !== body.sha256 || old.bytes !== body.bytes || old.name !== safeName)) throw new FileError(409, 'FILE_CONFLICT');
        const staging = path.join(this.directory, new Date().toISOString().slice(0, 10), '.mobilevision-part'); await mkdir(staging, { recursive: true });
        if (!old) this.db.prepare('INSERT INTO files(id,deviceId,name,bytes,hash,createdAt,temporary) VALUES(?,?,?,?,?,?,?)').run(id, deviceId, safeName, body.bytes, body.sha256, new Date().toISOString(), path.join(staging, id + '.part'));
        this.changed();
      }
      let row = this.row(id, deviceId);
      if (req.method === 'DELETE' && !action) {
        if (row.state === 'ready') throw new FileError(409, 'FILE_ALREADY_COMPLETE');
        await rm(row.temporary, { force: true }); this.db.prepare('DELETE FROM files WHERE id=?').run(id); this.changed(); return { canceled: true };
      }
      if (req.method === 'PUT' && action === 'chunk') {
        const offset = Number(req.headers['x-file-offset']); const size = Number(req.headers['content-length']);
        if (row.state !== 'pending' || !Number.isSafeInteger(offset) || offset !== row.offset || !Number.isSafeInteger(size) || size < 1 || size > CHUNK_SIZE || offset + size > row.bytes) throw new FileError(409, 'FILE_OFFSET_MISMATCH');
        const chunks: Buffer[] = []; let length = 0; for await (const chunk of req) { length += chunk.length; if (length > size) throw new FileError(413, 'FILE_CHUNK_TOO_LARGE'); chunks.push(chunk); }
        if (length !== size) throw new FileError(400, 'FILE_CHUNK_INCOMPLETE');
        const file = await open(row.temporary, 'r+').catch(error => { if (error.code !== 'ENOENT') throw error; return open(row.temporary, 'wx+'); }); try { await file.truncate(row.offset); const bytes = Buffer.concat(chunks); let written = 0; while (written < bytes.length) written += (await file.write(bytes, written, bytes.length - written, row.offset + written)).bytesWritten; await file.sync(); } finally { await file.close(); }
        this.db.prepare('UPDATE files SET offset=? WHERE id=?').run(offset + size, id); this.changed();
      } else if (req.method === 'POST' && action === 'complete' && row.state !== 'ready') {
        if (row.offset !== row.bytes) throw new FileError(409, 'FILE_INCOMPLETE');
        if (!row.bytes) { const empty = await open(row.temporary, 'a'); await empty.close(); }
        if (!await this.valid(row.temporary, row)) { await truncate(row.temporary, 0); this.db.prepare('UPDATE files SET offset=0 WHERE id=?').run(id); this.changed(); throw new FileError(422, 'CHECKSUM_MISMATCH'); }
        const folder = path.dirname(path.dirname(row.temporary)); await mkdir(folder, { recursive: true });
        const ext = path.extname(row.name); const base = path.basename(row.name, ext);
        row.filepath = '';
        for (let n = 0; n < 10000; n++) {
          const target = path.join(folder, n ? `${base} (${n + 1})${ext}` : row.name);
          this.db.prepare('UPDATE files SET filepath=? WHERE id=?').run(target, id);
          try {
            try { await link(row.temporary, target); } catch (error: any) {
              if (!['ENOTSUP', 'EOPNOTSUPP', 'EPERM', 'EXDEV', 'ENOSYS'].includes(error.code)) throw error;
              await copyFile(row.temporary, target, constants.COPYFILE_EXCL); const saved = await open(target, 'r+'); try { await saved.sync(); } finally { await saved.close(); }
            }
            row.filepath = target; break;
          } catch (e: any) { this.db.prepare("UPDATE files SET filepath='' WHERE id=?").run(id); if (e.code !== 'EEXIST') throw e; }
        }
        if (!row.filepath) throw new FileError(409, 'FILE_NAME_CONFLICT');
        this.finish(row); await rm(row.temporary, { force: true });
      } else if (!(req.method === 'GET' && !action) && !(req.method === 'POST' && (!action || action === 'complete'))) throw new FileError(405, 'METHOD_NOT_ALLOWED');
      row = this.row(id, deviceId); return { id, offset: row.offset, bytes: row.bytes, state: row.state, receivedAt: row.receivedAt };
    } finally { this.busy = false; }
  }
  close() { this.db.close(); }
}
