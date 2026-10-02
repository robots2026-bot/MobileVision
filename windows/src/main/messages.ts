import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import type { IncomingMessage } from 'node:http';
import { FileError } from './files';
import type { TextMessage } from '../shared';

export const TEXT_LIMIT = 64 * 1024;
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
type Row = TextMessage & { deviceId: string; hash: string; copy: number };
export class MessageReceiver {
  private db: DatabaseSync;
  constructor(directory: string, private changed: () => void, private copyText: (text: string) => void) {
    this.db = new DatabaseSync(path.join(directory, 'messages.sqlite'));
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS messages(seq INTEGER PRIMARY KEY,id TEXT UNIQUE NOT NULL,deviceId TEXT NOT NULL,text TEXT NOT NULL,hash TEXT NOT NULL,source TEXT NOT NULL,state TEXT NOT NULL,createdAt TEXT NOT NULL,copy INTEGER NOT NULL DEFAULT 0,hidden INTEGER NOT NULL DEFAULT 0)");
  }
  list(): TextMessage[] { return this.db.prepare('SELECT id,text,source,state,createdAt FROM messages WHERE hidden=0 ORDER BY seq DESC LIMIT 500').all() as unknown as TextMessage[]; }
  text(id: string) { return (this.db.prepare('SELECT text FROM messages WHERE id=? AND hidden=0').get(id) as {text: string} | undefined)?.text; }
  send(deviceId: string, text: unknown) {
    this.validate(text); const id = randomUUID();
    this.db.prepare("INSERT INTO messages(id,deviceId,text,hash,source,state,createdAt) VALUES(?,?,?,?, 'desktop','pending',?)").run(id, deviceId, text as string, digest(text as string), new Date().toISOString()); this.changed();
  }
  clean() { this.db.exec("UPDATE messages SET hidden=1,text='' WHERE state='delivered'"); this.changed(); }
  private validate(text: unknown): asserts text is string { if (typeof text !== 'string' || !text.trim() || Buffer.byteLength(text, 'utf8') > TEXT_LIMIT) throw new FileError(400, 'INVALID_TEXT'); }
  async handle(req: IncomingMessage, deviceId: string, id?: string, ack = false) {
    if (req.method === 'GET' && !id) { const row = this.db.prepare("SELECT id,text,createdAt FROM messages WHERE deviceId=? AND source='desktop' AND state='pending' ORDER BY seq LIMIT 1").get(deviceId); return { messages: row ? [row] : [] }; }
    if (!id) throw new FileError(405, 'METHOD_NOT_ALLOWED');
    if (req.method === 'POST' && ack) {
      const row = this.db.prepare("SELECT id FROM messages WHERE id=? AND deviceId=? AND source='desktop'").get(id, deviceId); if (!row) throw new FileError(404, 'MESSAGE_NOT_FOUND');
      this.db.prepare("UPDATE messages SET state='delivered' WHERE id=?").run(id); this.changed(); return { id, state: 'delivered' };
    }
    if (req.method !== 'POST' || ack) throw new FileError(405, 'METHOD_NOT_ALLOWED');
    const parts: Buffer[] = []; let length = 0;
    for await (const chunk of req) { length += chunk.length; if (length > TEXT_LIMIT * 6 + 4096) throw new FileError(413, 'TEXT_TOO_LARGE'); parts.push(chunk); }
    let body: any; try { body = JSON.parse(Buffer.concat(parts).toString('utf8')); } catch { throw new FileError(400, 'INVALID_JSON'); }
    this.validate(body.text); if (typeof body.copy !== 'boolean') throw new FileError(400, 'INVALID_TEXT');
    const old = this.db.prepare('SELECT * FROM messages WHERE id=?').get(id) as Row | undefined;
    if (old && (old.deviceId !== deviceId || old.source !== 'phone' || old.hash !== digest(body.text) || !!old.copy !== body.copy)) throw new FileError(409, 'MESSAGE_CONFLICT');
    if (!old) {
      this.db.prepare("INSERT INTO messages(id,deviceId,text,hash,source,state,createdAt,copy) VALUES(?,?,?,?, 'phone','delivered',?,?)").run(id, deviceId, body.text, digest(body.text), new Date().toISOString(), body.copy ? 1 : 0);
      if (body.copy) this.copyText(body.text); this.changed();
    }
    return { id, state: 'delivered' };
  }
  close() { this.db.close(); }
}
