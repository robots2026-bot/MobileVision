import { EventEmitter } from 'node:events';
import { createServer, type Server } from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash, randomBytes, randomUUID, timingSafeEqual, X509Certificate } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile, rename, rm, stat, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { DatabaseSync } from 'node:sqlite';
import selfsigned from 'selfsigned';
import sharp from 'sharp';
import type { Photo } from '../shared';

const MAX_BYTES = 50 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const equal = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
class ApiError extends Error { constructor(public status: number, public code: string) { super(code); } }
interface Device { id: string; name: string; tokenHash: string; lastSeen: number; }
interface Row { id: string; deviceId: string; photoId: string; deviceName: string; receivedAt: string; capturedAt: string; bytes: number; hash: string; width: number; height: number; filename: string; filepath: string; temporary: string; status: string; }

export class Receiver extends EventEmitter {
  private db!: DatabaseSync;
  private server?: Server;
  private device: Device | null = null;
  private token = '';
  private expiresAt = 0;
  private active = false;
  private deletion?: Promise<void>;
  private thumbnailJobs = new Map<string, Promise<Buffer | undefined>>();
  private stopping = false;
  private failureWindow = { start: Date.now(), count: 0 };
  public port = 0;
  public fingerprint = '';
  public certificate = '';
  public directory: string;
  public error: string | null = null;
  public readonly computerId: string;

  constructor(public readonly dataDirectory: string, directory: string, private bindHost = '0.0.0.0') {
    super(); this.directory = directory; this.computerId = '';
  }

  async initialize() {
    await mkdir(this.dataDirectory, { recursive: true });
    await mkdir(this.directory, { recursive: true });
    this.db = new DatabaseSync(path.join(this.dataDirectory, 'receiver.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS photos (id TEXT PRIMARY KEY, deviceId TEXT NOT NULL, photoId TEXT NOT NULL, deviceName TEXT NOT NULL, receivedAt TEXT NOT NULL, capturedAt TEXT NOT NULL, bytes INTEGER NOT NULL, hash TEXT NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL, filename TEXT NOT NULL, filepath TEXT NOT NULL, temporary TEXT NOT NULL, status TEXT NOT NULL, UNIQUE(deviceId, photoId));`);
    this.db.exec('CREATE TABLE IF NOT EXISTS diagnostics (id INTEGER PRIMARY KEY, time TEXT NOT NULL, event TEXT NOT NULL)');
    this.record('STARTING');
    const savedDirectory = this.setting('directory');
    if (savedDirectory) this.directory = savedDirectory;
    Object.defineProperty(this, 'computerId', { value: this.setting('computerId') || randomUUID() });
    this.setSetting('computerId', this.computerId);
    const savedDevice = this.setting('device');
    if (savedDevice) this.device = { ...JSON.parse(savedDevice), lastSeen: 0 };
    await this.recover();
    const tlsPath = path.join(this.dataDirectory, 'tls.json');
    let tls: { private: string; cert: string };
    try { tls = JSON.parse(await readFile(tlsPath, 'utf8')); }
    catch (error: any) {
      if (error.code !== 'ENOENT') throw error;
      const generated = await selfsigned.generate([{ name: 'commonName', value: 'MobileVision' }], { keySize: 2048, algorithm: 'sha256', extensions: [{ name: 'basicConstraints', cA: true, critical: true }, { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, keyCertSign: true }, { name: 'extKeyUsage', serverAuth: true }] });
      tls = { private: generated.private, cert: generated.cert };
      await writeFile(tlsPath, JSON.stringify(tls), { mode: 0o600, flag: 'wx' });
    }
    this.certificate = tls.cert;
    this.fingerprint = new X509Certificate(tls.cert).fingerprint256.replaceAll(':', '').toLowerCase();
    this.refreshPairing();
    this.server = createServer({ key: tls.private, cert: tls.cert, maxHeaderSize: 8192 }, (req, res) => { void this.handle(req, res); });
    this.server.requestTimeout = 120_000;
    this.server.headersTimeout = 15_000;
    this.server.on('error', error => { this.error = error.message; this.emit('change'); });
    const preferredPort = Number(this.setting('port') || 0);
    const listen = (port: number) => new Promise<void>((resolve, reject) => { this.server!.once('error', reject); this.server!.listen(port, this.bindHost, () => { this.server!.removeListener('error', reject); resolve(); }); });
    try { await listen(preferredPort); } catch (error: any) { if (preferredPort && error.code === 'EADDRINUSE') await listen(0); else throw error; }
    this.port = (this.server.address() as { port: number }).port;
    this.setSetting('port', String(this.port)); this.error = null; this.record('READY');
  }

  private record(event: string) {
    // Store event codes only: never request bodies, credentials, paths or photo metadata.
    this.db.prepare('INSERT INTO diagnostics(time,event) VALUES (?,?)').run(new Date().toISOString(), event);
    this.db.exec('DELETE FROM diagnostics WHERE id NOT IN (SELECT id FROM diagnostics ORDER BY id DESC LIMIT 200)');
  }
  diagnostics() { return { running: this.port > 0, paired: !!this.device, recentPhotoCount: this.photos().length, events: this.db.prepare('SELECT time,event FROM diagnostics ORDER BY id').all() }; }
  private setting(key: string): string | undefined { return (this.db.prepare('SELECT value FROM settings WHERE key=?').get(key) as { value: string } | undefined)?.value; }
  private setSetting(key: string, value: string) { this.db.prepare('INSERT OR REPLACE INTO settings VALUES (?,?)').run(key, value); }
  refreshPairing() { this.token = randomBytes(24).toString('hex'); this.expiresAt = Date.now() + 300_000; this.emit('change'); }
  pairing(address: string) { return { version: 1, address: `https://${address}:${this.port}`, computerId: this.computerId, computerName: os.hostname(), token: this.device ? '' : this.token, expiresAt: this.device ? 0 : this.expiresAt, certificateSha256: this.fingerprint }; }
  getDevice() { return this.device ? { name: this.device.name, lastSeen: this.device.lastSeen } : null; }
  revoke() { if (this.active) throw new Error('正在接收照片，请完成后再解除配对'); this.device = null; this.db.prepare("DELETE FROM settings WHERE key='device'").run(); this.refreshPairing(); }
  async setDirectory(directory: string) {
    if (this.active) throw new Error('正在接收照片，请完成后再切换目录');
    await mkdir(directory, { recursive: true }); await access(directory, constants.W_OK);
    this.directory = directory; this.setSetting('directory', directory); this.error = null; this.emit('change');
  }
  photos(): Photo[] { return this.db.prepare("SELECT id,photoId,deviceName,receivedAt,capturedAt,bytes,width,height,filename FROM photos WHERE status IN ('ready','deleting') ORDER BY receivedAt DESC LIMIT 500").all() as unknown as Photo[]; }
  photoPath(id: string) { return (this.db.prepare("SELECT filepath FROM photos WHERE id=? AND status='ready'").get(id) as { filepath: string } | undefined)?.filepath; }
  thumbnail(id: string): Promise<Buffer | undefined> {
    const current = this.thumbnailJobs.get(id); if (current) return current;
    const job = this.makeThumbnail(id).finally(() => this.thumbnailJobs.delete(id));
    this.thumbnailJobs.set(id, job); return job;
  }
  private async makeThumbnail(id: string) {
    const filename = this.photoPath(id); if (!filename) return undefined;
    const folder = path.join(this.dataDirectory, 'thumbnails'); await mkdir(folder, { recursive: true });
    const target = path.join(folder, `${id}.jpg`);
    try { return await readFile(target); } catch (e: any) { if (e.code !== 'ENOENT') throw e; }
    const buffer = await sharp(filename, { limitInputPixels: 60_000_000 }).rotate().resize(240, 180, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 75 }).toBuffer();
    await writeFile(target, buffer); return buffer;
  }

  async deletePhotos(ids: unknown): Promise<void> {
    if (!Array.isArray(ids) || !ids.length || ids.length > 500 || ids.some(id => typeof id !== 'string' || !UUID.test(id))) throw new Error('无效的照片选择');
    if (this.active || this.stopping) throw new Error('正在接收或处理照片，请稍后再删除');
    this.active = true;
    this.deletion = (async () => {
      let failed = 0;
      for (const id of new Set<string>(ids)) {
        const row = this.db.prepare("SELECT * FROM photos WHERE id=? AND status IN ('ready','deleting')").get(id) as unknown as Row | undefined;
        if (!row) continue;
        this.db.prepare("UPDATE photos SET status='deleting' WHERE id=?").run(id);
        try { await this.removePhoto(row); } catch { failed++; this.record('DELETE_FAILED'); }
      }
      this.emit('change');
      if (failed) throw new Error(failed + ' 张照片未完全删除，请重试；重启也会继续清理');
    })();
    try { await this.deletion; } finally { this.active = false; this.deletion = undefined; }
  }
  private async removePhoto(row: Row) {
    // Paths come only from our database, never from renderer input. No recursive removal.
    await this.thumbnailJobs.get(row.id)?.catch(() => undefined);
    await rm(row.filepath, { force: true });
    await rm(path.join(this.dataDirectory, 'thumbnails', row.id + '.jpg'), { force: true });
    this.db.prepare('DELETE FROM photos WHERE id=?').run(row.id);
  }
  private async recover() {
    for (const row of this.db.prepare("SELECT * FROM photos WHERE status='deleting'").all() as unknown as Row[]) {
      try { await this.removePhoto(row); } catch { this.record('DELETE_FAILED'); }
    }
    for (const row of this.db.prepare("SELECT * FROM photos WHERE status='pending'").all() as unknown as Row[]) {
      let candidate = row.filepath;
      try { await stat(candidate); } catch { candidate = row.temporary; }
      try {
        const file = await readFile(candidate);
        if (file.length !== row.bytes || digest(file) !== row.hash) throw new Error('Incomplete file');
        const metadata = await sharp(candidate, { limitInputPixels: 60_000_000, failOn: 'warning' }).metadata();
        if (!['jpeg', 'png'].includes(metadata.format || '') || !metadata.width || !metadata.height) throw new Error('Invalid image');
        await sharp(candidate, { limitInputPixels: 60_000_000, failOn: 'warning' }).rotate().resize(240).jpeg().toBuffer();
        const [width, height] = metadata.orientation && metadata.orientation >= 5 ? [metadata.height, metadata.width] : [metadata.width, metadata.height];
        if (candidate === row.temporary) await rename(row.temporary, row.filepath);
        this.db.prepare("UPDATE photos SET status='ready',width=?,height=? WHERE id=?").run(width, height, row.id);
      } catch { await rm(row.temporary, { force: true }); this.db.prepare('DELETE FROM photos WHERE id=?').run(row.id); }
    }
  }

  private reply(res: ServerResponse, status: number, body: object) { if (!res.destroyed) { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); } }
  private authenticate(req: IncomingMessage) {
    const value = req.headers.authorization || '';
    if (!this.device || !equal(digest(value), this.device.tokenHash)) throw new ApiError(401, 'UNAUTHORIZED');
    this.device.lastSeen = Date.now(); this.emit('change'); return this.device;
  }
  private async handle(req: IncomingMessage, res: ServerResponse) {
    try {
      if (this.stopping) throw new ApiError(503, 'STOPPING');
      if (Date.now() - this.failureWindow.start > 60_000) this.failureWindow = { start: Date.now(), count: 0 };
      if (this.failureWindow.count >= 20) throw new ApiError(429, 'TOO_MANY_ATTEMPTS');
      if (req.url === '/api/v1/pair' && req.method === 'POST') {
        if (this.device) throw new ApiError(409, 'ALREADY_PAIRED');
        let text = ''; for await (const chunk of req) { text += chunk; if (Buffer.byteLength(text) > 4096) throw new ApiError(413, 'FILE_TOO_LARGE'); }
        let body: any; try { body = JSON.parse(text); } catch { throw new ApiError(400, 'INVALID_JSON'); }
        if (Date.now() >= this.expiresAt) throw new ApiError(410, 'PAIRING_EXPIRED');
        if (typeof body.token !== 'string' || !equal(digest(body.token), digest(this.token))) throw new ApiError(401, 'UNAUTHORIZED');
        if (typeof body.deviceId !== 'string' || !UUID.test(body.deviceId) || typeof body.deviceName !== 'string' || !body.deviceName.trim() || body.deviceName.length > 80) throw new ApiError(400, 'INVALID_DEVICE');
        // Another request may have paired while this request body was arriving.
        if (this.device) throw new ApiError(409, 'ALREADY_PAIRED');
        if (body.credential !== undefined && (typeof body.credential !== 'string' || !/^[0-9a-f]{64}$/.test(body.credential))) throw new ApiError(400, 'INVALID_CREDENTIAL');
        const credential = body.credential ?? randomBytes(32).toString('hex');
        this.device = { id: body.deviceId.toLowerCase(), name: body.deviceName.trim(), tokenHash: digest(`Bearer ${credential}`), lastSeen: Date.now() };
        this.setSetting('device', JSON.stringify(this.device)); this.token = ''; this.expiresAt = 0;
        this.record('PAIRED'); this.reply(res, 201, { credential, computerId: this.computerId, version: 1 }); this.emit('change'); return;
      }
      const device = this.authenticate(req);
      if (req.url === '/api/v1/status' && req.method === 'GET') { this.reply(res, 200, { version: 1, accepting: !this.active, computerId: this.computerId }); return; }
      const match = /^\/api\/v1\/photos\/([0-9a-f-]+)(\/status)?$/i.exec(req.url || '');
      if (!match || !UUID.test(match[1])) throw new ApiError(404, 'NOT_FOUND');
      const photoId = match[1].toLowerCase();
      const existing = this.db.prepare("SELECT * FROM photos WHERE deviceId=? AND photoId=? AND status='ready'").get(device.id, photoId) as unknown as Row | undefined;
      if (req.method === 'GET' && match[2]) { if (!existing) throw new ApiError(404, 'NOT_FOUND'); this.reply(res, 200, { id: existing.id, receivedAt: existing.receivedAt }); return; }
      if (req.method !== 'PUT' || match[2]) throw new ApiError(405, 'METHOD_NOT_ALLOWED');
      if (this.active) throw new ApiError(409, 'RECEIVER_BUSY');
      this.active = true;
      try { await this.upload(req, res, device, photoId, existing); } finally { this.active = false; }
    } catch (error: any) {
      const code = error instanceof ApiError ? error.code : error.code === 'ENOSPC' ? 'DISK_FULL' : ['EACCES', 'EPERM', 'ENOENT'].includes(error.code) ? 'DIRECTORY_UNAVAILABLE' : 'INTERNAL_ERROR';
      this.record(code);
      if (code === 'UNAUTHORIZED') this.failureWindow.count++;
      if (!(error instanceof ApiError)) { this.error = `接收失败：${code}`; this.emit('change'); }
      this.reply(res, error instanceof ApiError ? error.status : 500, { error: { code } });
      req.resume();
    }
  }

  private async upload(req: IncomingMessage, res: ServerResponse, device: Device, photoId: string, existing?: Row) {
    const bytes = Number(req.headers['content-length']); const hash = req.headers['x-content-sha256'];
    const capturedAt = req.headers['x-captured-at'];
    const contentType = req.headers['content-type'];
    if (contentType !== 'image/jpeg' && contentType !== 'image/png') throw new ApiError(415, 'IMAGE_TYPE_REQUIRED');
    const expectedFormat = contentType === 'image/png' ? 'png' : 'jpeg';
    if (!Number.isSafeInteger(bytes) || bytes <= 0) throw new ApiError(400, 'CONTENT_LENGTH_REQUIRED');
    if (bytes > MAX_BYTES) throw new ApiError(413, 'FILE_TOO_LARGE');
    if (typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash)) throw new ApiError(400, 'INVALID_HASH');
    if (typeof capturedAt !== 'string' || capturedAt.length > 40 || !Number.isFinite(Date.parse(capturedAt))) throw new ApiError(400, 'INVALID_CAPTURE_TIME');
    if (existing && (existing.hash !== hash || existing.bytes !== bytes)) throw new ApiError(409, 'PHOTO_ID_CONFLICT');
    if (existing) {
      const file = await readFile(existing.filepath);
      if (file.length !== bytes || digest(file) !== hash) throw new ApiError(409, 'SAVED_FILE_CHANGED');
      req.resume(); this.reply(res, 200, { id: existing.id, receivedAt: existing.receivedAt, duplicate: true }); return;
    }
    const id = randomUUID(); const receivedAt = new Date().toISOString();
    const folder = path.join(this.directory, receivedAt.slice(0, 10)); await mkdir(folder, { recursive: true });
    const filename = `${receivedAt.slice(11, 23).replaceAll(':', '-')}_${id}.${expectedFormat === 'png' ? 'png' : 'jpg'}`;
    const filepath = path.join(folder, filename); const temporary = `${filepath}.part`;
    let committed = false; let journaled = false;
    try {
      // Journal before streaming so an interrupted upload can be cleaned on restart.
      this.db.prepare('INSERT INTO photos VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id, device.id, photoId, device.name, receivedAt, capturedAt, bytes, hash, 0, 0, filename, filepath, temporary, 'pending'); journaled = true;
      let count = 0; const hasher = createHash('sha256');
      const meter = new Transform({ transform(chunk, _encoding, done) { count += chunk.length; if (count > bytes || count > MAX_BYTES) { done(new ApiError(413, 'FILE_TOO_LARGE')); return; } hasher.update(chunk); done(null, chunk); } });
      await pipeline(req, meter, createWriteStream(temporary, { flags: 'wx', flush: true }));
      if (count !== bytes || hasher.digest('hex') !== hash) throw new ApiError(422, 'CHECKSUM_MISMATCH');
      let width: number; let height: number;
      try {
        const metadata = await sharp(temporary, { limitInputPixels: 60_000_000, failOn: 'warning' }).metadata();
        if (metadata.format !== expectedFormat || !metadata.width || !metadata.height) throw new Error('Invalid image');
        await sharp(temporary, { limitInputPixels: 60_000_000, failOn: 'warning' }).rotate().resize(240).jpeg().toBuffer();
        [width, height] = metadata.orientation && metadata.orientation >= 5 ? [metadata.height, metadata.width] : [metadata.width, metadata.height];
      } catch { throw new ApiError(422, 'INVALID_IMAGE'); }
      this.db.prepare('UPDATE photos SET width=?,height=? WHERE id=?').run(width, height, id);
      await rename(temporary, filepath); committed = true;
      this.db.prepare("UPDATE photos SET status='ready' WHERE id=?").run(id);
      this.error = null; this.reply(res, 201, { id, receivedAt, duplicate: false }); this.emit('change');
    } finally {
      if (!committed) { await rm(temporary, { force: true }); if (journaled) this.db.prepare('DELETE FROM photos WHERE id=?').run(id); }
    }
  }
  async close() {
    this.stopping = true;
    await this.deletion?.catch(() => undefined);
    if (this.server) await new Promise<void>(resolve => this.server!.close(() => resolve()));
    this.port = 0; this.db?.close();
  }
}

export function addresses() { return [...new Set(Object.entries(os.networkInterfaces()).sort(([a], [b]) => Number(/virtual|vmware|vethernet|wsl|tailscale|docker/i.test(a)) - Number(/virtual|vmware|vethernet|wsl|tailscale|docker/i.test(b))).flatMap(([, entries]) => entries || []).filter(x => x.family === 'IPv4' && !x.internal && !x.address.startsWith('169.254.')).map(x => x.address))]; }
