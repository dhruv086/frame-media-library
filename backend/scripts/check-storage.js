import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { env } from '../src/config/env.js';
import { validateBucket } from '../src/utils/validators.js';
import * as storage from '../src/services/storage.service.js';

const bucket = validateBucket(process.argv[2] || env.buckets[0]);
const prefix = `cms-storage-check/${randomUUID()}/`;
const originalKey = `${prefix}original.png`;
const optimizedKey = `${prefix}optimized.webp`;
const multipartKey = `${prefix}multipart.png`;
let checks = 0;
let primaryError;
function passed(label) { checks += 1; console.log(`PASS ${label}`); }

console.log(`Testing configured storage: ${env.s3Endpoint || 'AWS S3 default endpoint'}; bucket: ${bucket}`);
console.log('Only uniquely named objects owned by this check are created and deleted.');
try {
  const original = await sharp({ create: { width: 1600, height: 900, channels: 3, background: '#4385bc' } }).png().toBuffer();
  const optimized = await sharp(original).resize(800).webp({ quality: 70 }).toBuffer();
  assert.equal(await storage.exists(bucket, originalKey), false);
  passed('missing-object HEAD');
  const { etag } = await storage.putObject(bucket, originalKey, original, 'image/png', 'public, max-age=300');
  assert.ok(etag);
  passed('original upload with ETag');
  const head = await storage.headObject(bucket, originalKey);
  assert.equal(head.ContentLength, original.length);
  assert.equal(head.ContentType, 'image/png');
  assert.equal(head.CacheControl, 'public, max-age=300');
  passed('HEAD size, Content-Type and Cache-Control');
  assert.deepEqual(await storage.getObject(bucket, originalKey), original);
  passed('authenticated original download');
  await storage.putObject(bucket, optimizedKey, optimized, 'image/webp', 'public, max-age=31536000, immutable');
  const optimizedBytes = await storage.getObject(bucket, optimizedKey);
  assert.deepEqual(optimizedBytes, optimized);
  const metadata = await sharp(optimizedBytes).metadata();
  assert.equal(metadata.width, 800);
  assert.equal(metadata.height, 450);
  assert.equal(metadata.format, 'webp');
  passed('optimized upload and decoded dimensions');
  const publicResponse = await fetch(storage.publicUrl(bucket, optimizedKey), { headers: { Origin: env.clientOrigin }, signal: AbortSignal.timeout(30000) });
  assert.equal(publicResponse.status, 200, 'Public download failed: configure the bucket public URL/access policy');
  assert.deepEqual(Buffer.from(await publicResponse.arrayBuffer()), optimized);
  passed('public optimized URL serves exact bytes');
  const allowedOrigin = publicResponse.headers.get('access-control-allow-origin');
  assert.ok(allowedOrigin === '*' || allowedOrigin === env.clientOrigin, 'Public endpoint CORS must allow the frontend origin');
  passed('public endpoint CORS allows frontend origin');
  // The frontend -> API -> object-store redirect crosses two different origins.
  const redirectedResponse = await fetch(storage.publicUrl(bucket, optimizedKey), { headers: { Origin: 'null' }, signal: AbortSignal.timeout(30000) });
  assert.equal(redirectedResponse.status, 200);
  const redirectedOrigin = redirectedResponse.headers.get('access-control-allow-origin');
  assert.ok(redirectedOrigin === '*' || redirectedOrigin === 'null', 'Redirected preview CORS must allow its opaque origin; use wildcard GET/HEAD for public assets');
  await redirectedResponse.arrayBuffer();
  passed('public endpoint CORS supports the cross-origin preview redirect');
  const large = Buffer.concat([original, Buffer.alloc(9 * 1024 * 1024)]);
  assert.ok((await storage.putObject(bucket, multipartKey, large, 'image/png', 'public, max-age=300')).etag);
  assert.deepEqual(await storage.getObject(bucket, multipartKey), large);
  passed('automatic multipart upload and download above 8 MiB');
  await storage.putObject(bucket, originalKey, optimized, 'image/webp', 'public, max-age=300');
  assert.deepEqual(await storage.getObject(bucket, originalKey), optimized);
  passed('overwrite at the same bucket/key');
  await storage.deleteObject(bucket, multipartKey);
  assert.equal(await storage.exists(bucket, multipartKey), false);
  passed('delete object');
  await storage.deletePrefix(bucket, prefix);
  assert.equal(await storage.exists(bucket, originalKey), false);
  assert.equal(await storage.exists(bucket, optimizedKey), false);
  passed('delete generated prefix');
  console.log(`\n${checks} configured-storage checks passed. No MongoDB data was changed.`);
} catch (error) {
  primaryError = error;
  throw error;
} finally {
  try { await storage.deletePrefix(bucket, prefix); }
  catch (error) {
    console.error(`Cleanup failed for test prefix ${prefix}; remove only this prefix manually.`);
    if (!primaryError) throw error;
  }
}
