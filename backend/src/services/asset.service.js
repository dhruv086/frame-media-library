import { createReadStream } from 'node:fs';
import { Asset } from '../models/Asset.js';
import { AppError } from '../utils/AppError.js';
import { escapeRegex, extension, fileTypes, parseDate, parseInteger, sanitizeFilename, validateBucket, validateId, validatePatch, validateVideoOptions } from '../utils/validators.js';
import { withLock } from '../utils/locks.js';
import * as storage from './storage.service.js';
import { imageMetadata, imageThumbnail, optimizeImage } from './image.service.js';
import { videoMetadata, videoThumbnail } from './video.service.js';
import { enqueueVideoJob, videoJobActive } from './video-jobs.service.js';

const originalCache = 'public, max-age=300';
const variantCache = 'public, max-age=31536000, immutable';
const duplicate = () => new AppError(409, 'DUPLICATE', 'An asset with this filename already exists in this bucket. Use Replace to update it.');
const lockKey = (asset) => `${asset.bucket}/${asset.key}`;

async function mediaData(file, format) {
  const image = file.mimetype.startsWith('image/');
  const metadata = image ? await imageMetadata(file.path, format) : await videoMetadata(file.path, format);
  const thumbnail = image ? await imageThumbnail(file.path) : await videoThumbnail(file.path, metadata.duration);
  return { ...metadata, thumbnail, thumbnailFormat: image ? 'webp' : 'jpg', thumbnailMime: image ? 'image/webp' : 'image/jpeg' };
}

async function cleanObjects(bucket, keys) {
  const results = await Promise.allSettled(keys.map((key) => storage.deleteObject(bucket, key)));
  for (const result of results) if (result.status === 'rejected') console.error('Upload rollback failed:', result.reason);
}

/** Find an asset, returning a consistent 404 for malformed or missing IDs. */
export async function getAsset(id) {
  validateId(id);
  const asset = await Asset.findById(id);
  if (!asset) throw new AppError(404, 'ASSET_NOT_FOUND', 'Asset not found.');
  return asset;
}

/** Upload an original and thumbnail, rolling back storage if processing or persistence fails. */
export async function createAsset(bucket, file) {
  validateBucket(bucket);
  const key = sanitizeFilename(file.originalname);
  return withLock(`${bucket}/${key}`, async () => {
    if (await Asset.exists({ bucket, key }) || await storage.exists(bucket, key)) throw duplicate();
    const uploaded = [];
    try {
      uploaded.push(key);
      const { etag } = await storage.putObject(bucket, key, createReadStream(file.path), file.mimetype, originalCache);
      const { thumbnail, thumbnailFormat, thumbnailMime, ...metadata } = await mediaData(file, extension(file.originalname));
      const thumbnailKey = `thumbs/${key}.${thumbnailFormat}`;
      uploaded.push(thumbnailKey);
      await storage.putObject(bucket, thumbnailKey, thumbnail, thumbnailMime, originalCache);
      return await Asset.create({ bucket, key, originalName: file.originalname, format: extension(file.originalname), mimeType: file.mimetype,
        size: file.size, ...metadata, url: storage.publicUrl(bucket, key), thumbnailKey,
        thumbnailUrl: storage.publicUrl(bucket, thumbnailKey), etag });
    } catch (error) { await cleanObjects(bucket, uploaded); throw error; }
  });
}

/** Replace bytes at the exact same URL, invalidating variants and advancing the version. */
export async function replaceAsset(id, file) {
  const initial = await getAsset(id);
  return withLock(lockKey(initial), async () => {
    const asset = await getAsset(id);
    if (extension(file.originalname) !== asset.format || file.mimetype !== asset.mimeType) {
      throw new AppError(400, 'FORMAT_MISMATCH', `The format must stay the same: upload a .${asset.format} file with MIME type ${asset.mimeType}.`);
    }
    const { thumbnail, thumbnailMime, thumbnailFormat: _format, ...metadata } = await mediaData(file, asset.format);
    // Preserve old bytes so a failed replacement leaves the prior asset usable.
    const [oldOriginal, oldThumbnail] = await Promise.all([storage.getObject(asset.bucket, asset.key), storage.getObject(asset.bucket, asset.thumbnailKey)]);
    let changed = false;
    try {
      changed = true;
      const { etag } = await storage.putObject(asset.bucket, asset.key, createReadStream(file.path), asset.mimeType, originalCache);
      await storage.putObject(asset.bucket, asset.thumbnailKey, thumbnail, thumbnailMime, originalCache);
      await storage.deletePrefix(asset.bucket, `variants/${asset.id}/`);
      Object.assign(asset, metadata, { size: file.size, etag, version: asset.version + 1, variants: [] });
      await asset.save();
      return asset;
    } catch (error) {
      if (changed) {
        const results = await Promise.allSettled([
          storage.putObject(asset.bucket, asset.key, oldOriginal, asset.mimeType, originalCache),
          storage.putObject(asset.bucket, asset.thumbnailKey, oldThumbnail, thumbnailMime, originalCache),
        ]);
        for (const result of results) if (result.status === 'rejected') console.error('Replacement rollback failed:', result.reason);
      }
      throw error;
    }
  });
}

/** List assets with validated filters, newest-first sorting, and bounded pagination. */
export async function listAssets(query) {
  const filters = {};
  if (query.bucket !== undefined) filters.bucket = validateBucket(query.bucket);
  if (query.format !== undefined) {
    if (typeof query.format !== 'string' || !Object.hasOwn(fileTypes, query.format.toLowerCase())) throw new AppError(400, 'INVALID_QUERY', 'format must be a supported file extension.');
    filters.format = query.format.toLowerCase();
  }
  if (query.q !== undefined) {
    if (typeof query.q !== 'string' || query.q.length > 200) throw new AppError(400, 'INVALID_QUERY', 'q must be a string of at most 200 characters.');
    filters.originalName = { $regex: escapeRegex(query.q), $options: 'i' };
  }
  if (query.from !== undefined || query.to !== undefined) {
    filters.createdAt = {};
    if (query.from !== undefined) filters.createdAt.$gte = parseDate(query.from, 'from');
    if (query.to !== undefined) {
      const end = parseDate(query.to, 'to');
      if (query.to.length === 10) end.setUTCHours(23, 59, 59, 999);
      filters.createdAt.$lte = end;
    }
    if (filters.createdAt.$gte > filters.createdAt.$lte) throw new AppError(400, 'INVALID_QUERY', 'from must be before or equal to to.');
  }
  const page = parseInteger(query.page, 'page', 1, 1000000, 1);
  const limit = parseInteger(query.limit, 'limit', 1, 100, 24);
  const [assets, total] = await Promise.all([
    Asset.find(filters).sort({ createdAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit),
    Asset.countDocuments(filters),
  ]);
  return { assets, total, page, limit, totalPages: Math.ceil(total / limit) };
}

/** Update editable asset metadata, rejecting invalid fields and values. */
export async function patchAsset(id, body) {
  const patch = validatePatch(body);
  const initial = await getAsset(id);
  return withLock(lockKey(initial), async () => {
    const asset = await getAsset(id);
    Object.assign(asset, patch);
    return asset.save();
  });
}

/** Delete original, thumbnail, all generated variants, and finally the database record. */
export async function deleteAsset(id) {
  const initial = await getAsset(id);
  return withLock(lockKey(initial), async () => {
    const asset = await getAsset(id);
    await storage.deleteObject(asset.bucket, asset.key);
    await storage.deleteObject(asset.bucket, asset.thumbnailKey);
    await storage.deletePrefix(asset.bucket, `variants/${asset.id}/`);
    await asset.deleteOne();
  });
}

/** Return the public URL of a cached or newly generated, versioned optimized image. */
export async function optimizedAsset(id, query) {
  const initial = await getAsset(id);
  return withLock(lockKey(initial), async () => {
    const asset = await getAsset(id);
    if (!asset.mimeType.startsWith('image/')) throw new AppError(400, 'IMAGE_REQUIRED', 'Only images can be optimized.');
    const w = query.w === undefined ? undefined : parseInteger(query.w, 'w', 1, 4000);
    const h = query.h === undefined ? undefined : parseInteger(query.h, 'h', 1, 4000);
    const q = parseInteger(query.q, 'q', 1, 100, 75);
    const format = query.format ?? 'webp';
    if (!['webp', 'avif', 'jpeg', 'png'].includes(format)) throw new AppError(400, 'INVALID_QUERY', 'format must be webp, avif, jpeg, or png.');
    const key = `variants/${asset.id}/v${asset.version}-${w ?? 'auto'}x${h ?? 'auto'}-q${q}.${format}`;
    if (!await storage.exists(asset.bucket, key)) {
      const original = await storage.getObject(asset.bucket, asset.key);
      const output = await optimizeImage(original, { w, h, q, format });
      await storage.putObject(asset.bucket, key, output, `image/${format}`, variantCache);
    }
    return storage.publicUrl(asset.bucket, key);
  });
}

/** Queue an idempotent, versioned video derivative or return its cached ready result. */
export async function transcodeAsset(id, body) {
  const initial = await getAsset(id);
  const options = validateVideoOptions(body);
  return withLock(lockKey(initial), async () => {
    const asset = await getAsset(id);
    if (!asset.mimeType.startsWith('video/')) throw new AppError(400, 'VIDEO_REQUIRED', 'Only videos can be transcoded.');
    const format = options.codec === 'h264' ? 'mp4' : 'webm';
    const key = `variants/${asset.id}/v${asset.version}-${options.resolution}p-${options.codec}-b${options.bitrate}-crf${options.crf}.${format}`;
    let variant = asset.variants.find((item) => item.key === key);
    if (variant?.status === 'ready' && await storage.exists(asset.bucket, key)) return { status: 200, assetId: asset.id, variant };
    if (variant && videoJobActive(key)) return { status: 202, assetId: asset.id, variant };
    asset.variants = asset.variants.filter((item) => item.key !== key);
    asset.variants.push({ ...options, key, version: asset.version, status: 'queued', format, mimeType: `video/${format}`, url: storage.publicUrl(asset.bucket, key) });
    variant = asset.variants[asset.variants.length - 1];
    await enqueueVideoJob({ id: asset.id, bucket: asset.bucket, originalKey: asset.key, version: asset.version, key, options }, () => asset.save());
    return { status: 202, assetId: asset.id, variant };
  });
}
