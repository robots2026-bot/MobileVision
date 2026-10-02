import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { validateFilePaths } from '../src/main/file-input';

test('file ingress rejects invalid paths and deduplicates the same Windows file', () => {
  const first = path.resolve('sample.txt');
  assert.deepEqual(validateFilePaths([first, first.toUpperCase()]), [path.normalize(first.toUpperCase())]);
  for (const value of [null, [], ['relative.txt'], ['https://example.com/a'], [''], [first + '\0'], Array(201).fill(first), [123]]) assert.throws(() => validateFilePaths(value));
});
