import test from "node:test";
import assert from "node:assert/strict";
import {
  request,
  getHealth,
  getAsset,
  getAssets,
  uploadAsset,
  replaceAsset,
  editAsset,
  getOptimized,
  transcodeAsset,
} from "../src/api/client.js";
import {
  expiryStatus,
  formatBytes,
  validateFile,
  versionedUrl,
  MAX_FILE_SIZE,
} from "../src/utils.js";

test("video encoding posts numeric allowlisted settings and returns a persisted job", async (t) => {
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(url, "http://localhost:4000/assets/video-1/transcode");
    assert.equal(options.method, "POST");
    assert.deepEqual(JSON.parse(options.body), { resolution: 480, bitrate: 500, codec: "vp9", crf: 32 });
    return Response.json({ assetId: "video-1", variant: { key: "variants/video-1/example.webm", status: "queued" } }, { status: 202 });
  });
  assert.equal((await transcodeAsset("video-1", { resolution: 480, bitrate: 500, codec: "vp9", crf: 32 })).variant.status, "queued");
});

test("request preserves the shared server error and status", async (t) => {
  t.mock.method(
    globalThis,
    "fetch",
    async () =>
      new Response(
        JSON.stringify({
          error: {
            code: "DUPLICATE",
            message: "Use Replace to update this filename.",
          },
        }),
        { status: 409 },
      ),
  );
  await assert.rejects(
    request("/assets"),
    (error) =>
      error.message === "Use Replace to update this filename." &&
      error.status === 409 &&
      error.code === "DUPLICATE",
  );
});

test("request handles empty delete responses and non-JSON failures", async (t) => {
  const fetch = t.mock.method(
    globalThis,
    "fetch",
    async () => new Response(null, { status: 204 }),
  );
  assert.equal(await request("/assets/a", { method: "DELETE" }), null);
  fetch.mock.mockImplementation(
    async () => new Response("<html>Unavailable</html>", { status: 502 }),
  );
  await assert.rejects(request("/assets"), /Request failed \(502\)/);
});

test("request translates network errors and respects caller cancellation", async (t) => {
  const fetch = t.mock.method(globalThis, "fetch", async () => {
    throw new TypeError("fetch failed");
  });
  await assert.rejects(request("/assets"), /Unable to reach the media server/);
  fetch.mock.mockImplementation(async (_url, { signal }) => {
    signal.throwIfAborted();
  });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(request("/assets", { signal: controller.signal }), {
    name: "AbortError",
  });
});

test("gallery sends exact contract filter names and omits empty values", async (t) => {
  t.mock.method(globalThis, "fetch", async (url) => {
    const parsed = new URL(url);
    assert.equal(parsed.pathname, "/assets");
    assert.deepEqual(Object.fromEntries(parsed.searchParams), {
      bucket: "dev-assets",
      q: "sun & sea",
      from: "2026-10-01",
      page: "2",
      limit: "12",
    });
    return Response.json({
      assets: [],
      total: 0,
      page: 2,
      limit: 12,
      totalPages: 0,
    });
  });
  await getAssets({
    bucket: "dev-assets",
    q: "sun & sea",
    format: "",
    from: "2026-10-01",
    to: "",
    page: 2,
    limit: 12,
  });
});

test("health and asset details use the backend's actual routes", async (t) => {
  const urls = [];
  t.mock.method(globalThis, "fetch", async (url) => {
    urls.push(url);
    return Response.json(
      url.endsWith("/api/health")
        ? { status: "ok", database: "connected" }
        : { id: "id/1", version: 3, altText: "Latest metadata" },
    );
  });
  assert.equal((await getHealth()).database, "connected");
  assert.equal((await getAsset("id/1")).version, 3);
  assert.deepEqual(urls, [
    "http://localhost:4000/api/health",
    "http://localhost:4000/assets/id%2F1",
  ]);
});

test("asset detail errors preserve the backend message", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    Response.json(
      {
        error: { code: "ASSET_NOT_FOUND", message: "Asset not found." },
      },
      { status: 404 },
    ),
  );
  await assert.rejects(
    getAsset("missing"),
    (error) =>
      error.message === "Asset not found." && error.code === "ASSET_NOT_FOUND",
  );
});

test("metadata PATCH retains a clearable null expiry and tag array", async (t) => {
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(url.endsWith("/assets/id-1"), true);
    assert.equal(options.method, "PATCH");
    assert.deepEqual(JSON.parse(options.body), {
      altText: "A quiet lake",
      tags: ["nature"],
      expiresAt: null,
    });
    return Response.json({ id: "id-1", version: 2 });
  });
  assert.equal(
    (
      await editAsset("id-1", {
        altText: "A quiet lake",
        tags: ["nature"],
        expiresAt: null,
      })
    ).version,
    2,
  );
});

test("optimization fetches actual bytes using w, q and format", async (t) => {
  t.mock.method(globalThis, "fetch", async (url) => {
    assert.equal(
      url.endsWith("/assets/id-1/optimized?w=800&q=75&format=webp"),
      true,
    );
    return new Response(new Uint8Array([1, 2, 3]), {
      headers: { "Content-Type": "image/webp" },
    });
  });
  const blob = await getOptimized("id-1", {
    w: "800",
    q: "75",
    format: "webp",
  });
  assert.equal(blob.size, 3);
  assert.equal(blob.type, "image/webp");
});

function mockXHR(t, { status = 201, payload = { id: "a", version: 2 } } = {}) {
  const previous = globalThis.XMLHttpRequest;
  class FakeXHR {
    upload = {};
    open(method, url) {
      this.method = method;
      this.url = url;
    }
    send(data) {
      this.data = data;
      FakeXHR.last = this;
      queueMicrotask(() => {
        this.upload.onprogress({
          lengthComputable: true,
          loaded: 5,
          total: 10,
        });
        this.status = status;
        this.responseText = JSON.stringify(payload);
        this.onload();
      });
    }
    abort() {
      this.onabort();
    }
  }
  globalThis.XMLHttpRequest = FakeXHR;
  t.after(() => {
    if (previous === undefined) delete globalThis.XMLHttpRequest;
    else globalThis.XMLHttpRequest = previous;
  });
  return FakeXHR;
}

test("XHR uploads report real progress and send file plus selected bucket", async (t) => {
  const xhr = mockXHR(t);
  const progress = [];
  await uploadAsset(new File(["bytes"], "photo.png", { type: "image/png" }), {
    bucket: "dev-assets",
    onProgress: (value) => progress.push(value),
  });
  assert.deepEqual(progress, [50]);
  assert.equal(xhr.last.method, "POST");
  assert.equal(xhr.last.data.get("bucket"), "dev-assets");
  assert.equal(xhr.last.data.get("file").name, "photo.png");
});

test("XHR replacement uses PUT and duplicate errors retain the server message", async (t) => {
  const xhr = mockXHR(t, {
    status: 409,
    payload: {
      error: { code: "DUPLICATE", message: "This filename already exists." },
    },
  });
  await assert.rejects(
    replaceAsset("id-1", new File(["bytes"], "photo.png")),
    /This filename already exists/,
  );
  assert.equal(xhr.last.method, "PUT");
  assert.equal(xhr.last.url.endsWith("/assets/id-1/replace"), true);
  assert.equal(xhr.last.data.has("bucket"), false);
});

test("validation rejects unsupported, empty and oversized files before upload", () => {
  assert.match(validateFile({ name: "file.svg", size: 10 }), /Unsupported/);
  assert.match(validateFile({ name: "file.png", size: 0 }), /empty/);
  assert.match(
    validateFile({ name: "file.png", size: MAX_FILE_SIZE + 1 }),
    /200 MB/,
  );
  assert.equal(validateFile({ name: "FILE.JPEG", size: MAX_FILE_SIZE }), "");
  assert.match(
    validateFile({ name: "file.jpeg", size: 10 }, "jpg"),
    /extension must match/,
  );
});

test("display cache busting preserves original links, query strings and fragments", () => {
  const original = "https://media.test/photo.png?token=abc#preview";
  assert.equal(
    versionedUrl(original, 3),
    "https://media.test/photo.png?token=abc&v=3#preview",
  );
  assert.equal(original, "https://media.test/photo.png?token=abc#preview");
});

test("expiry badges handle seven-day boundaries and size labels are readable", () => {
  const now = Date.parse("2026-10-10T12:00:00Z");
  assert.equal(expiryStatus("2026-10-10T11:00:00Z", now), "Expired");
  assert.equal(expiryStatus("2026-10-17T12:00:00Z", now), "Expires soon");
  assert.equal(expiryStatus("2026-10-18T12:00:00Z", now), null);
  assert.equal(expiryStatus(null, now), null);
  assert.equal(formatBytes(1024), "1 KB");
});
