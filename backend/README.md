# Media Asset CMS backend

Node.js 20+, Express, plain JavaScript ES modules, MongoDB, and S3-compatible storage.

```powershell
cd backend
Copy-Item .env.example .env # Already populated for this development workspace.
npm.cmd ci
docker compose up -d
npm.cmd run dev
```

On macOS/Linux, use `cp .env.example .env` and `npm` instead of `npm.cmd`.
The API listens at `http://localhost:4000`. MinIO exposes its S3 API on port 9000
and console on port 9001, with development credentials `minioadmin/minioadmin`.
The Compose initializer creates `dev-assets` and enables public downloads. The
frontend displays this bucket as **Dhruv-assets**. MongoDB uses port 27017.
Existing services can be used instead of Compose.

The original Compose setup could not pull its MinIO images. This
backend includes a Compose setup using the [source-built MinIO image](https://github.com/coollabsio/minio),
pinned to the exact tested release and image digest. It includes the MinIO client
needed for bucket initialization. The MongoDB and MinIO data volumes persist.

## Configuration

`.env` is ignored by Git; `.env.example` is committed. Configuration is loaded
relative to the server directory and validated before connecting or listening.
Both S3 credentials must be explicit environment values; no AWS credential chain
or local AWS profile is used. Public URL mappings must cover every allowed bucket.

| Variable | Development value / purpose |
| --- | --- |
| `PORT` | `4000` |
| `CLIENT_ORIGIN` | `http://localhost:5173` |
| `S3_ENDPOINT` | `http://localhost:9000`; leave empty for AWS S3 |
| `S3_ACCESS_KEY` | Explicit storage access key |
| `S3_SECRET_KEY` | Explicit storage secret key |
| `S3_REGION` | `us-east-1`; use `auto` for R2 |
| `BUCKETS` | `dev-assets` (displayed as **Dhruv-assets**) |
| `BUCKET_PUBLIC_URLS` | Comma-separated `bucket=https://public-host/path` mappings |
| `MONGO_URI` | `mongodb://localhost:27017/cms` |
| `MAX_UPLOAD_MB` | `200`, measured in MiB (1024 × 1024 bytes) |

For AWS S3, clear `S3_ENDPOINT`, set the AWS region and explicit credentials, and
map each bucket to its public S3 or CDN URL. For R2, set the account's S3 endpoint,
region `auto`, R2 credentials, and each bucket's public domain. These changes
require only `.env`. No object ACL is applied on upload; public downloads are
configured at the bucket/domain level. AWS and R2 have not been tested live here.
See [R2_SETUP.md](R2_SETUP.md) for the R2 credentials, public access, browser CORS,
live storage check, and compressed preview instructions.

## API

Full response shapes and assumptions are in [API.md](API.md).

| Method | Endpoint | Result |
| --- | --- | --- |
| GET | `/api/health` | `200` when MongoDB is connected, otherwise `503` |
| GET | `/buckets` | Configured buckets and public URLs |
| POST | `/assets` | Multipart `file` + `bucket`; `201` asset |
| GET | `/assets` | Filters and pagination; `200` list |
| GET | `/assets/:id` | `200` asset |
| PUT | `/assets/:id/replace` | Multipart `file`; `200` updated asset |
| PATCH | `/assets/:id` | JSON metadata updates; `200` asset |
| GET | `/assets/:id/optimized` | Images only; `302` to cached/generated object |
| POST | `/assets/:id/transcode` | Video settings JSON; `202` job or `200` cached variant |
| DELETE | `/assets/:id` | `204` with no body |

```powershell
curl.exe -F "bucket=dev-assets" -F "file=@photo.png;type=image/png" http://localhost:4000/assets
curl.exe "http://localhost:4000/assets?q=photo&bucket=dev-assets&page=1&limit=24"
curl.exe -X PUT -F "file=@updated.png;type=image/png" http://localhost:4000/assets/ASSET_ID/replace
curl.exe -I "http://localhost:4000/assets/ASSET_ID/optimized?w=400&q=75&format=webp"
curl.exe -X DELETE http://localhost:4000/assets/ASSET_ID
```

Upload requests must provide the correct multipart MIME type; curl may default to
`application/octet-stream`, which is intentionally rejected. Originals and thumbnails
use `public, max-age=300`; optimized variants use `public, max-age=31536000, immutable`.
Replacement retains the URL, key, original name, and MIME type, increments the asset
version, regenerates its thumbnail, and deletes all variants. Existing caches may
retain original/thumbnail bytes for up to their 300-second TTL.

## Verification

```powershell
npm.cmd test
npm.cmd run test:api         # Starts an isolated test API; requires MongoDB and MinIO.
npm.cmd run test:integration # Requires the API, MongoDB, MinIO, and curl to be running.
npm.cmd run test:storage     # Checks the configured provider, public URLs, and preview CORS.
```

The unit suite checks configuration, validation boundaries, real image conversion,
serialization, and serialized asset operations. The integration suite generates
PNG/JPEG/MP4 fixtures with Sharp/FFmpeg and performs actual HTTP requests with curl.
It checks both successful and failed uploads, short-video thumbnails, automatic
multipart upload, replacement, versioned optimization in all output formats,
metadata updates, query errors, rollback, and removal of public objects. Tests
clean up the assets they create and their local fixtures.

`test:api` uses a new `cms_test_*` database, removes that database after the run,
and cleans up only its own uniquely named S3 objects. Its isolated API uses a
12 MiB upload limit to verify exact-limit and one-byte-over-limit behavior.
The development `cms` database and `.env` settings are preserved. See
[TEST_REPORT.md](TEST_REPORT.md) for the full coverage matrix and remaining limits.

The folder was renamed from `server` to `backend`. Compose retains project name
`server` so the existing development containers and data volumes are reused.

## Implementation notes

All S3 operations go through `storage.service.js`, including authenticated original
downloads for optimization. [AWS lib-storage](https://github.com/aws/aws-sdk-js-v3/tree/main/lib/lib-storage)
manages multipart uploads. Image work uses [Sharp](https://sharp.pixelplumbing.com/),
and video metadata uses the installed static ffprobe binary. FFmpeg generates
thumbnails and optimized H.264/MP4 or VP9/WebM videos, including AAC or Opus audio.

Video optimization accepts resolution bounds (480p, 720p, 1080p), a video bitrate
limit in kbps, codec, and CRF quality. It preserves aspect ratio without upscaling.
H.264 MP4 output uses fast start for browser playback. Encoding runs in a bounded
background queue, so POST returns promptly; poll GET-by-ID for variant status.
Ready variants expose actual dimensions, bytes, duration, audio codec, measured
total bitrate, and a public URL. Identical settings reuse the current version's
cached output. Replacement and deletion invalidate all video variants too.

The queue runs one encode at a time, allows 10 active/pending jobs, uses two FFmpeg
threads, and limits each encode to 10 minutes. It belongs to one Node process;
on restart, interrupted jobs are marked failed and can be retried. The frontend
shows queued/processing/failure status and retains ready variants after reopening.
These are local worker limits, not a distributed or durable job queue.

Encoder references: [FFmpeg libx264](https://ffmpeg.org/ffmpeg-codecs.html#libx264_002c-libx264rgb),
[FFmpeg libvpx/VP9](https://ffmpeg.org/ffmpeg-codecs.html#libvpx), and
[FFmpeg scale filter](https://ffmpeg.org/ffmpeg-filters.html#scale).

Original uploads roll back their objects if metadata, thumbnail generation, or
database persistence fails. Replacement keeps copies of previous bytes and restores
them if a later step fails; deleted variants can be generated again. Rollback
failures are logged without replacing the original API error.

Sharp's file cache is disabled so temporary WebP/GIF inputs are released on Windows.
Temporary file deletion also retries briefly if a filesystem lock is transient.

Mutations and optimization are serialized per bucket/key within one Node process.
Run one process for this implementation. Multi-process deployments need distributed
locking to prevent races between an upload, replacement, and variant generation;
the MongoDB unique index alone cannot atomically coordinate S3 writes. S3 and MongoDB
cannot commit together atomically, so a process crash may require reconciliation.

`expiresAt` stores metadata; it does not schedule automatic deletion. Image
optimization serves a still image for animated image inputs.
