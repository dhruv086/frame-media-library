import { DeleteObjectCommand, DeleteObjectsCommand, GetObjectCommand, HeadObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { s3 } from '../config/s3.js';
import { env } from '../config/env.js';
import { AppError } from '../utils/AppError.js';

const isMissing = (error) => error.$metadata?.httpStatusCode === 404 || ['NotFound', 'NoSuchKey'].includes(error.name);

function storageError(error) {
  console.error('S3 operation failed:', error);
  return new AppError(502, 'STORAGE_ERROR', 'Object storage is temporarily unavailable. Please try again.');
}

/** Upload a buffer or readable stream; multipart uploads are managed automatically. */
export async function putObject(bucket, key, body, contentType, cacheControl) {
  try {
    const result = await new Upload({
      client: s3,
      params: { Bucket: bucket, Key: key, Body: body, ContentType: contentType, CacheControl: cacheControl },
      queueSize: 2,
      partSize: 8 * 1024 * 1024,
      leavePartsOnError: false,
    }).done();
    return { etag: result.ETag };
  } catch (error) { throw storageError(error); }
}

/** Delete an object; deleting a missing object is idempotent. */
export async function deleteObject(bucket, key) {
  try { await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key })); }
  catch (error) { throw storageError(error); }
}

/** Delete all objects under a nonempty prefix, following every listing page. */
export async function deletePrefix(bucket, prefix) {
  if (!prefix || !prefix.endsWith('/')) throw new AppError(400, 'INVALID_PREFIX', 'A nonempty directory prefix is required.');
  try {
    let continuationToken;
    do {
      const page = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: continuationToken }));
      if (page.Contents?.length) {
        const result = await s3.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: page.Contents.map(({ Key }) => ({ Key })), Quiet: true } }));
        if (result.Errors?.length) throw new Error(`Failed to delete ${result.Errors.length} stored objects`);
      }
      continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (continuationToken);
  } catch (error) { throw storageError(error); }
}

/** Read object headers, returning null only for a missing object. */
export async function headObject(bucket, key) {
  try { return await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key })); }
  catch (error) { if (isMissing(error)) return null; throw storageError(error); }
}

/** Determine object existence without treating permissions/network failures as misses. */
export async function exists(bucket, key) { return (await headObject(bucket, key)) !== null; }

/** Download original bytes through the authenticated storage client. */
export async function getObject(bucket, key) {
  try {
    const result = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    return Buffer.from(await result.Body.transformToByteArray());
  } catch (error) { throw storageError(error); }
}

/** Build a public URL using configured origins and safely encoded key segments. */
export function publicUrl(bucket, key) {
  const base = Object.hasOwn(env.bucketPublicUrls, bucket) ? env.bucketPublicUrls[bucket] : undefined;
  if (!base) throw new AppError(400, 'INVALID_BUCKET', 'Bucket has no configured public URL.');
  return `${base}/${key.split('/').map(encodeURIComponent).join('/')}`;
}
