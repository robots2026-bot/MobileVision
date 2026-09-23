import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { cropPhoto } from '../src/main/crop';
test('crop uses oriented original pixels, preserves source, validates bounds', async () => {
 const root = await mkdtemp(path.join(os.tmpdir(), 'mobilevision-crop-'));
 try {
  const file = path.join(root, 'rotated.jpg');
  await sharp({ create: { width: 80, height: 40, channels: 3, background: '#e04020' } }).jpeg().withMetadata({ orientation: 6 }).toFile(file);
  const original = await readFile(file);
  const output = await cropPhoto(file, { x: 10, y: 30, width: 20, height: 40 });
  const metadata = await sharp(output).metadata(); assert.equal(metadata.width, 20); assert.equal(metadata.height, 40); assert.equal(metadata.format, 'png');
  const expected = await sharp(file).rotate().raw().toBuffer({ resolveWithObject: true });
  const pixels = await sharp(expected.data, { raw: expected.info }).extract({ left: 10, top: 30, width: 20, height: 40 }).raw().toBuffer();
  assert.deepEqual(await sharp(output).raw().toBuffer(), pixels);
  assert.deepEqual(await readFile(file), original);
  for (const region of [{ x: -1, y: 0, width: 1, height: 1 }, { x: 0, y: 0, width: 100, height: 1 }, { x: NaN, y: 0, width: 2, height: 2 }, { x: 0, y: 0, width: 0, height: 1 }]) await assert.rejects(cropPhoto(file, region));
 } finally { assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)); await rm(root, { recursive: true, force: true }); }
});
