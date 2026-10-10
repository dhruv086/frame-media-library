# API contract and assumptions

The supplied shared-contract section contained only `<PASTE THE SHARED API CONTRACT HERE>`.
This document records the concrete response shapes chosen for the specified endpoint
rules, so a client can integrate without guessing.

## Asset representation

POST, GET-by-ID, PUT-replace, and PATCH return the asset directly:

```json
{
  "id": "507f1f77bcf86cd799439011",
  "bucket": "dev-assets",
  "key": "my-photo.png",
  "originalName": "My Photo.PNG",
  "format": "png",
  "mimeType": "image/png",
  "size": 12500,
  "width": 800,
  "height": 600,
  "duration": null,
  "videoCodec": null,
  "videoBitrate": null,
  "audioCodec": null,
  "variants": [],
  "url": "http://localhost:9000/dev-assets/my-photo.png",
  "thumbnailKey": "thumbs/my-photo.png.webp",
  "thumbnailUrl": "http://localhost:9000/dev-assets/thumbs/my-photo.png.webp",
  "altText": "",
  "tags": [],
  "expiresAt": null,
  "version": 1,
  "etag": "\"opaque-storage-etag\"",
  "createdAt": "2026-10-10T00:00:00.000Z",
  "updatedAt": "2026-10-10T00:00:00.000Z"
}
```

`format` is the lowercase original extension (`jpg` and `jpeg` remain distinct).
`duration` is seconds for videos and null for images. ETags are opaque storage values,
including quotes when returned by S3. `_id` and `__v` are omitted.
Video assets additionally expose their source `videoCodec`, `videoBitrate` in
bits/second when available, and `audioCodec` (null for silent videos). Older records
may lack codec metadata until replacement. `variants` contains video jobs and
ready video outputs; image variants remain cached in storage only.

## Endpoints

`POST /assets`: multipart form with exactly one `file` and a required `bucket`.
Returns `201`. The filename is normalized to a lowercase, flat, safe key; spaces
become hyphens. A duplicate normalized key in the same bucket returns `409 DUPLICATE`
with a message suggesting Replace. The same key is permitted in different buckets.
Additional metadata is edited through PATCH.

`PUT /assets/:id/replace`: multipart form with one `file`. The lowercase extension
and MIME type must both match the original. Returns `200`. The original filename,
bucket, key, URL, format, and MIME type stay fixed. Size, dimensions, duration, ETag,
and thumbnail bytes update, and `version` increments. Wrong format returns
`400 FORMAT_MISMATCH`.
All video variants are cleared on replacement; any in-flight encode of an older
version is discarded before upload.

`GET /assets`: optional `q`, `format`, `from`, `to`, `bucket`, `page`, `limit`.
Search is a literal case-insensitive substring of `originalName`; regex characters
are escaped. Dates accept ISO `YYYY-MM-DD` or datetime with timezone. Date-only
`to` includes that entire UTC day. `page` defaults to 1; `limit` defaults to 24,
with a maximum of 100. Assets sort by `createdAt` descending, with ID as a tie-breaker.
Returns `200`:

```json
{ "assets": [], "total": 0, "page": 1, "limit": 24, "totalPages": 0 }
```

`GET /assets/:id`: returns `200` with one asset. Malformed and missing IDs return
`404 ASSET_NOT_FOUND` consistently across asset endpoints.

`PATCH /assets/:id`: JSON containing any nonempty subset of `altText` (string),
`tags` (array of strings), and `expiresAt` (valid ISO date/datetime or null).
Unknown and protected fields are rejected. Returns `200` with the updated asset.

`GET /assets/:id/optimized`: images only. Optional `w` and `h` are integers 1–4000;
`q` is 1–100, default 75; `format` is `webp`, `avif`, `jpeg`, or `png`, default webp.
Dimensions preserve aspect ratio and fit inside the specified bounds; an omitted
dimension is automatic. With neither dimension, the original dimensions are kept.
Omitted dimensions use `auto` in the key:
`variants/:id/v:version-:w x :h-q:q.:format` (without spaces).
For example, `variants/507f1f77bcf86cd799439011/v2-400xauto-q75.webp`.
Returns `302` with a `Location` pointing to the public variant URL and
`Cache-Control: no-store` on the redirect, so a replacement can change its target.
The variant object itself has the required one-year immutable cache policy.

`POST /assets/:id/transcode`: videos only, with a JSON object. All fields are
optional; this example shows the defaults:

```json
{ "resolution": 720, "bitrate": 2500, "codec": "h264", "crf": 28 }
```

- `resolution`: integer 480, 720, or 1080. Output fits inside 854x480, 1280x720,
  or 1920x1080 respectively, preserves aspect ratio, uses even dimensions, and
  never enlarges the source. The actual height can be less than the selected bound.
- `bitrate`: integer 100-20000, in kbps; video bitrate limit, not a guaranteed
  output size or exact average rate. Audio and container overhead add to total rate.
- `codec`: `h264` (MP4 with AAC audio and fast start) or `vp9` (WebM with Opus audio).
  Silent input remains silent.
- `crf`: integer 18-40; lower values favor quality and larger output. Defaults to 28.

Unknown fields and stringified numbers are rejected. Images return
`400 VIDEO_REQUIRED`. Accepted work returns `202`:

```json
{
  "assetId": "507f1f77bcf86cd799439011",
  "variant": {
    "key": "variants/507f1f77bcf86cd799439011/v1-720p-h264-b2500-crf28.mp4",
    "url": "http://localhost:9000/dev-assets/variants/507f1f77bcf86cd799439011/v1-720p-h264-b2500-crf28.mp4",
    "version": 1,
    "status": "queued",
    "codec": "h264",
    "format": "mp4",
    "mimeType": "video/mp4",
    "resolution": 720,
    "bitrate": 2500,
    "crf": 28,
    "audioCodec": null,
    "error": null
  }
}
```

Poll `GET /assets/:id`; the matching entry in `variants` advances through
`queued`, `processing`, then `ready` or `failed`. Its URL becomes available when
ready. A ready entry additionally includes `width`, `height`, `duration` (seconds),
`size` (bytes), `etag`, `videoBitrate` (bits/second when ffprobe supplies it),
`audioCodec`, and `measuredBitrate` (total bits/second, calculated from bytes/duration).
Savings should be calculated from actual size; some settings can produce a larger file.

Identical requests while active return `202` with the existing job. A ready cached
object returns `200` with the same response shape and key. Missing cached objects
are regenerated; failed jobs can be retried with the same POST. Worker failures
are reported in the persisted entry's safe `error` message, rather than changing
the already returned POST response. The original asset and URL remain unchanged.
Variant objects use `public, max-age=31536000, immutable`.

The single-process queue permits 10 total active/pending jobs, encodes one at a
time, and limits each encode to 10 minutes. Excess requests return
`429 PROCESSING_BUSY`. Interrupted jobs become failed on server restart and can
be retried. Replacement/deletion prevents an obsolete job from publishing output.

`DELETE /assets/:id`: deletes the original, thumbnail, all `variants/:id/` objects,
then the database record. Returns `204` with no body.

`GET /buckets`: returns `200`:

```json
{ "buckets": [{ "name": "dev-assets", "publicUrl": "http://localhost:9000/dev-assets" }] }
```

`GET /api/health`: returns `200` with
`{ "status": "ok", "database": "connected" }`, or `503` with
`{ "status": "unavailable", "database": "disconnected" }`.
This is a database readiness check; it does not make an S3 call.

## Errors

Every API error uses exactly this envelope:

```json
{ "error": { "code": "INVALID_BUCKET", "message": "Bucket must be one of: dev-assets." } }
```

| Status | Codes / conditions |
| --- | --- |
| 400 | `INVALID_BUCKET`, `INVALID_FILE_TYPE`, `FORMAT_MISMATCH`, `INVALID_MEDIA`, `FILE_REQUIRED`, `INVALID_UPLOAD`, `INVALID_QUERY`, `INVALID_DATE`, `INVALID_BODY`, `INVALID_TAGS`, `INVALID_ALT_TEXT`, `INVALID_JSON`, `VALIDATION_ERROR`, `IMAGE_REQUIRED`, `VIDEO_REQUIRED`, `INVALID_VIDEO_OPTIONS` |
| 404 | `ASSET_NOT_FOUND`, `NOT_FOUND` |
| 409 | `DUPLICATE` |
| 413 | `FILE_TOO_LARGE`, `BODY_TOO_LARGE` |
| 429 | `PROCESSING_BUSY` |
| 502 | `STORAGE_ERROR` with a safe public message; actual storage details are logged |
| 500 | `INTERNAL_ERROR` with a generic public message; actual details are logged |
