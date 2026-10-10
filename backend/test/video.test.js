import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, access } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import ffmpegPath from 'ffmpeg-static';
import { validateVideoOptions } from '../src/utils/validators.js';
import { videoMetadata, withTranscodedVideo } from '../src/services/video.service.js';
import { enqueueVideoJob, videoJobActive } from '../src/services/video-jobs.service.js';

const exec = promisify(execFile);

test('video settings have explicit defaults and reject invalid types, ranges, codecs, and extra fields', () => {
  assert.deepEqual(validateVideoOptions(), { resolution: 720, bitrate: 2500, codec: 'h264', crf: 28 });
  for (const body of [null, [], { resolution: '720' }, { resolution: 600 }, { bitrate: 99 }, { bitrate: 20001 }, { bitrate: 1.5 }, { bitrate: null }, { codec: 'hevc' }, { codec: '__proto__' }, { codec: null }, { crf: 17 }, { crf: 41 }, { command: '-evil' }]) {
    assert.throws(() => validateVideoOptions(body), (error) => error.status === 400 && error.code === 'INVALID_VIDEO_OPTIONS');
  }
});

test('video queue rejects excess work and releases reservations when persistence fails', async () => {
  const release = [];
  const jobKeys = Array.from({ length: 10 }, (_, index) => `queue-capacity-${index}`);
  const pending = jobKeys.map((key) => enqueueVideoJob({ key }, () => new Promise((resolve, reject) => release.push(reject))));
  const settled = Promise.allSettled(pending);
  try {
    assert.ok(jobKeys.every(videoJobActive));
    await assert.rejects(enqueueVideoJob({ key: 'over-capacity' }, () => assert.fail('Full queue must not persist a job')),
      (error) => error.status === 429 && error.code === 'PROCESSING_BUSY');
    assert.equal(videoJobActive('over-capacity'), false);
  } finally {
    release.forEach((reject) => reject(new Error('Injected persistence failure')));
    assert.ok((await settled).every((result) => result.status === 'rejected'));
  }
  assert.ok(jobKeys.every((key) => !videoJobActive(key)));
});

for (const codec of ['h264', 'vp9']) test(`real ${codec} encoding: bounded resolution, audio conversion, measured output, and temp cleanup`, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'video-fixture-'));
  let generated;
  try {
    const input = path.join(directory, 'input.mp4');
    await exec(ffmpegPath, ['-y', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=10', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '0.8', '-c:v', 'libx264', '-crf', '10', '-c:a', 'aac', '-pix_fmt', 'yuv420p', input], { windowsHide: true });
    const source = await videoMetadata(input, 'mp4');
    await withTranscodedVideo(await readFile(input), source, { resolution: 480, bitrate: 500, codec, crf: 32 }, async (output) => {
      generated = output.path;
      assert.equal(output.videoCodec, codec);
      assert.equal(output.audioCodec, codec === 'h264' ? 'aac' : 'opus');
      assert.ok(output.width <= 854 && output.height <= 480);
      assert.equal(output.width % 2, 0);
      assert.equal(output.height % 2, 0);
      assert.ok(output.duration > 0 && output.size > 0 && output.measuredBitrate > 0);
      const bytes = await readFile(output.path);
      assert.equal(bytes.length, output.size);
      if (codec === 'h264') assert.ok(bytes.indexOf(Buffer.from('moov')) < bytes.indexOf(Buffer.from('mdat')), 'MP4 metadata precedes video bytes for fast start');
    });
    await assert.rejects(access(generated));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('silent video stays small and temporary output is removed after a consumer failure', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'video-fixture-'));
  let generated;
  try {
    const input = path.join(directory, 'input.mp4');
    await exec(ffmpegPath, ['-y', '-f', 'lavfi', '-i', 'testsrc2=size=96x64:rate=10', '-t', '0.3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', input], { windowsHide: true });
    const source = await videoMetadata(input, 'mp4');
    await assert.rejects(withTranscodedVideo(await readFile(input), source, { resolution: 1080, bitrate: 2500, codec: 'h264', crf: 28 }, async (output) => {
      generated = output.path;
      assert.equal(output.width, 96);
      assert.equal(output.height, 64);
      assert.equal(output.audioCodec, null);
      throw new Error('Injected upload failure');
    }), /Injected upload failure/);
    await assert.rejects(access(generated));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
