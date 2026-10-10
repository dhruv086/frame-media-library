import path from 'node:path';
import mongoose from 'mongoose';
import mime from 'mime-types';
import { AppError } from './AppError.js';
import { env } from '../config/env.js';

export const fileTypes = Object.freeze({
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
  gif: 'image/gif', avif: 'image/avif', mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
});

/** Return the lowercase extension of a browser-supplied filename. */
export function extension(name) { return path.extname(name).slice(1).toLowerCase(); }

/** Reject extension/MIME pairs outside the explicitly supported media types. */
export function validateFileType(file) {
  const format = extension(file.originalname);
  if (!fileTypes[format] || file.mimetype !== fileTypes[format] || mime.lookup(`asset.${format}`) !== fileTypes[format]) {
    throw new AppError(400, 'INVALID_FILE_TYPE', 'Only JPG, JPEG, PNG, WebP, GIF, AVIF, MP4, WebM, and MOV files with matching MIME types are allowed.');
  }
  return format;
}

/** Sanitize a filename into a predictable, flat S3 key, keeping its extension. */
export function sanitizeFilename(name) {
  const filename = name.replace(/\\/g, '/').split('/').pop();
  const format = extension(filename);
  const stem = path.basename(filename, path.extname(filename)).normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().trim().replace(/\s+/g, '-').replace(/[^a-z0-9._-]/g, '').replace(/^[.-]+|[.-]+$/g, '').slice(0, 180);
  return `${stem || 'asset'}.${format}`;
}

/** Check that a bucket is explicitly permitted by configuration. */
export function validateBucket(bucket) {
  if (typeof bucket !== 'string' || !env.buckets.includes(bucket)) throw new AppError(400, 'INVALID_BUCKET', `Bucket must be one of: ${env.buckets.join(', ')}.`);
  return bucket;
}

/** Treat invalid asset identifiers as missing resources. */
export function validateId(id) {
  if (!mongoose.isObjectIdOrHexString(id)) throw new AppError(404, 'ASSET_NOT_FOUND', 'Asset not found.');
  return id;
}

/** Parse a bounded integer without silently accepting decimals or trailing text. */
export function parseInteger(value, name, min, max, fallback) {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== 'string' || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < min || Number(value) > max) {
    throw new AppError(400, 'INVALID_QUERY', `${name} must be an integer between ${min} and ${max}.`);
  }
  return Number(value);
}

/** Parse a real ISO calendar date or datetime, rejecting rollover dates. */
export function parseDate(value, name) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2}))?$/.test(value)) {
    throw new AppError(400, 'INVALID_DATE', `${name} must be a valid ISO date or datetime.`);
  }
  const date = new Date(value);
  const calendarDate = new Date(`${value.slice(0, 10)}T00:00:00.000Z`);
  const time = value.match(/T(\d{2}):(\d{2}):(\d{2})/);
  if (!Number.isFinite(date.getTime()) || !Number.isFinite(calendarDate.getTime()) || calendarDate.toISOString().slice(0, 10) !== value.slice(0, 10)
    || (time && (Number(time[1]) > 23 || Number(time[2]) > 59 || Number(time[3]) > 59))) {
    throw new AppError(400, 'INVALID_DATE', `${name} must be a valid date.`);
  }
  return date;
}

/** Validate editable metadata and prevent updates to storage/version fields. */
export function validatePatch(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new AppError(400, 'INVALID_BODY', 'A JSON object is required.');
  const keys = Object.keys(body);
  if (!keys.length || keys.some((key) => !['altText', 'tags', 'expiresAt'].includes(key))) throw new AppError(400, 'INVALID_BODY', 'Only altText, tags, and expiresAt may be updated.');
  const patch = {};
  if (Object.hasOwn(body, 'altText')) {
    if (typeof body.altText !== 'string') throw new AppError(400, 'INVALID_ALT_TEXT', 'altText must be a string.');
    patch.altText = body.altText;
  }
  if (Object.hasOwn(body, 'tags')) {
    if (!Array.isArray(body.tags) || body.tags.some((tag) => typeof tag !== 'string')) throw new AppError(400, 'INVALID_TAGS', 'tags must be an array of strings.');
    patch.tags = body.tags;
  }
  if (Object.hasOwn(body, 'expiresAt')) patch.expiresAt = body.expiresAt === null ? null : parseDate(body.expiresAt, 'expiresAt');
  return patch;
}

/** Escape regex metacharacters so search text is always interpreted literally. */
export function escapeRegex(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/** Validate allowlisted video settings; bitrate is a video cap in kilobits/second. */
export function validateVideoOptions(body = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some((key) => !['resolution', 'bitrate', 'codec', 'crf'].includes(key))) {
    throw new AppError(400, 'INVALID_VIDEO_OPTIONS', 'Only resolution, bitrate, codec, and crf may be specified.');
  }
  const number = (name, fallback, min, max) => {
    const value = body[name] ?? fallback;
    if (body[name] === null || typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
      throw new AppError(400, 'INVALID_VIDEO_OPTIONS', `${name} must be an integer between ${min} and ${max}.`);
    }
    return value;
  };
  const resolution = number('resolution', 720, 480, 1080);
  const codec = body.codec === undefined ? 'h264' : body.codec;
  if (![480, 720, 1080].includes(resolution) || !['h264', 'vp9'].includes(codec)) {
    throw new AppError(400, 'INVALID_VIDEO_OPTIONS', 'resolution must be 480, 720, or 1080; codec must be h264 or vp9.');
  }
  return { resolution, codec, bitrate: number('bitrate', 2500, 100, 20000), crf: number('crf', 28, 18, 40) };
}
