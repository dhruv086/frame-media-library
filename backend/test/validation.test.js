import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateEnv, env } from '../src/config/env.js';
import { escapeRegex, parseDate, parseInteger, sanitizeFilename, validateBucket, validateFileType, validatePatch } from '../src/utils/validators.js';
import { imageMetadata, imageThumbnail, optimizeImage } from '../src/services/image.service.js';
import { withLock } from '../src/utils/locks.js';
import { Asset } from '../src/models/Asset.js';
import sharp from 'sharp';

test('startup rejects missing credentials and missing bucket public URLs together', () => {
  assert.throws(() => validateEnv({ BUCKETS: 'dev-assets', BUCKET_PUBLIC_URLS: 'prod-assets=http://localhost:9000/prod-assets', MONGO_URI: 'invalid' }), (e) =>
    /S3_ACCESS_KEY/.test(e.message) && /S3_SECRET_KEY/.test(e.message) && /missing dev-assets/.test(e.message) && /MONGO_URI/.test(e.message));
});

test('storage can switch providers using env only and rejects malformed configuration', () => {
  const base = { BUCKETS: 'dev-assets', BUCKET_PUBLIC_URLS: 'dev-assets=https://cdn.example.com', MONGO_URI: 'mongodb://localhost:27017/cms', S3_ACCESS_KEY: 'test', S3_SECRET_KEY: 'test' };
  assert.equal(validateEnv(base).s3Endpoint, undefined);
  assert.equal(validateEnv({ ...base, S3_ENDPOINT: 'https://account.r2.cloudflarestorage.com' }).s3Endpoint, 'https://account.r2.cloudflarestorage.com');
  for (const change of [{ PORT: '0' }, { MAX_UPLOAD_MB: '1.5' }, { S3_ENDPOINT: 'file:///tmp' }, { BUCKETS: 'dev-assets,dev-assets' }]) assert.throws(() => validateEnv({ ...base, ...change }));
});

test('prototype property names cannot bypass bucket public URL validation', () => {
  const base = { BUCKETS: 'dev-assets,constructor', BUCKET_PUBLIC_URLS: 'dev-assets=https://cdn.example.com', MONGO_URI: 'mongodb://localhost:27017/cms', S3_ACCESS_KEY: 'test', S3_SECRET_KEY: 'test' };
  assert.throws(() => validateEnv(base), /missing constructor/);
  assert.equal(validateEnv({ ...base, BUCKET_PUBLIC_URLS: `${base.BUCKET_PUBLIC_URLS},constructor=https://second.example.com` }).bucketPublicUrls.constructor, 'https://second.example.com');
});

test('file validation requires matching extension and MIME', () => {
  assert.equal(validateFileType({ originalname: 'photo.PNG', mimetype: 'image/png' }), 'png');
  for (const [originalname, mimetype] of [['bad.exe', 'image/png'], ['bad.png', 'application/octet-stream'], ['bad.mp4', 'image/png']]) {
    assert.throws(() => validateFileType({ originalname, mimetype }), { code: 'INVALID_FILE_TYPE', status: 400 });
  }
});

test('filenames remain flat, safe and predictable', () => {
  assert.equal(sanitizeFilename('../../My Summer #1.PNG'), 'my-summer-1.png');
  assert.equal(sanitizeFilename('C:\\fakepath\\Café Pic.JPG'), 'cafe-pic.jpg');
  assert.equal(sanitizeFilename('###.png'), 'asset.png');
  assert.equal(validateBucket(env.buckets[0]), env.buckets[0]);
  assert.throws(() => validateBucket('unknown'), { code: 'INVALID_BUCKET' });
});

test('numeric query values reject coercion, decimals, and out-of-range values', () => {
  assert.equal(parseInteger(undefined, 'q', 1, 100, 75), 75);
  for (const value of ['0', '4001', '5x', '1.2', '', ['1'], {}, null]) assert.throws(() => parseInteger(value, 'w', 1, 4000), { code: 'INVALID_QUERY' });
});

test('dates reject invalid calendar rollovers and malformed timestamps', () => {
  assert.equal(parseDate('2028-02-29', 'date').toISOString(), '2028-02-29T00:00:00.000Z');
  for (const value of ['2026-02-30', '2026-02-29', '2026-00-10', '2026-13-10', '2026-10-10T24:00:00Z', 'yesterday', {}, 0]) {
    assert.throws(() => parseDate(value, 'date'), { code: 'INVALID_DATE', status: 400 });
  }
});

test('PATCH preserves explicit null and rejects mixed tags and protected fields', () => {
  assert.deepEqual(validatePatch({ tags: ['one'], altText: 'A photo', expiresAt: null }), { tags: ['one'], altText: 'A photo', expiresAt: null });
  for (const body of [{ tags: 'one' }, { tags: ['one', 2] }, { expiresAt: '' }, { version: 99 }, { altText: null }, {}, []]) assert.throws(() => validatePatch(body));
});

test('search escapes regex input to literal text', () => {
  const literal = 'file.*(a)[b]$+?\\';
  assert.equal(new RegExp(escapeRegex(literal), 'i').test(literal), true);
  assert.equal(new RegExp(escapeRegex('.*'), 'i').test('anything'), false);
});

test('real image processing checks content and creates requested output', async () => {
  const input = await sharp({ create: { width: 800, height: 600, channels: 3, background: 'red' } }).png().toBuffer();
  assert.deepEqual(await imageMetadata(input, 'png'), { width: 800, height: 600, duration: null });
  await assert.rejects(imageMetadata(input, 'jpeg'), { code: 'INVALID_MEDIA' });
  const thumb = await sharp(await imageThumbnail(input)).metadata();
  assert.equal(thumb.width, 400);
  assert.equal(thumb.format, 'webp');
  for (const format of ['webp', 'avif', 'jpeg', 'png']) {
    const output = await sharp(await optimizeImage(input, { w: 200, h: 200, q: 75, format })).metadata();
    assert.equal(output.width, 200);
    assert.equal(output.height, 150);
    assert.equal(output.format, format === 'avif' ? 'heif' : format);
  }
});

test('asset JSON exposes id and hides Mongo internals', () => {
  const asset = new Asset({ bucket: 'dev-assets', key: 'a.png', originalName: 'a.png', format: 'png', mimeType: 'image/png', size: 10, url: 'https://example.com/a.png', thumbnailKey: 'thumbs/a.png.webp', thumbnailUrl: 'https://example.com/thumbs/a.png.webp', etag: 'test' });
  const json = asset.toJSON();
  assert.match(json.id, /^[a-f0-9]{24}$/);
  assert.equal(json.version, 1);
  assert.equal('_id' in json, false);
  assert.equal('__v' in json, false);
});

test('concurrent operations on one key are serialized, including after failure', async () => {
  const order = [];
  const first = withLock('a', async () => { order.push(1); await new Promise((r) => setTimeout(r, 10)); order.push(2); throw new Error('expected'); });
  const second = withLock('a', async () => { order.push(3); });
  await assert.rejects(first);
  await second;
  assert.deepEqual(order, [1, 2, 3]);
});
