import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';

dotenv.config({ path: fileURLToPath(new URL('../../.env', import.meta.url)), quiet: true });

/** Validate startup configuration, collecting all errors into one clear message. */
export function validateEnv(source) {
  const errors = [];
  const required = (name) => {
    const value = source[name]?.trim();
    if (!value) errors.push(`${name} is required`);
    return value;
  };
  const httpUrl = (value, name) => {
    try {
      const url = new URL(value);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error();
      return url.toString().replace(/\/$/, '');
    } catch {
      errors.push(`${name} must be an HTTP(S) URL without credentials, query, or fragment`);
      return value;
    }
  };
  const positiveInteger = (name, fallback, max) => {
    const value = Number(source[name] ?? fallback);
    if (!Number.isSafeInteger(value) || value < 1 || value > max) errors.push(`${name} must be an integer between 1 and ${max}`);
    return value;
  };
  const buckets = (required('BUCKETS') || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!buckets.length || new Set(buckets).size !== buckets.length || buckets.some((b) => !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(b))) {
    errors.push('BUCKETS must contain unique, valid S3 bucket names');
  }
  const publicUrls = Object.create(null);
  for (const entry of (required('BUCKET_PUBLIC_URLS') || '').split(',')) {
    const separator = entry.indexOf('=');
    if (separator < 1) { errors.push('BUCKET_PUBLIC_URLS must use bucket=https://host/path pairs'); continue; }
    const bucket = entry.slice(0, separator).trim();
    if (!buckets.includes(bucket) || Object.hasOwn(publicUrls, bucket)) errors.push(`BUCKET_PUBLIC_URLS has an unknown or repeated bucket: ${bucket}`);
    publicUrls[bucket] = httpUrl(entry.slice(separator + 1).trim(), `Public URL for ${bucket}`);
  }
  for (const bucket of buckets) if (!Object.hasOwn(publicUrls, bucket)) errors.push(`BUCKET_PUBLIC_URLS is missing ${bucket}`);
  const mongoUri = required('MONGO_URI');
  if (mongoUri && !/^mongodb(?:\+srv)?:\/\/.+/.test(mongoUri)) errors.push('MONGO_URI must be a MongoDB connection URI');
  const config = {
    port: positiveInteger('PORT', 4000, 65535),
    clientOrigin: httpUrl(source.CLIENT_ORIGIN || 'http://localhost:5173', 'CLIENT_ORIGIN'),
    s3Endpoint: source.S3_ENDPOINT?.trim() ? httpUrl(source.S3_ENDPOINT.trim(), 'S3_ENDPOINT') : undefined,
    s3AccessKey: required('S3_ACCESS_KEY'),
    s3SecretKey: required('S3_SECRET_KEY'),
    s3Region: source.S3_REGION?.trim() || 'us-east-1',
    buckets: Object.freeze(buckets),
    bucketPublicUrls: Object.freeze(publicUrls),
    mongoUri,
    maxUploadMb: positiveInteger('MAX_UPLOAD_MB', 200, 10240),
  };
  if (errors.length) throw new Error(`Invalid environment configuration:\n- ${errors.join('\n- ')}`);
  return Object.freeze(config);
}

export const env = validateEnv(process.env);
