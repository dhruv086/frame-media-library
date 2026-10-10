import { createReadStream } from 'node:fs';
import { Asset } from '../models/Asset.js';
import { AppError } from '../utils/AppError.js';
import { withLock } from '../utils/locks.js';
import * as storage from './storage.service.js';
import { withTranscodedVideo } from './video.service.js';

const queue = [];
const keys = new Set();
let running = false;
const assetLock = (job) => `${job.bucket}/${job.originalKey}`;
const currentVariant = (asset, job) => asset?.version === job.version && asset.variants.find((variant) => variant.key === job.key);

/** Determine whether a persisted queued variant is being handled by this process. */
export function videoJobActive(key) { return keys.has(key); }

/** Reserve bounded queue capacity, persist the job, and process it outside the HTTP request. */
export async function enqueueVideoJob(job, persist) {
  if (keys.size >= 10) throw new AppError(429, 'PROCESSING_BUSY', 'The video processing queue is full. Please try again later.');
  keys.add(job.key);
  try { await persist(); }
  catch (error) { keys.delete(job.key); throw error; }
  queue.push(job);
  void drain();
}

async function processJob(job) {
  const prepared = await withLock(assetLock(job), async () => {
    const asset = await Asset.findById(job.id);
    const variant = currentVariant(asset, job);
    if (!variant) return null;
    variant.status = 'processing';
    await asset.save();
    return { source: { width: asset.width, height: asset.height }, bytes: await storage.getObject(asset.bucket, asset.key) };
  });
  if (!prepared) return;
  await withTranscodedVideo(prepared.bytes, prepared.source, job.options, async ({ path, ...metadata }) => {
    await withLock(assetLock(job), async () => {
      const asset = await Asset.findById(job.id);
      const variant = currentVariant(asset, job);
      // Replacement/deletion during encoding invalidates the result before upload.
      if (!variant) return;
      try {
        const { etag } = await storage.putObject(asset.bucket, job.key, createReadStream(path), variant.mimeType, 'public, max-age=31536000, immutable');
        Object.assign(variant, metadata, { status: 'ready', etag, error: null });
        await asset.save();
      } catch (error) {
        try { await storage.deleteObject(job.bucket, job.key); }
        catch (cleanupError) { console.error('Video variant rollback failed:', cleanupError); }
        throw error;
      }
    });
  });
}

async function drain() {
  if (running) return;
  running = true;
  try {
    while (queue.length) {
      const job = queue.shift();
      try { await processJob(job); }
      catch (error) {
        console.error('Video processing failed:', error);
        try {
          await withLock(assetLock(job), async () => {
            const asset = await Asset.findById(job.id);
            const variant = currentVariant(asset, job);
            if (!variant) return;
            variant.status = 'failed';
            variant.error = error instanceof AppError ? error.message : 'Video processing failed. Please retry.';
            await asset.save();
          });
        } catch (saveError) { console.error('Could not save video failure status:', saveError); }
      } finally { keys.delete(job.key); }
    }
  } finally { running = false; }
}

/** Mark interrupted jobs retryable after a process restart; ready variants are retained. */
export async function recoverVideoJobs() {
  await Asset.updateMany({ 'variants.status': { $in: ['queued', 'processing'] } },
    { $set: { 'variants.$[job].status': 'failed', 'variants.$[job].error': 'Processing was interrupted by a server restart. Please retry.' } },
    { arrayFilters: [{ 'job.status': { $in: ['queued', 'processing'] } }] });
}

/** Wait for this process's jobs before test database/storage teardown. */
export async function waitForVideoJobs() {
  while (keys.size) await new Promise((resolve) => setTimeout(resolve, 20));
}
