# Cloudflare R2 setup and compressed previews

The backend uses the AWS JavaScript SDK against R2's S3-compatible API. No code
change is needed to select R2. Credentials stay in the backend; the browser reads
objects from the configured public bucket URL.

## Create a test bucket and credentials

1. Open Cloudflare **R2 Object Storage** and create `cms-test-assets` using
   **Standard** storage. R2's [free allowance](https://developers.cloudflare.com/r2/pricing/)
   applies to Standard storage; usage beyond the allowance is billed.
2. Create an R2 API token with **Object Read & Write**, scoped to this bucket.
   Copy its **Access Key ID** and **Secret Access Key** into your local `.env`.
   Use these S3 credentials, following the [authentication guide](https://developers.cloudflare.com/r2/api/tokens/).
3. Open the bucket's **Settings**, enable **Public Development URL**, and copy
   its generated `https://pub-....r2.dev` URL. R2 buckets are private by default.
   The development URL is rate limited; connect a custom domain for production.
   See [public bucket configuration](https://developers.cloudflare.com/r2/buckets/public-buckets/).

Update the storage values in `backend/.env` with your actual values:

```dotenv
S3_ENDPOINT=https://YOUR_ACCOUNT_ID.r2.cloudflarestorage.com
S3_ACCESS_KEY=YOUR_R2_ACCESS_KEY_ID
S3_SECRET_KEY=YOUR_R2_SECRET_ACCESS_KEY
S3_REGION=auto
BUCKETS=cms-test-assets
BUCKET_PUBLIC_URLS=cms-test-assets=https://pub-YOUR_GENERATED_ID.r2.dev
```

The [Cloudflare SDK example](https://developers.cloudflare.com/r2/examples/aws/aws-sdk-js-v3/)
uses this endpoint and `auto` region. Copy the endpoint shown in your dashboard
if the bucket uses a jurisdiction-specific endpoint. The endpoint is the
authenticated S3 API; `BUCKET_PUBLIC_URLS` is the separate public download base.
Do not append the bucket name to an R2 public development URL.

Keep `PORT`, `CLIENT_ORIGIN`, and `MAX_UPLOAD_MB` as configured. The storage check
does not use MongoDB. To run the application against R2 without mixing existing
MinIO records with new cloud assets, use a separate local test database:

```dotenv
MONGO_URI=mongodb://localhost:27017/cms_r2_test
```

Changing `.env` does not migrate existing objects or their saved MongoDB URLs.
Restart the API after changing its environment. `.env` is ignored by Git; never
put credentials in frontend environment files or commit them.

## Allow compressed previews in the browser

In the bucket's **Settings -> CORS Policy**, save this JSON policy:

```json
[
  {
    "AllowedOrigins": ["*"],
    "AllowedMethods": ["GET", "HEAD"],
    "ExposeHeaders": ["ETag", "Content-Length", "Content-Type"],
    "MaxAgeSeconds": 3600
  }
]
```

These objects are publicly readable. Wildcard read access supports the current
preview flow: frontend -> backend optimization endpoint -> public storage URL.
That cross-origin redirect can serialize the browser's origin as `null`, so an
origin-only policy for `http://localhost:5173` can block this fetch.
See [R2 CORS configuration](https://developers.cloudflare.com/r2/buckets/cors/)
and the [Fetch origin serialization rules](https://fetch.spec.whatwg.org/#serializing-a-request-origin).
Uploads and deletes go through the backend's authenticated SDK, so this browser
policy needs only GET/HEAD. If a custom domain cached objects before the CORS
change, refresh/purge its cache as described in Cloudflare's CORS guide.

## Run the live R2 check

From `backend`:

```powershell
npm.cmd run test:storage -- cms-test-assets
```

The command uses the current `.env`. It checks missing-object HEAD, upload/ETag,
Content-Type/size/cache headers, authenticated downloads, actual WebP dimensions,
public downloads, both browser CORS cases, multipart upload above 8 MiB, overwrite,
object deletion, and prefix deletion. It creates a unique
`cms-storage-check/<uuid>/` prefix and removes only its own objects in `finally`.
It does not change MongoDB data. A successful local MinIO run does not establish
that a remote R2 account's credentials, permissions, public domain, or CORS work.

`npm.cmd test` also checks the real SDK's endpoint selection, request path,
signature region, explicit credentials, and public URL construction offline for
R2, AWS, and MinIO. Those tests intercept HTTP requests and make no cloud calls.

## See the compressed file

1. In the frontend, select an image's **Preview** button or thumbnail.
2. Under **Optimized variant**, choose width, format, and quality.
3. Select **Generate preview**. The modal displays the generated image and its
   actual file size/savings. Use **Original / Optimized** to compare.

After changing the width, select **Generate preview** again to apply it. The
preview shows the decoded file's actual dimensions and never enlarges small
images. Larger images scale down to fit the display area. The Original/Optimized
toggle updates the displayed format, dimensions, and file size. Select **Open
optimized** to open the generated file in another tab.

**Open original** and the library cards refer to the original file. The original
asset's stored dimensions do not change when generating a separate variant.
Closing and reopening the modal resets its selection; the generated
variant remains cached in storage. Image optimization does not replace the
original or change its metadata.

For a video, open **Preview**, choose its resolution limit (480p/720p/1080p),
video bitrate limit in kbps, codec (H.264/MP4 or VP9/WebM), and CRF quality.
Select **Generate video preview**. The backend queues FFmpeg processing; the UI
shows status and switches to the ready video when encoding finishes. Playback,
**Original / Optimized**, and **Open optimized** work with the generated video.
Saved video variants remain selectable after reopening the preview. Their actual
dimensions, size/savings, codec, and measured bitrate are shown. Video bitrate
limits exclude audio/container overhead, so measured total bitrate can be higher.

Processing uses the backend's installed FFmpeg binary; R2 stores the original,
thumbnail, and generated variants. It does not depend on a Cloudflare media
optimization service. The same storage code is used for MinIO and R2. Live R2
verification still requires configuring credentials/public access and running
the check above; the current workspace is configured for local MinIO.

You can also open this API URL directly, replacing `ASSET_ID`:

```text
http://localhost:4000/assets/ASSET_ID/optimized?w=800&q=70&format=webp
```

The API downloads the original through its authenticated SDK, converts it with
Sharp, stores `variants/<id>/v<version>-800xauto-q70.webp`, and returns a 302 to
its public URL. Repeating the same request reuses the cached variant. Replacement
increments the version and deletes previous variants.

For the existing local screenshot, the tested 1920x1080 WebP at quality 75 was
49,976 bytes, compared with the 693,323-byte original PNG: **92.8% smaller at the
same dimensions**. Compression savings vary with the image and settings.
