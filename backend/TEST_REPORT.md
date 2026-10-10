# Backend test report

Verified on 2026-10-10 using Windows, Node.js 25.9.0, real MongoDB 7, and real MinIO.
The backend folder is now `backend`; `server` no longer exists. Frontend/client
files were not edited during the initial backend audit. Git history, ignored `.env`, and installed dependencies
were preserved during the rename. The Compose project name remains `server`
to preserve the existing development containers and persistent data volumes.

## Result

All **219 automated tests/checks passed** after the fixes, video implementation,
and provider checks below:

| Command | Passed | Failed |
| --- | ---: | ---: |
| `npm.cmd test` | 40 | 0 |
| `npm.cmd run test:api` | 116 | 0 |
| `npm.cmd run test:integration` | 51 | 0 |
| `npm.cmd run test:storage` (MinIO) | 12 | 0 |

The API suite starts an isolated HTTP server on an ephemeral port, uses a unique
`cms_test_*` database, and uses real S3 operations against MinIO. Cleanup removes
only its own S3 objects and database. Dependency failure scenarios inject errors
into the MongoDB model or AWS SDK methods while the remaining operations use the
real services. The curl suite ran against a freshly restarted backend on port 4000.

The additional provider tests serialize and sign real AWS SDK requests, intercepting
HTTP before any network call. They verify R2 (`auto`, account endpoint, path style),
AWS S3 (regional virtual host), and MinIO; all three use only explicit S3 credentials
and construct separate, encoded public URLs. These are offline configuration tests,
not evidence of live AWS/R2 connectivity.

The portable `test:storage` command passed against local MinIO. It verifies upload,
HEAD headers, authenticated/public downloads, Sharp-decoded WebP output, browser
CORS for frontend and redirected opaque origins, automatic multipart, overwrite,
single-object deletion, and prefix cleanup. It uses only its own unique test prefix
and does not connect to MongoDB. See [R2_SETUP.md](R2_SETUP.md) to run it against R2.

The existing screenshot's optimization endpoint was also exercised directly:

| File | Dimensions | Bytes | Smaller than original |
| --- | --- | ---: | ---: |
| Original PNG | 1920 x 1080 | 693,323 | - |
| WebP, quality 75 | 1920 x 1080 | 49,976 | 92.8% |
| WebP, quality 70 | 800 x 450 | 15,044 | 97.8% |
| AVIF, quality 50 | 800 x 450 | 12,434 | 98.2% |

The public responses were downloaded and decoded to verify format and dimensions.
During that storage audit, the existing frontend preview controls were inspected
in source; no frontend files were edited or browser UI tests performed at that stage.

Resize follow-up: the existing screenshot was requested at widths 200, 400, and
800 in both buckets, at WebP quality 80. All six downloaded outputs decoded to
the requested width (heights 113, 225, and 450 respectively). Invalid widths 0,
4001, and `abc` returned `400 INVALID_QUERY`. Original dimensions and URLs stayed
unchanged. The preview previously used CSS `width: 100%; height: 100%; object-fit:
contain`, making different pixel widths occupy the same preview area. Its width
field sends the new value only when Generate preview is submitted.

After explicit approval to edit the frontend preview, its image display was fixed
to avoid enlargement, read dimensions from decoded output, update details with
the Original/Optimized selection, and provide Open optimized. All 13 frontend
unit tests and the production build passed. The real-server headless Edge suite
also passed, including actual 200px/400px display measurements, decoded dimensions,
toggle details, optimized-link targets, mobile fit at 390px, and recovery from a
failed decode. Test fixtures were removed; desktop/mobile screenshots were reviewed.
These frontend checks are additional to the backend tests/checks above.

Video optimization follow-up: FFmpeg now creates asynchronous H.264/MP4 and
VP9/WebM derivatives, with resolution bounds, bitrate limits, CRF quality,
AAC/Opus audio, and fast-start MP4. Real encoder tests verify output codec,
audio conversion, dimensions, actual byte sizes, no upscaling, silent inputs,
and temporary cleanup after success or a failed output consumer. Queue tests
verify the 10-job capacity limit and release after persistence failure.

The API suite verifies accepted/idempotent jobs, cached ready output, missing
cache regeneration, actual public bytes/headers/metadata, failed storage jobs and
retry, server-restart recovery, metadata preservation, replacement versioning,
and deletion of video variants. New video tests account for the increase from
35 to 40 unit/media tests and 111 to 116 API tests. The 51 curl and 12 configured
MinIO storage checks were rerun successfully against the updated implementation.

All **14 frontend unit tests**, the production build, and the real-server
headless Edge browser suite pass. The browser suite generates videos in both
codecs using custom resolution/bitrate/CRF settings, plays the output, verifies
decoded dimensions and the optimized link, compares the original, reopens saved
variants, edits video alt text/tags/expiry, and deletes its fixtures. Desktop
(1440px) and mobile (390px) screenshots were reviewed. The full image workflow
continues to pass. Frontend checks are additional to the 219 backend checks.

## Coverage

| Area | Verified cases |
| --- | --- |
| Startup configuration | Missing credentials; malformed URLs and Mongo URI; invalid numeric limits; duplicate buckets; missing public URL mappings; env-only AWS/R2 configuration; inherited object property names |
| Health and buckets | Connected and disconnected database responses; reconnect recovery; configured bucket names and public URLs |
| HTTP behavior | CORS preflight; unknown endpoint; unsupported method; consistent JSON error envelopes; async sync throws/rejected promises; errors after response headers |
| Images | JPG, JPEG, PNG, WebP, GIF, AVIF; real public bytes, sizes, dimensions and MIME types; 400px WebP thumbnails; EXIF orientation |
| Videos | MP4, WebM, MOV; real public bytes; dimensions and duration; 400px JPEG thumbnails; 0.1-second and exactly-one-second clips; audio-only container rejected |
| Upload validation | EXE, SVG, double/missing extension, MIME mismatch, disguised JPEG-as-PNG, corrupt image/video, empty content, missing file/bucket, invalid bucket, multiple files, wrong multipart file field, duplicate bucket field |
| Multipart errors | Missing boundary, truncated form, client-aborted partial upload, temporary-file removal |
| Size and multipart storage | Exact 12 MiB boundary accepted; one byte over rejected with 413; automatic multipart S3 upload above 8 MiB; multipart ETag |
| Filename identity | Uppercase extension; lowercase safe key; spaces/unsafe characters; normalized filename collisions; same key in different buckets; duplicate cannot overwrite bytes |
| Lists | Newest-first sorting; deterministic pagination; total/page/limit/totalPages; case-insensitive search; literal regex metacharacters; bucket/format/date filters; inclusive date-only upper bound; empty/out-of-range pages |
| Invalid list queries | Zero/negative/decimal/non-numeric/oversized pagination; repeated query values; overlong search; invalid dates and reversed ranges; unsupported formats; `constructor` and `__proto__` |
| PATCH | Captions; string tags; timezone dates; clearing tags/caption/expiry; version preservation; malformed/oversized JSON; mixed/non-string tags; rollover dates; unknown/protected fields; prototype payload |
| Replacement | Same URL/key/name/bucket/format/MIME/creation time; changed bytes/dimensions/size/ETag/version; thumbnail regeneration; metadata preservation; old variants removed; jpg-vs-jpeg mismatch; corrupt file; video replacement |
| Optimization | Original dimensions by default; width-only/height-only/bounding box; 1px and 4000px boundaries; quality 1 and 100; WebP/AVIF/JPEG/PNG bytes and dimensions; 302 Location; redirect no-store; immutable object cache; cached ETag; invalid/repeated parameters; videos rejected |
| Video optimization | H.264/MP4 and VP9/WebM; AAC/Opus audio; silent source; bounded even dimensions; no upscaling; bitrate/CRF validation; MP4 fast start; asynchronous status; idempotent jobs; cache regeneration; actual bytes/rate; safe failures/retry; restart recovery; queue capacity; variant invalidation and deletion |
| Concurrency | Four simultaneous duplicate uploads produce one success; three replacements produce versions 2/3/4; simultaneous optimization uploads once; optimization/replacement race removes obsolete variants; PATCH/replacement race preserves metadata |
| Rollback | Corrupt uploads; database create failure; thumbnail upload failure; replacement thumbnail/database/variant-deletion failure restores previous original and thumbnail bytes and keeps version unchanged |
| Storage errors | Missing object is a cache miss; permissions/network errors become safe 502; real errors logged; per-object batch delete failure detected; safe public URL encoding |
| Prefix pagination | 1001 objects across multiple mocked S3 listing pages; no prefix crossover; unsafe/empty prefix rejected |
| Deletion | Original, thumbnail and variants removed; database record removed; missing IDs across all asset endpoints; partial storage deletion keeps record and succeeds on retry; repeated DELETE returns 404 |
| Cleanup | No new temporary media files remain after successes, errors, or client disconnect; test fixtures and test assets removed |

## Issues found and fixed

1. Malformed multipart requests returned 500. Known parser/client-disconnect errors
   now return `400 INVALID_UPLOAD` through the central error handler.
2. Format filters accepted inherited object keys such as `constructor` and
   `__proto__`. Format validation now checks own properties explicitly.
3. Bucket public-URL validation could mistake an inherited property for a configured
   URL. Public URL maps now have no prototype, with explicit own-property checks.
4. Sharp retained open temporary WebP/GIF files on Windows. Its file cache is now
   disabled, and temporary-file deletion retries brief Windows filesystem locks.
5. Installed Sharp 0.34.5 had high-severity dependency advisories. It was updated to
   0.35.5 and all supported image formats and conversions were retested.

One initial date-sort test also used Mongoose updates to modify immutable `createdAt`.
The fixture now sets those dates directly through the test collection; the actual
API sort and date filtering pass.

## Dependency audit

`npm.cmd audit --omit=dev` reports **0 vulnerabilities**.

The full audit reports three high-severity package entries in the **development-only**
chain `nodemon -> chokidar -> braces`, stemming from one
[braces stack-exhaustion advisory](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm).
As of this verification, the advisory lists no patched version; the registry's
latest braces is 3.0.3, and the latest nodemon still depends on chokidar 3.
Nodemon remains a devDependency as requested. The suggested npm audit downgrade to
old nodemon was not applied. Production uses `npm start` and can install with
`npm ci --omit=dev`.

Sharp update references: [libvips advisory](https://github.com/advisories/GHSA-f88m-g3jw-g9cj),
[libheif advisory](https://github.com/advisories/GHSA-rgj7-g3m4-5g8c),
[Sharp 0.35.5 release](https://github.com/lovell/sharp/releases/tag/v0.35.5).

## Limits of verification

- These passing tests cover the implemented API extensively; they do not prove that
  every possible input or failure mode works.
- AWS S3 and Cloudflare R2 were not tested live. Provider configuration is tested,
  and live storage integration uses MinIO.
- Per-asset locks coordinate one Node process. Multiple backend processes still need
  distributed locking. Process crashes between MongoDB and S3 writes need reconciliation.
- This is functional, boundary, concurrency, and failure testing; sustained load,
  memory profiling, and hostile-media fuzzing were not performed.
- The Node.js 20 runtime was not exercised; this machine uses Node.js 25.9.0.
- `expiresAt` is stored metadata; automatic expiry deletion was not specified.
- Video jobs run in a bounded queue within one Node process. Interrupted jobs are
  marked failed on restart and require retry; this is not a distributed job system.
- Exact response shapes remain the assumptions documented in `API.md`, because the
  original request did not include its shared API contract.
