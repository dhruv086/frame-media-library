import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import ffmpegPath from 'ffmpeg-static';
import { env } from '../src/config/env.js';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('../.runtime/', import.meta.url));
await mkdir(root, { recursive: true });
const directory = await mkdtemp(path.join(root, 'smoke-'));
const base = process.env.TEST_BASE_URL || `http://localhost:${env.port}`;
const bucket = env.buckets[0];
const run = `smoke-${Date.now()}`;
const created = new Set();
let passed = 0;

async function curl(endpoint, { method = 'GET', form, json, raw, headers = {}, head = false } = {}) {
  const headerFile = path.join(directory, `headers-${crypto.randomUUID()}.txt`);
  const args = ['--silent', '--show-error', '--max-time', '60', '--dump-header', headerFile, '--write-out', '\n%{http_code}'];
  if (head) args.push('--head');
  else args.push('--request', method);
  for (const [key, value] of Object.entries(headers)) args.push('--header', `${key}: ${value}`);
  for (const field of form || []) args.push('--form', field);
  if (json !== undefined || raw !== undefined) {
    const bodyFile = path.join(directory, `body-${crypto.randomUUID()}.json`);
    await writeFile(bodyFile, raw ?? JSON.stringify(json));
    args.push('--header', 'Content-Type: application/json', '--data-binary', `@${bodyFile}`);
  }
  args.push(endpoint.startsWith('http') ? endpoint : `${base}${endpoint}`);
  const { stdout } = await exec(process.platform === 'win32' ? 'curl.exe' : 'curl', args, { maxBuffer: 8 * 1024 * 1024, windowsHide: true });
  const separator = stdout.lastIndexOf('\n');
  const body = stdout.slice(0, separator);
  const headerText = await readFile(headerFile, 'utf8');
  const responseHeaders = Object.fromEntries(headerText.split(/\r?\n/).filter((line) => line.includes(':')).map((line) => {
    const index = line.indexOf(':');
    return [line.slice(0, index).toLowerCase(), line.slice(index + 1).trim()];
  }));
  let data;
  try { data = JSON.parse(body); } catch { data = body; }
  return { status: Number(stdout.slice(separator + 1)), data, headers: responseHeaders };
}

function check(label, result, status, code) {
  assert.equal(result.status, status, `${label}: ${JSON.stringify(result.data)}`);
  if (code) assert.equal(result.data.error.code, code, label);
  passed += 1;
  console.log(`PASS ${label} (${status})`);
  return result.data;
}

async function upload(file, mime, filename, targetBucket = bucket) {
  const response = await curl('/assets', { method: 'POST', form: [`bucket=${targetBucket}`, `file=@${file};type=${mime};filename=${filename}`] });
  if (response.status === 201) created.add(response.data.id);
  return response;
}

try {
  const png = path.join(directory, 'original.png');
  const replacement = path.join(directory, 'replacement.png');
  const jpeg = path.join(directory, 'wrong.jpg');
  const video = path.join(directory, 'sample.mp4');
  const short = path.join(directory, 'short.mp4');
  const invalid = path.join(directory, 'invalid.exe');
  await sharp({ create: { width: 800, height: 600, channels: 3, background: '#1254a5' } }).png().toFile(png);
  await sharp({ create: { width: 640, height: 480, channels: 3, background: '#c34b21' } }).png().toFile(replacement);
  await sharp(png).jpeg().toFile(jpeg);
  await writeFile(invalid, 'not media');
  for (const [output, duration] of [[video, '2'], [short, '0.4']]) {
    await exec(ffmpegPath, ['-y', '-f', 'lavfi', '-i', 'color=c=blue:s=320x240:r=25', '-t', duration, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', output], { windowsHide: true });
  }
  check('health', await curl('/api/health'), 200);
  check('buckets', await curl('/buckets'), 200);
  const image = check('upload PNG', await upload(png, 'image/png', `${run} My Photo.PNG`), 201);
  assert.equal(image.key, `${run}-my-photo.png`);
  assert.equal(image.width, 800);
  assert.equal(image.height, 600);
  assert.equal(image.version, 1);
  check('original public URL', await curl(image.url, { head: true }), 200);
  check('image thumbnail', await curl(image.thumbnailUrl, { head: true }), 200);
  const movie = check('upload MP4', await upload(video, 'video/mp4', `${run}.mp4`), 201);
  assert.equal(movie.width, 320);
  assert.equal(movie.height, 240);
  assert.ok(movie.duration >= 1.9);
  check('video thumbnail', await curl(movie.thumbnailUrl, { head: true }), 200);
  check('short video thumbnail at 0s', await upload(short, 'video/mp4', `${run}-short.mp4`), 201);
  check('duplicate', await upload(png, 'image/png', `${run} My Photo.PNG`), 409, 'DUPLICATE');
  check('EXE rejected', await upload(invalid, 'application/octet-stream', `${run}.exe`), 400, 'INVALID_FILE_TYPE');
  check('MIME mismatch rejected', await upload(png, 'video/mp4', `${run}.png`), 400, 'INVALID_FILE_TYPE');
  check('invalid bucket', await upload(png, 'image/png', `${run}.png`, 'invalid-bucket'), 400, 'INVALID_BUCKET');
  check('missing file', await curl('/assets', { method: 'POST', form: [`bucket=${bucket}`] }), 400, 'FILE_REQUIRED');
  check('corrupt image rollback', await upload(invalid, 'image/png', `${run}-corrupt.png`), 400, 'INVALID_MEDIA');
  check('rolled-back original absent', await curl(`${env.bucketPublicUrls[bucket]}/${run}-corrupt.png`, { head: true }), 404);
  const optimized1 = await curl(`/assets/${image.id}/optimized?w=200&h=200&q=80`);
  check('optimized redirect', optimized1, 302);
  assert.ok(optimized1.headers.location.includes(`v1-200x200-q80.webp`));
  const variant1 = check('optimized object public', await curl(optimized1.headers.location, { head: true }), 200);
  const beforeHead = await curl(optimized1.headers.location, { head: true });
  assert.equal(beforeHead.headers['cache-control'], 'public, max-age=31536000, immutable');
  const cached = await curl(`/assets/${image.id}/optimized?w=200&h=200&q=80`);
  check('optimized cache hit', cached, 302);
  assert.equal(cached.headers.location, optimized1.headers.location);
  check('replace wrong format', await curl(`/assets/${image.id}/replace`, { method: 'PUT', form: [`file=@${jpeg};type=image/jpeg`] }), 400, 'FORMAT_MISMATCH');
  const replaced = check('replace same format', await curl(`/assets/${image.id}/replace`, { method: 'PUT', form: [`file=@${replacement};type=image/png`] }), 200);
  assert.equal(replaced.version, 2);
  assert.equal(replaced.url, image.url);
  assert.equal(replaced.key, image.key);
  assert.equal(replaced.width, 640);
  assert.equal(replaced.height, 480);
  check('old variants deleted', await curl(optimized1.headers.location, { head: true }), 404);
  const optimized2 = await curl(`/assets/${image.id}/optimized?w=200`);
  check('version 2 optimized redirect', optimized2, 302);
  assert.ok(optimized2.headers.location.includes('v2-200xauto-q75.webp'));
  for (const format of ['avif', 'jpeg', 'png']) {
    const response = await curl(`/assets/${image.id}/optimized?w=120&format=${format}`);
    check(`optimized ${format}`, response, 302);
    check(`optimized ${format} public`, await curl(response.headers.location, { head: true }), 200);
  }
  const search = check('case-insensitive search', await curl(`/assets?q=${encodeURIComponent(`${run} MY PHOTO`)}&bucket=${bucket}&format=png&limit=1`), 200);
  assert.equal(search.total, 1);
  assert.equal(search.assets[0].id, image.id);
  assert.equal(search.limit, 1);
  const patch = check('patch metadata', await curl(`/assets/${image.id}`, { method: 'PATCH', json: { tags: ['hero', 'blue'], altText: 'A blue test image', expiresAt: '2030-01-01T00:00:00Z' } }), 200);
  assert.deepEqual(patch.tags, ['hero', 'blue']);
  assert.equal(patch.expiresAt, '2030-01-01T00:00:00.000Z');
  const clear = check('clear expiry', await curl(`/assets/${image.id}`, { method: 'PATCH', json: { expiresAt: null } }), 200);
  assert.equal(clear.expiresAt, null);
  check('invalid tags', await curl(`/assets/${image.id}`, { method: 'PATCH', json: { tags: [3] } }), 400, 'INVALID_TAGS');
  check('invalid calendar date', await curl(`/assets/${image.id}`, { method: 'PATCH', json: { expiresAt: '2026-02-30' } }), 400, 'INVALID_DATE');
  check('malformed JSON', await curl(`/assets/${image.id}`, { method: 'PATCH', raw: '{broken' }), 400, 'INVALID_JSON');
  check('invalid optimized width', await curl(`/assets/${image.id}/optimized?w=4001`), 400, 'INVALID_QUERY');
  check('video optimization rejected', await curl(`/assets/${movie.id}/optimized?w=200`), 400, 'IMAGE_REQUIRED');
  check('invalid id', await curl('/assets/invalid'), 404, 'ASSET_NOT_FOUND');
  check('invalid date filter', await curl('/assets?from=2026-13-01'), 400, 'INVALID_DATE');
  check('invalid pagination', await curl('/assets?limit=0'), 400, 'INVALID_QUERY');
  const large = path.join(directory, 'multipart.png');
  await writeFile(large, Buffer.concat([await readFile(png), Buffer.alloc(9 * 1024 * 1024)]));
  const multipart = check('automatic multipart upload', await upload(large, 'image/png', `${run}-multipart.png`), 201);
  assert.ok(multipart.size > 8 * 1024 * 1024);
  assert.match(multipart.etag, /-\d+"?$/);
  for (const id of [...created]) {
    check('delete asset', await curl(`/assets/${id}`, { method: 'DELETE' }), 204);
    created.delete(id);
    check('deleted record missing', await curl(`/assets/${id}`), 404, 'ASSET_NOT_FOUND');
  }
  check('original removed', await curl(image.url, { head: true }), 404);
  check('thumbnail removed', await curl(image.thumbnailUrl, { head: true }), 404);
  check('variants removed', await curl(optimized2.headers.location, { head: true }), 404);
  console.log(`\n${passed} curl integration checks passed.`);
} finally {
  for (const id of created) await curl(`/assets/${id}`, { method: 'DELETE' }).catch((error) => console.error('Test asset cleanup failed:', error.message));
  await rm(directory, { recursive: true, force: true });
}
