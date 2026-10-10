import { test } from 'node:test';
import assert from 'node:assert/strict';
import { s3 } from '../src/config/s3.js';
import { Upload } from '@aws-sdk/lib-storage';
import * as storage from '../src/services/storage.service.js';
import { env } from '../src/config/env.js';

test('missing object is a cache miss; access denied and connection failures are 502', async (t) => {
  t.mock.method(console, 'error', () => {});
  const send = t.mock.method(s3, 'send');
  for (const name of ['NotFound', 'NoSuchKey']) {
    send.mock.mockImplementation(async () => { throw Object.assign(new Error('missing'), { name, $metadata: { httpStatusCode: 404 } }); });
    assert.equal(await storage.headObject(env.buckets[0], 'missing'), null);
    assert.equal(await storage.exists(env.buckets[0], 'missing'), false);
  }
  for (const name of ['AccessDenied', 'ECONNREFUSED', 'NoSuchBucket']) {
    send.mock.mockImplementation(async () => { throw Object.assign(new Error('sensitive internal detail'), { name }); });
    for (const action of [() => storage.headObject(env.buckets[0], 'a'), () => storage.exists(env.buckets[0], 'a'), () => storage.getObject(env.buckets[0], 'a'), () => storage.deleteObject(env.buckets[0], 'a')]) {
      await assert.rejects(action, (error) => error.status === 502 && error.code === 'STORAGE_ERROR' && !error.message.includes('sensitive'));
    }
  }
});

test('multipart upload errors map to safe 502 and are logged', async (t) => {
  const failure = new Error('private storage failure');
  const log = t.mock.method(console, 'error', () => {});
  t.mock.method(Upload.prototype, 'done', async () => { throw failure; });
  await assert.rejects(storage.putObject(env.buckets[0], 'a', Buffer.from('x'), 'image/png', 'public'), { status: 502, code: 'STORAGE_ERROR' });
  assert.equal(log.mock.calls[0].arguments[1], failure);
});

test('prefix cleanup deletes all pages without crossing the requested prefix', async (t) => {
  const deleted = [];
  const first = Array.from({ length: 1000 }, (_, i) => ({ Key: `variants/test/${i}` }));
  t.mock.method(s3, 'send', async (command) => {
    assert.equal(command.input.Bucket, env.buckets[0]);
    if (command.constructor.name === 'ListObjectsV2Command') {
      assert.equal(command.input.Prefix, 'variants/test/');
      return command.input.ContinuationToken ? { Contents: [{ Key: 'variants/test/last' }], IsTruncated: false }
        : { Contents: first, IsTruncated: true, NextContinuationToken: 'next' };
    }
    deleted.push(...command.input.Delete.Objects.map(({ Key }) => Key));
    return {};
  });
  await storage.deletePrefix(env.buckets[0], 'variants/test/');
  assert.equal(deleted.length, 1001);
  assert.equal(new Set(deleted).size, 1001);
});

test('prefix cleanup rejects unsafe prefixes and detects per-object S3 errors', async (t) => {
  t.mock.method(console, 'error', () => {});
  for (const prefix of ['', undefined, 'variants/test']) await assert.rejects(storage.deletePrefix(env.buckets[0], prefix), { code: 'INVALID_PREFIX' });
  t.mock.method(s3, 'send', async (command) => command.constructor.name === 'ListObjectsV2Command'
    ? { Contents: [{ Key: 'variants/test/a' }] } : { Errors: [{ Key: 'variants/test/a', Code: 'AccessDenied' }] });
  await assert.rejects(storage.deletePrefix(env.buckets[0], 'variants/test/'), { status: 502, code: 'STORAGE_ERROR' });
});

test('public URLs encode special characters while preserving directory separators', () => {
  assert.equal(storage.publicUrl(env.buckets[0], 'variants/id/a b?#.webp'), `${env.bucketPublicUrls[env.buckets[0]]}/variants/id/a%20b%3F%23.webp`);
  assert.throws(() => storage.publicUrl('invalid', 'a'), { code: 'INVALID_BUCKET' });
  assert.throws(() => storage.publicUrl('constructor', 'a'), { code: 'INVALID_BUCKET' });
});
