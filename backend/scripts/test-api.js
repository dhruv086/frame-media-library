import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readdir, rm, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import sharp from 'sharp';
import ffmpegPath from 'ffmpeg-static';
import { Upload } from '@aws-sdk/lib-storage';
import { request as httpRequest } from 'node:http';

// Each run owns a fresh database; the development CMS database is never cleared.
dotenv.config({ path: fileURLToPath(new URL('../.env', import.meta.url)), quiet: true });
const mongo = new URL(process.env.MONGO_URI);
mongo.pathname = `/cms_test_${Date.now()}_${process.pid}`;
process.env.MONGO_URI = mongo.toString();
process.env.MAX_UPLOAD_MB = '12';
const { env } = await import('../src/config/env.js');
const { connectDb, disconnectDb } = await import('../src/config/db.js');
const { createApp } = await import('../src/app.js');
const { Asset } = await import('../src/models/Asset.js');
const { s3 } = await import('../src/config/s3.js');
const storage = await import('../src/services/storage.service.js');
const { waitForVideoJobs, recoverVideoJobs } = await import('../src/services/video-jobs.service.js');
const mongoose = (await import('mongoose')).default;
const exec = promisify(execFile);
const run = `edge-${Date.now()}-${process.pid}`;
const created = new Map();
const files = {};
const contents = {};
let directory;
let server;
let base;
let initialTemps;

async function request(endpoint, { method = 'GET', fields = {}, file, format = 'png', name, mime, json, raw, headers = {} } = {}) {
  let body;
  if (file !== undefined) {
    body = new FormData();
    for (const [key, value] of Object.entries(fields)) body.append(key, value);
    if (file !== null) body.append('file', new Blob([file], { type: mime ?? ({ jpg: 'image/jpeg', jpeg: 'image/jpeg', mov: 'video/quicktime', mp4: 'video/mp4', webm: 'video/webm' }[format] ?? `image/${format}`) }), name ?? `${run}-${format}.${format}`);
  } else if (json !== undefined || raw !== undefined) {
    body = raw ?? JSON.stringify(json);
    headers = { 'Content-Type': 'application/json', ...headers };
  }
  const response = await fetch(endpoint.startsWith('http') ? endpoint : `${base}${endpoint}`, { method, body, headers, redirect: 'manual', signal: AbortSignal.timeout(60000) });
  const bytes = Buffer.from(await response.arrayBuffer());
  let data;
  try { data = JSON.parse(bytes.toString()); } catch { data = bytes; }
  if (method === 'POST' && response.status === 201 && data.id) created.set(data.id, data);
  return { status: response.status, headers: response.headers, data, bytes };
}

function expect(result, status, code) {
  assert.equal(result.status, status, Buffer.isBuffer(result.data) ? result.data.toString().slice(0, 400) : JSON.stringify(result.data));
  if (code) {
    assert.deepEqual(Object.keys(result.data), ['error']);
    assert.deepEqual(Object.keys(result.data.error).sort(), ['code', 'message']);
    assert.equal(result.data.error.code, code);
  }
  return result.data;
}

async function upload(format = 'png', suffix = format, bucket = env.buckets[0], body = contents[format]) {
  return request('/assets', { method: 'POST', fields: { bucket }, file: body, format, name: `${run}-${suffix}.${format}` });
}

async function fresh(suffix) { return expect(await upload('png', suffix), 201); }

before(async () => {
  const runtime = fileURLToPath(new URL('../.runtime/', import.meta.url));
  await mkdir(runtime, { recursive: true });
  directory = await mkdtemp(path.join(runtime, 'edge-'));
  initialTemps = new Set((await readdir(os.tmpdir())).filter((name) => name.startsWith('cms-')));
  for (const format of ['png', 'jpg', 'jpeg', 'webp', 'gif', 'avif']) {
    const data = await sharp({ create: { width: 80, height: 60, channels: 4, background: '#5678ab' } }).toFormat(format === 'jpg' ? 'jpeg' : format).toBuffer();
    contents[format] = data;
    files[format] = path.join(directory, `sample.${format}`);
    await writeFile(files[format], data);
  }
  for (const format of ['mp4', 'mov', 'webm']) {
    files[format] = path.join(directory, `sample.${format}`);
    await exec(ffmpegPath, ['-y', '-f', 'lavfi', '-i', 'testsrc2=size=80x60:rate=10', '-t', '1.2', '-c:v', format === 'webm' ? 'libvpx-vp9' : 'libx264', '-pix_fmt', 'yuv420p', files[format]], { windowsHide: true });
    contents[format] = await readFile(files[format]);
  }
  await connectDb();
  server = createApp().listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  base = `http://127.0.0.1:${server.address().port}`;
}, { timeout: 60000 });

after(async () => {
  await waitForVideoJobs();
  for (const asset of created.values()) {
    await Promise.allSettled([storage.deleteObject(asset.bucket, asset.key), storage.deleteObject(asset.bucket, asset.thumbnailKey), storage.deletePrefix(asset.bucket, `variants/${asset.id}/`)]);
  }
  if (server) await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
  if (mongoose.connection.readyState === 1) await mongoose.connection.dropDatabase();
  await disconnectDb();
  if (directory) await rm(directory, { recursive: true, force: true });
});

for (const format of ['png', 'jpg', 'jpeg', 'webp', 'gif', 'avif', 'mp4', 'webm', 'mov']) test(`upload, metadata, public bytes and 400px thumbnail: ${format}`, async () => {
  const asset = expect(await upload(format), 201);
  assert.equal(asset.format, format);
  assert.equal(asset.width, 80);
  assert.equal(asset.height, 60);
  assert.equal(asset.size, contents[format].length);
  assert.equal(asset.version, 1);
  assert.ok(asset.etag);
  assert.equal('_id' in asset, false);
  assert.equal('__v' in asset, false);
  const publicFile = await request(asset.url);
  expect(publicFile, 200);
  assert.deepEqual(publicFile.bytes, contents[format]);
  assert.equal(publicFile.headers.get('content-type'), asset.mimeType);
  assert.equal(publicFile.headers.get('cache-control'), 'public, max-age=300');
  const thumbnail = await request(asset.thumbnailUrl);
  expect(thumbnail, 200);
  const metadata = await sharp(thumbnail.bytes).metadata();
  assert.equal(metadata.width, 400);
  assert.equal(metadata.format, asset.mimeType.startsWith('video/') ? 'jpeg' : 'webp');
  if (asset.mimeType.startsWith('video/')) assert.ok(asset.duration >= 1);
  else assert.equal(asset.duration, null);
});

test('health, buckets, CORS preflight, unknown endpoint, and unsupported methods', async () => {
  expect(await request('/api/health'), 200);
  const buckets = expect(await request('/buckets'), 200);
  assert.equal(buckets.buckets.length, env.buckets.length);
  const preflight = await request('/assets', { method: 'OPTIONS', headers: { Origin: env.clientOrigin, 'Access-Control-Request-Method': 'PUT', 'Access-Control-Request-Headers': 'content-type' } });
  expect(preflight, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), env.clientOrigin);
  expect(await request('/missing'), 404, 'NOT_FOUND');
  expect(await request('/assets', { method: 'PUT' }), 404, 'NOT_FOUND');
});

test('duplicate upload cannot overwrite existing bytes; filenames are isolated across configured buckets', async () => {
  const first = await fresh('bucket-isolation');
  for (const bucket of env.buckets.slice(1)) {
    const second = expect(await upload('png', 'bucket-isolation', bucket), 201);
    assert.equal(second.key, first.key);
    assert.notEqual(second.url, first.url);
  }
  expect(await upload('png', 'bucket-isolation'), 409, 'DUPLICATE');
  assert.deepEqual((await request(first.url)).bytes, contents.png);
});

test('sanitized filename collisions are rejected; uppercase extensions and unsafe names work', async () => {
  const first = expect(await request('/assets', { method: 'POST', fields: { bucket: env.buckets[0] }, file: contents.png, name: `${run} Hello #1.PNG` }), 201);
  assert.equal(first.key, `${run}-hello-1.png`);
  expect(await request('/assets', { method: 'POST', fields: { bucket: env.buckets[0] }, file: contents.png, name: `${run}-hello-1.png` }), 409, 'DUPLICATE');
});

for (const [label, name, mime, bytes, code] of [
  ['exe', 'bad.exe', 'application/octet-stream', Buffer.from('bad'), 'INVALID_FILE_TYPE'],
  ['SVG', 'bad.svg', 'image/svg+xml', Buffer.from('<svg/>'), 'INVALID_FILE_TYPE'],
  ['missing extension', 'bad', 'image/png', Buffer.from('bad'), 'INVALID_FILE_TYPE'],
  ['double extension', 'bad.png.exe', 'image/png', Buffer.from('bad'), 'INVALID_FILE_TYPE'],
  ['mismatched MIME', 'bad.png', 'video/mp4', Buffer.from('bad'), 'INVALID_FILE_TYPE'],
  ['empty content', 'empty.png', 'image/png', Buffer.alloc(0), 'INVALID_MEDIA'],
  ['corrupt image', 'corrupt.png', 'image/png', Buffer.from('not png'), 'INVALID_MEDIA'],
  ['corrupt video', 'corrupt.mp4', 'video/mp4', Buffer.from('not video'), 'INVALID_MEDIA'],
]) test(`reject upload: ${label}`, async () => {
  expect(await request('/assets', { method: 'POST', fields: { bucket: env.buckets[0] }, file: bytes, name: `${run}-${name}`, mime }), 400, code);
  assert.equal(await Asset.exists({ key: `${run}-${name}` }), null);
  assert.equal(await storage.exists(env.buckets[0], `${run}-${name}`), false);
});

test('valid MIME and extension cannot disguise another image format', async () => {
  expect(await request('/assets', { method: 'POST', fields: { bucket: env.buckets[0] }, file: contents.jpeg, name: `${run}-disguised.png` }), 400, 'INVALID_MEDIA');
  assert.equal(await storage.exists(env.buckets[0], `${run}-disguised.png`), false);
});

test('file, bucket, duplicate fields, and unexpected file fields are validated', async () => {
  expect(await request('/assets', { method: 'POST', fields: { bucket: env.buckets[0] }, file: null }), 400, 'FILE_REQUIRED');
  expect(await request('/assets', { method: 'POST', file: contents.png }), 400, 'INVALID_BUCKET');
  expect(await upload('png', 'bad-bucket', 'invalid'), 400, 'INVALID_BUCKET');
  for (const kind of ['duplicate-file', 'wrong-field', 'duplicate-bucket']) {
    const form = new FormData();
    form.append('bucket', env.buckets[0]);
    form.append(kind === 'wrong-field' ? 'asset' : 'file', new Blob([contents.png], { type: 'image/png' }), `${run}-${kind}.png`);
    if (kind === 'duplicate-file') form.append('file', new Blob([contents.png], { type: 'image/png' }), 'second.png');
    if (kind === 'duplicate-bucket') form.append('bucket', env.buckets[0]);
    const response = await fetch(`${base}/assets`, { method: 'POST', body: form });
    assert.equal(response.status, 400, kind);
  }
});

test('multipart missing boundary and truncated forms return JSON 400', async () => {
  for (const headers of [{ 'Content-Type': 'multipart/form-data' }, { 'Content-Type': 'multipart/form-data; boundary=broken' }]) {
    expect(await request('/assets', { method: 'POST', raw: '--broken\r\n', headers }), 400, 'INVALID_UPLOAD');
  }
});

test('size limit rejects one byte over and accepts the exact boundary', async () => {
  const allowed = Buffer.concat([contents.png, Buffer.alloc(12 * 1024 * 1024 - contents.png.length)]);
  const result = expect(await upload('png', 'exact-limit', env.buckets[0], allowed), 201);
  assert.equal(result.size, 12 * 1024 * 1024);
  expect(await upload('png', 'over-limit', env.buckets[0], Buffer.concat([allowed, Buffer.from([0])])), 413, 'FILE_TOO_LARGE');
  assert.equal(await storage.exists(env.buckets[0], `${run}-over-limit.png`), false);
});

test('aborted multipart uploads remove partial files and do not persist an asset', async (t) => {
  t.mock.method(console, 'error', () => {});
  const boundary = 'cms-abort-boundary';
  const filename = `${run}-aborted.png`;
  const prefix = `--${boundary}\r\nContent-Disposition: form-data; name="bucket"\r\n\r\n${env.buckets[0]}\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: image/png\r\n\r\n`;
  const baseline = new Set(await readdir(os.tmpdir()));
  const req = httpRequest(`${base}/assets`, { method: 'POST', headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': 1000000 } });
  req.on('error', () => {});
  req.write(prefix);
  req.write(contents.png);
  // Wait for the partial file to be created before disconnecting the client.
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if ((await readdir(os.tmpdir())).some((name) => name.startsWith('cms-upload-') && !baseline.has(name))) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  req.destroy();
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (!(await readdir(os.tmpdir())).some((name) => name.startsWith('cms-upload-') && !baseline.has(name))) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(await Asset.exists({ key: filename }), null);
  assert.deepEqual((await readdir(os.tmpdir())).filter((name) => name.startsWith('cms-upload-') && !baseline.has(name)), []);
});

test('EXIF orientation is applied consistently to asset dimensions and thumbnail', async () => {
  const bytes = await sharp(contents.jpeg).withMetadata({ orientation: 6 }).jpeg().toBuffer();
  const asset = expect(await upload('jpeg', 'oriented', env.buckets[0], bytes), 201);
  assert.equal(asset.width, 60);
  assert.equal(asset.height, 80);
  const thumbnail = await sharp((await request(asset.thumbnailUrl)).bytes).metadata();
  assert.equal(thumbnail.width, 400);
  assert.equal(thumbnail.height, 533);
});

test('short, exact-one-second, and audio-only video edge cases', async () => {
  for (const duration of ['0.1', '1']) {
    const filename = path.join(directory, `duration-${duration}.mp4`);
    await exec(ffmpegPath, ['-y', '-f', 'lavfi', '-i', 'color=c=blue:s=80x60:r=10', '-t', duration, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', filename], { windowsHide: true });
    const asset = expect(await upload('mp4', `duration-${duration}`, env.buckets[0], await readFile(filename)), 201);
    expect(await request(asset.thumbnailUrl), 200);
  }
  const audio = path.join(directory, 'audio.mp4');
  await exec(ffmpegPath, ['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.2', '-c:a', 'aac', audio], { windowsHide: true });
  expect(await upload('mp4', 'audio-only', env.buckets[0], await readFile(audio)), 400, 'INVALID_MEDIA');
  assert.equal(await storage.exists(env.buckets[0], `${run}-audio-only.mp4`), false);
});

test('parallel duplicate uploads allow exactly one asset', async () => {
  const results = await Promise.all(Array.from({ length: 4 }, () => upload('png', 'parallel-duplicate')));
  assert.deepEqual(results.map((r) => r.status).sort(), [201, 409, 409, 409]);
  assert.equal(await Asset.countDocuments({ key: `${run}-parallel-duplicate.png` }), 1);
});

test('list sorting, pagination, literal search, formats, date ranges, and bucket filters', async () => {
  const [one, two, three] = await Promise.all(['page-a', 'page-b', 'page-c'].map(fresh));
  // createdAt is immutable through normal Mongoose updates; set fixture dates explicitly.
  for (const [asset, date] of [[one, '2024-01-01T00:00:00Z'], [two, '2024-01-02T12:00:00Z'], [three, '2024-01-03T23:59:59Z']]) {
    await Asset.collection.updateOne({ _id: new mongoose.Types.ObjectId(asset.id) }, { $set: { createdAt: new Date(date) } });
  }
  const prefix = `/assets?q=${run}-page-&bucket=${env.buckets[0]}&format=PNG`;
  const page1 = expect(await request(`${prefix}&limit=2&page=1`), 200);
  assert.equal(page1.total, 3);
  assert.equal(page1.totalPages, 2);
  assert.deepEqual(page1.assets.map((asset) => asset.id), [three.id, two.id]);
  const page2 = expect(await request(`${prefix}&limit=2&page=2`), 200);
  assert.deepEqual(page2.assets.map((asset) => asset.id), [one.id]);
  const date = expect(await request(`${prefix}&from=2024-01-02&to=2024-01-03`), 200);
  assert.equal(date.total, 2);
  assert.equal(expect(await request(`/assets?q=${encodeURIComponent('.*')}`), 200).total, 0);
  assert.equal(expect(await request('/assets?page=1000000'), 200).assets.length, 0);
});

for (const query of ['limit=0', 'limit=101', 'limit=1.5', 'limit=abc', 'limit=1&limit=2', 'page=0', 'page=-1', 'page=1000001', 'q=a&q=b', `q=${'a'.repeat(201)}`, 'bucket=unknown', 'format=exe', 'format=constructor', 'format=__proto__', 'from=2026-00-01', 'to=not-a-date', 'from=2026-10-11&to=2026-10-10']) test(`reject list query: ${query.slice(0, 60)}`, async () => {
  const result = await request(`/assets?${query}`);
  assert.equal(result.status, 400, JSON.stringify(result.data));
  assert.ok(result.data.error.code);
});

test('PATCH valid fields, clearing values, dates with timezone, and version preservation', async () => {
  const asset = await fresh('patch');
  const updated = expect(await request(`/assets/${asset.id}`, { method: 'PATCH', json: { altText: 'A caption', tags: ['a', 'b'], expiresAt: '2030-01-01T10:00:00+05:30' } }), 200);
  assert.equal(updated.expiresAt, '2030-01-01T04:30:00.000Z');
  assert.deepEqual(updated.tags, ['a', 'b']);
  assert.equal(updated.version, asset.version);
  const cleared = expect(await request(`/assets/${asset.id}`, { method: 'PATCH', json: { altText: '', tags: [], expiresAt: null } }), 200);
  assert.equal(cleared.altText, '');
  assert.deepEqual(cleared.tags, []);
  assert.equal(cleared.expiresAt, null);
});

for (const body of [{}, [], null, { tags: 'a' }, { tags: [1] }, { tags: [null] }, { tags: [{}] }, { tags: ['a', 1] }, { altText: 1 }, { altText: null }, { expiresAt: '' }, { expiresAt: 0 }, { expiresAt: '2026-02-30' }, { expiresAt: '2026-10-10T24:00:00Z' }, { key: 'changed' }, { bucket: 'prod-assets' }, { version: 10 }, { url: 'https://invalid' }, { unknown: 'x' }, JSON.parse('{"__proto__":{"polluted":true}}')]) test(`reject PATCH body: ${JSON.stringify(body)}`, async () => {
  const asset = await fresh(`patch-invalid-${crypto.randomUUID()}`);
  assert.equal((await request(`/assets/${asset.id}`, { method: 'PATCH', json: body })).status, 400);
  const unchanged = expect(await request(`/assets/${asset.id}`), 200);
  assert.equal(unchanged.version, 1);
  assert.deepEqual(unchanged.tags, []);
  assert.equal({}.polluted, undefined);
});

test('invalid JSON and oversized JSON body use central error envelopes', async () => {
  const asset = await fresh('json-body');
  expect(await request(`/assets/${asset.id}`, { method: 'PATCH', raw: '{invalid' }), 400, 'INVALID_JSON');
  expect(await request(`/assets/${asset.id}`, { method: 'PATCH', json: { altText: 'a'.repeat(130 * 1024) } }), 413, 'BODY_TOO_LARGE');
});

test('replacement keeps identity and metadata, updates bytes, and invalidates every variant', async () => {
  const asset = await fresh('replace');
  await request(`/assets/${asset.id}`, { method: 'PATCH', json: { tags: ['keep'], altText: 'Keep caption' } });
  const oldVariant = await request(`/assets/${asset.id}/optimized?w=20`);
  const replacement = await sharp(contents.png).resize(40, 30).png().toBuffer();
  const result = expect(await request(`/assets/${asset.id}/replace`, { method: 'PUT', file: replacement, name: 'different-name.PNG' }), 200);
  for (const field of ['id', 'bucket', 'key', 'url', 'originalName', 'mimeType', 'thumbnailKey', 'thumbnailUrl', 'createdAt']) assert.equal(result[field], asset[field], field);
  assert.equal(result.width, 40);
  assert.equal(result.height, 30);
  assert.equal(result.version, 2);
  assert.equal(result.altText, 'Keep caption');
  assert.deepEqual(result.tags, ['keep']);
  assert.deepEqual((await request(asset.url)).bytes, replacement);
  expect(await request(oldVariant.headers.get('location')), 404);
  const current = await request(`/assets/${asset.id}/optimized?w=20`);
  assert.match(current.headers.get('location'), /v2-20xauto-q75.webp$/);
});

test('same JPEG MIME with different jpg/jpeg extension is rejected; corrupt replacement preserves bytes', async () => {
  const asset = expect(await upload('jpg', 'strict-extension'), 201);
  expect(await request(`/assets/${asset.id}/replace`, { method: 'PUT', file: contents.jpeg, format: 'jpeg' }), 400, 'FORMAT_MISMATCH');
  expect(await request(`/assets/${asset.id}/replace`, { method: 'PUT', file: Buffer.from('bad'), format: 'jpg' }), 400, 'INVALID_MEDIA');
  assert.deepEqual((await request(asset.url)).bytes, contents.jpg);
  assert.equal(expect(await request(`/assets/${asset.id}`), 200).version, 1);
});

test('parallel replacements advance every version without changing URL', async () => {
  const asset = await fresh('parallel-replace');
  const results = await Promise.all(Array.from({ length: 3 }, (_, index) => request(`/assets/${asset.id}/replace`, { method: 'PUT', file: contents.png, name: `replace-${index}.png` })));
  assert.deepEqual(results.map((result) => expect(result, 200).version).sort(), [2, 3, 4]);
  assert.equal(expect(await request(`/assets/${asset.id}`), 200).url, asset.url);
});

test('parallel optimization generates a cached variant only once', async (t) => {
  const asset = await fresh('parallel-optimize');
  const done = Upload.prototype.done;
  let uploads = 0;
  t.mock.method(Upload.prototype, 'done', function () { uploads += 1; return done.call(this); });
  const responses = await Promise.all(Array.from({ length: 4 }, () => request(`/assets/${asset.id}/optimized?w=25`)));
  for (const response of responses) expect(response, 302);
  assert.equal(new Set(responses.map((response) => response.headers.get('location'))).size, 1);
  assert.equal(uploads, 1);
});

test('optimization racing replacement cannot leave an obsolete version variant', async () => {
  const asset = await fresh('opt-replace-race');
  const responses = await Promise.all([
    request(`/assets/${asset.id}/optimized?w=25`),
    request(`/assets/${asset.id}/replace`, { method: 'PUT', file: contents.png }),
  ]);
  expect(responses[0], 302);
  expect(responses[1], 200);
  const current = await request(`/assets/${asset.id}/optimized?w=25`);
  assert.match(current.headers.get('location'), /v2-25xauto-q75.webp$/);
  assert.equal(await storage.exists(asset.bucket, `variants/${asset.id}/v1-25xauto-q75.webp`), false);
});

test('PATCH racing replacement preserves metadata and increments version', async () => {
  const asset = await fresh('patch-replace-race');
  const responses = await Promise.all([
    request(`/assets/${asset.id}`, { method: 'PATCH', json: { tags: ['concurrent'] } }),
    request(`/assets/${asset.id}/replace`, { method: 'PUT', file: contents.png }),
  ]);
  responses.forEach((response) => expect(response, 200));
  const final = expect(await request(`/assets/${asset.id}`), 200);
  assert.deepEqual(final.tags, ['concurrent']);
  assert.equal(final.version, 2);
});

test('video replacement retains URL and rejects image optimization', async () => {
  const asset = expect(await upload('mp4', 'video-replace'), 201);
  const replaced = expect(await request(`/assets/${asset.id}/replace`, { method: 'PUT', file: contents.mp4, format: 'mp4' }), 200);
  assert.equal(replaced.version, 2);
  assert.equal(replaced.url, asset.url);
  expect(await request(`/assets/${asset.id}/optimized?w=100`), 400, 'IMAGE_REQUIRED');
});

for (const [query, width, height, format] of [['', 80, 60, 'webp'], ['w=1&q=1', 1, 1, 'webp'], ['w=4000&q=100', 4000, 3000, 'webp'], ['h=30', 40, 30, 'webp'], ['w=30&h=30', 30, 23, 'webp'], ['w=20&format=avif', 20, 15, 'heif'], ['w=20&format=jpeg', 20, 15, 'jpeg'], ['w=20&format=png', 20, 15, 'png']]) test(`optimized output dimensions, type and cache: ${query || 'defaults'}`, async () => {
  const asset = await fresh(`opt-${crypto.randomUUID()}`);
  const first = await request(`/assets/${asset.id}/optimized?${query}`);
  expect(first, 302);
  assert.equal(first.headers.get('cache-control'), 'no-store');
  const output = await request(first.headers.get('location'));
  expect(output, 200);
  assert.equal(output.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  const metadata = await sharp(output.bytes).metadata();
  assert.equal(metadata.width, width);
  assert.equal(metadata.height, height);
  assert.equal(metadata.format, format);
  const hit = await request(`/assets/${asset.id}/optimized?${query}`);
  assert.equal(hit.headers.get('location'), first.headers.get('location'));
  assert.equal((await request(hit.headers.get('location'))).headers.get('etag'), output.headers.get('etag'));
});

for (const query of ['w=0', 'w=-1', 'w=4001', 'h=0', 'h=4001', 'w=1.5', 'w=abc', 'w=', 'w=1&w=2', 'q=0', 'q=101', 'q=1.5', 'q=75&q=80', 'format=gif', 'format=WEBP', 'format=webp&format=png']) test(`reject optimized query: ${query}`, async () => {
  const asset = await fresh(`bad-opt-${crypto.randomUUID()}`);
  expect(await request(`/assets/${asset.id}/optimized?${query}`), 400, 'INVALID_QUERY');
});

for (const id of ['bad', '123', '000000000000000000000000']) test(`missing asset behavior for all endpoints: ${id}`, async () => {
  for (const endpoint of [`/assets/${id}`, `/assets/${id}/optimized`]) expect(await request(endpoint), 404, 'ASSET_NOT_FOUND');
  expect(await request(`/assets/${id}`, { method: 'PATCH', json: { tags: [] } }), 404, 'ASSET_NOT_FOUND');
  expect(await request(`/assets/${id}`, { method: 'DELETE' }), 404, 'ASSET_NOT_FOUND');
  expect(await request(`/assets/${id}/replace`, { method: 'PUT', file: contents.png }), 404, 'ASSET_NOT_FOUND');
});

test('database create failure rolls back original and thumbnail, with safe error response', async (t) => {
  t.mock.method(console, 'error', () => {});
  t.mock.method(Asset, 'create', async () => { throw new Error('private DB details'); });
  expect(await upload('png', 'db-fail'), 500, 'INTERNAL_ERROR');
  assert.equal(await storage.exists(env.buckets[0], `${run}-db-fail.png`), false);
  assert.equal(await storage.exists(env.buckets[0], `thumbs/${run}-db-fail.png.webp`), false);
});

test('thumbnail storage failure rolls back the original upload', async (t) => {
  t.mock.method(console, 'error', () => {});
  const done = Upload.prototype.done;
  let calls = 0;
  t.mock.method(Upload.prototype, 'done', function () { if (++calls === 2) return Promise.reject(new Error('thumbnail failure')); return done.call(this); });
  expect(await upload('png', 'thumbnail-fail'), 502, 'STORAGE_ERROR');
  assert.equal(await storage.exists(env.buckets[0], `${run}-thumbnail-fail.png`), false);
});

for (const failure of ['thumbnail', 'database', 'variant-cleanup']) test(`replacement rollback restores previous original and thumbnail after ${failure} failure`, async (t) => {
  const asset = await fresh(`rollback-${failure}`);
  const thumbnail = (await request(asset.thumbnailUrl)).bytes;
  t.mock.method(console, 'error', () => {});
  if (failure === 'database') t.mock.method(Asset.prototype, 'save', async () => { throw new Error('save failure'); });
  else if (failure === 'thumbnail') {
    const done = Upload.prototype.done;
    let calls = 0;
    t.mock.method(Upload.prototype, 'done', function () { if (++calls === 2) return Promise.reject(new Error('thumbnail failure')); return done.call(this); });
  } else {
    const send = s3.send;
    let failed = false;
    t.mock.method(s3, 'send', function (command, ...args) {
      if (command.constructor.name === 'ListObjectsV2Command' && !failed) { failed = true; return Promise.reject(new Error('cleanup failure')); }
      return send.call(this, command, ...args);
    });
  }
  const replacement = await sharp(contents.png).resize(40).png().toBuffer();
  const result = await request(`/assets/${asset.id}/replace`, { method: 'PUT', file: replacement });
  expect(result, failure === 'database' ? 500 : 502, failure === 'database' ? 'INTERNAL_ERROR' : 'STORAGE_ERROR');
  assert.deepEqual((await request(asset.url)).bytes, contents.png);
  assert.deepEqual((await request(asset.thumbnailUrl)).bytes, thumbnail);
  assert.equal(expect(await request(`/assets/${asset.id}`), 200).version, 1);
});

test('storage permission errors on optimized HEAD are 502, not a false cache miss', async (t) => {
  const asset = await fresh('head-failure');
  t.mock.method(console, 'error', () => {});
  const send = s3.send;
  t.mock.method(s3, 'send', function (command, ...args) {
    if (command.constructor.name === 'HeadObjectCommand') return Promise.reject(Object.assign(new Error('AccessDenied private detail'), { name: 'AccessDenied', $metadata: { httpStatusCode: 403 } }));
    return send.call(this, command, ...args);
  });
  expect(await request(`/assets/${asset.id}/optimized?w=30`), 502, 'STORAGE_ERROR');
});

test('partial delete failure retains the DB record and a retry finishes cleanup', async (t) => {
  const asset = await fresh('delete-retry');
  const variant = await request(`/assets/${asset.id}/optimized?w=30`);
  t.mock.method(console, 'error', () => {});
  const send = s3.send;
  let deletes = 0;
  t.mock.method(s3, 'send', function (command, ...args) {
    if (command.constructor.name === 'DeleteObjectCommand' && ++deletes === 2) return Promise.reject(new Error('transient failure'));
    return send.call(this, command, ...args);
  });
  expect(await request(`/assets/${asset.id}`, { method: 'DELETE' }), 502, 'STORAGE_ERROR');
  assert.ok(await Asset.findById(asset.id));
  expect(await request(`/assets/${asset.id}`, { method: 'DELETE' }), 204);
  expect(await request(`/assets/${asset.id}`), 404, 'ASSET_NOT_FOUND');
  expect(await request(asset.url), 404);
  expect(await request(asset.thumbnailUrl), 404);
  expect(await request(variant.headers.get('location')), 404);
  expect(await request(`/assets/${asset.id}`, { method: 'DELETE' }), 404, 'ASSET_NOT_FOUND');
});

test('health reports unavailable when database disconnects, then recovers', async () => {
  await disconnectDb();
  expect(await request('/api/health'), 503);
  await connectDb();
  expect(await request('/api/health'), 200);
});

async function waitForVariant(id, key) {
  for (let attempt = 0; attempt < 150; attempt++) {
    const asset = expect(await request(`/assets/${id}`), 200);
    const variant = asset.variants.find((item) => item.key === key);
    if (variant && ['ready', 'failed'].includes(variant.status)) return variant;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Video job did not finish');
}

test('transcode validation rejects images, missing assets, unsupported options, and protected fields', async () => {
  const image = await fresh('video-options-image');
  expect(await request(`/assets/${image.id}/transcode`, { method: 'POST', json: {} }), 400, 'VIDEO_REQUIRED');
  expect(await request('/assets/not-an-id/transcode', { method: 'POST', json: {} }), 404, 'ASSET_NOT_FOUND');
  const video = expect(await upload('mp4', 'video-options'), 201);
  for (const json of [{ codec: 'hevc' }, { codec: '__proto__' }, { resolution: 600 }, { resolution: '720' }, { bitrate: 0 }, { crf: 100 }, { key: 'overwrite.mp4' }, []]) {
    expect(await request(`/assets/${video.id}/transcode`, { method: 'POST', json }), 400, 'INVALID_VIDEO_OPTIONS');
  }
});

for (const codec of ['h264', 'vp9']) test(`video ${codec}: async job, duplicate reuse, real bytes, no upscale, cache, PATCH, replace and cleanup`, async () => {
  const asset = expect(await upload('mp4', `transcode-${codec}`), 201);
  const options = { codec, resolution: 480, bitrate: 500, crf: 32 };
  const endpoint = `/assets/${asset.id}/transcode`;
  const initial = expect(await request(endpoint, { method: 'POST', json: options }), 202).variant;
  assert.match(initial.key, new RegExp(`variants/${asset.id}/v1-480p-${codec}-b500-crf32`));
  const repeated = await request(endpoint, { method: 'POST', json: options });
  assert.ok([200, 202].includes(repeated.status));
  assert.equal(repeated.data.variant.key, initial.key);
  const ready = await waitForVariant(asset.id, initial.key);
  assert.equal(ready.status, 'ready', ready.error);
  assert.equal(ready.codec, codec);
  assert.equal(ready.width, 80);
  assert.equal(ready.height, 60);
  assert.ok(ready.measuredBitrate > 0 && ready.size > 0 && ready.etag);
  const result = expect(await request(`/assets/${asset.id}`), 200);
  assert.equal(result.variants.length, 1);
  assert.equal(result.version, 1);
  assert.equal(result.size, asset.size);
  assert.deepEqual((await request(asset.url)).bytes, contents.mp4);
  const publicFile = await request(ready.url);
  expect(publicFile, 200);
  assert.equal(publicFile.bytes.length, ready.size);
  assert.equal(publicFile.headers.get('content-type'), ready.mimeType);
  assert.equal(publicFile.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  const outputPath = path.join(directory, `verified-${codec}.${ready.format}`);
  await writeFile(outputPath, publicFile.bytes);
  const measured = await (await import('../src/services/video.service.js')).videoMetadata(outputPath, ready.format);
  assert.equal(measured.videoCodec, codec);
  assert.equal(measured.audioCodec, null);
  expect(await request(endpoint, { method: 'POST', json: options }), 200);
  const patched = expect(await request(`/assets/${asset.id}`, { method: 'PATCH', json: { altText: 'video description', tags: ['video', 'optimized'], expiresAt: '2027-01-01' } }), 200);
  assert.equal(patched.variants[0].key, ready.key);
  await storage.deleteObject(asset.bucket, ready.key);
  expect(await request(endpoint, { method: 'POST', json: options }), 202);
  assert.equal((await waitForVariant(asset.id, ready.key)).status, 'ready');
  const replaced = expect(await request(`/assets/${asset.id}/replace`, { method: 'PUT', file: contents.mp4, format: 'mp4' }), 200);
  assert.equal(replaced.version, 2);
  assert.deepEqual(replaced.variants, []);
  assert.equal(replaced.altText, 'video description');
  assert.equal(replaced.url, asset.url);
  expect(await request(ready.url), 404);
  const next = expect(await request(endpoint, { method: 'POST', json: options }), 202).variant;
  assert.match(next.key, /\/v2-/);
  assert.equal((await waitForVariant(asset.id, next.key)).status, 'ready');
  expect(await request(`/assets/${asset.id}`, { method: 'DELETE' }), 204);
  expect(await request(next.url), 404);
});

test('failed video storage upload persists a safe failure and can be retried', async (t) => {
  const asset = expect(await upload('mp4', 'transcode-failure'), 201);
  t.mock.method(console, 'error', () => {});
  const mocked = t.mock.method(Upload.prototype, 'done', () => Promise.reject(new Error('private storage error')));
  const initial = expect(await request(`/assets/${asset.id}/transcode`, { method: 'POST', json: {} }), 202).variant;
  const failed = await waitForVariant(asset.id, initial.key);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error.includes('private'), false);
  assert.equal(await storage.exists(asset.bucket, initial.key), false);
  mocked.mock.restore();
  expect(await request(`/assets/${asset.id}/transcode`, { method: 'POST', json: {} }), 202);
  assert.equal((await waitForVariant(asset.id, initial.key)).status, 'ready');
});

test('interrupted video jobs become retryable after restart recovery', async () => {
  const asset = expect(await upload('mp4', 'transcode-restart'), 201);
  await Asset.updateOne({ _id: asset.id }, { $push: { variants: { key: `variants/${asset.id}/interrupted.mp4`, url: 'http://example.test/interrupted.mp4', version: 1, status: 'processing', codec: 'h264', format: 'mp4', mimeType: 'video/mp4' } } });
  await recoverVideoJobs();
  const recovered = expect(await request(`/assets/${asset.id}`), 200).variants[0];
  assert.equal(recovered.status, 'failed');
  assert.match(recovered.error, /restart/);
});

test('temporary media files are cleaned after success and every exercised failure', async () => {
  await waitForVideoJobs();
  await new Promise((resolve) => setTimeout(resolve, 100));
  const leftovers = (await readdir(os.tmpdir())).filter((name) => name.startsWith('cms-') && !initialTemps.has(name));
  assert.deepEqual(leftovers, []);
});
