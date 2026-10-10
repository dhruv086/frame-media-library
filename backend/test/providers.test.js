import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const cwd = fileURLToPath(new URL('../', import.meta.url));
const bucket = 'cms-provider-test';
const script = `
  import { Readable } from 'node:stream';
  import { s3 } from './src/config/s3.js';
  import { headObject, publicUrl } from './src/services/storage.service.js';
  let captured;
  s3.config.requestHandler.handle = async (request) => {
    captured = { method: request.method, hostname: request.hostname, path: request.path,
      protocol: request.protocol, authorization: request.headers.authorization };
    return { response: { statusCode: 200, headers: { 'content-length': '123', etag: '"test"' }, body: Readable.from([]) } };
  };
  const head = await headObject('${bucket}', 'folder/a b.png');
  console.log(JSON.stringify({ request: captured, publicUrl: publicUrl('${bucket}', 'folder/a b.png'),
    credentials: await s3.config.credentials(), region: await s3.config.region(),
    forcePathStyle: s3.config.forcePathStyle, checksum: await s3.config.requestChecksumCalculation(),
    contentLength: head.ContentLength }));
`;

const profiles = [
  { name: 'AWS S3', endpoint: '', region: 'us-west-2', host: `${bucket}.s3.us-west-2.amazonaws.com`, pathname: '/folder/a%20b.png', forcePathStyle: false, publicBase: 'https://cdn.example.com' },
  { name: 'Cloudflare R2', endpoint: 'https://test-account.r2.cloudflarestorage.com', region: 'auto', host: 'test-account.r2.cloudflarestorage.com', pathname: `/${bucket}/folder/a%20b.png`, forcePathStyle: true, publicBase: 'https://assets.example.com' },
  { name: 'MinIO', endpoint: 'http://localhost:9000', region: 'us-east-1', host: 'localhost', pathname: `/${bucket}/folder/a%20b.png`, forcePathStyle: true, publicBase: `http://localhost:9000/${bucket}` },
];

for (const profile of profiles) test(`${profile.name}: SDK endpoint, signing region, explicit credentials, and public URL (offline)`, async () => {
  const { stdout } = await exec(process.execPath, ['--input-type=module', '-e', script], {
    cwd,
    windowsHide: true,
    env: { ...process.env, S3_ENDPOINT: profile.endpoint, S3_REGION: profile.region,
      S3_ACCESS_KEY: 'TEST_ACCESS_KEY', S3_SECRET_KEY: 'TEST_SECRET_KEY',
      AWS_ACCESS_KEY_ID: 'IGNORED_DEFAULT_KEY', AWS_SECRET_ACCESS_KEY: 'IGNORED_DEFAULT_SECRET',
      BUCKETS: bucket, BUCKET_PUBLIC_URLS: `${bucket}=${profile.publicBase}`, MONGO_URI: 'mongodb://localhost:27017/cms' },
  });
  const result = JSON.parse(stdout.trim());
  assert.equal(result.request.method, 'HEAD');
  assert.equal(result.request.hostname, profile.host);
  assert.equal(result.request.path, profile.pathname);
  assert.equal(result.region, profile.region);
  assert.equal(result.forcePathStyle, profile.forcePathStyle);
  assert.equal(result.credentials.accessKeyId, 'TEST_ACCESS_KEY');
  assert.equal(result.credentials.secretAccessKey, 'TEST_SECRET_KEY');
  assert.match(result.request.authorization, new RegExp(`Credential=TEST_ACCESS_KEY/\\d{8}/${profile.region}/s3/aws4_request`));
  assert.equal(result.checksum, 'WHEN_REQUIRED');
  assert.equal(result.publicUrl, `${profile.publicBase}/folder/a%20b.png`);
  assert.equal(result.contentLength, 123);
});
