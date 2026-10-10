import assert from "node:assert/strict";
import { loadEnv } from "vite";
import { resolve } from "node:path";

const env = loadEnv("development", resolve(import.meta.dirname, ".."), "VITE_");
const base = (env.VITE_API_URL || "http://localhost:4000").replace(/\/+$/, "");

async function read(path) {
  const response = await fetch(`${base}${path}`, {
    signal: AbortSignal.timeout(5000),
  });
  const data = await response.json();
  if (!response.ok)
    throw new Error(
      data.error?.message || `Backend returned ${response.status} for ${path}`,
    );
  console.log(`PASS: GET ${path}`);
  return data;
}

try {
  const health = await read("/api/health");
  assert.equal(health.status, "ok");
  assert.equal(health.database, "connected");

  const { buckets } = await read("/buckets");
  assert.equal(Array.isArray(buckets), true);
  assert.ok(buckets.length, "No buckets configured on the server.");
  const bucket = buckets[0].name;
  const result = await read(
    `/assets?${new URLSearchParams({ bucket, page: "1", limit: "12" })}`,
  );
  assert.equal(Array.isArray(result.assets), true);
  for (const field of ["total", "page", "limit", "totalPages"])
    assert.equal(typeof result[field], "number");

  for (const asset of result.assets) {
    for (const field of [
      "id",
      "originalName",
      "format",
      "url",
      "thumbnailUrl",
      "bucket",
      "version",
    ]) {
      assert.notEqual(asset[field], undefined, `Asset is missing ${field}`);
    }
  }
  if (result.assets.length) {
    const asset = await read(
      `/assets/${encodeURIComponent(result.assets[0].id)}`,
    );
    assert.equal(asset.id, result.assets[0].id);
  }
  console.log(
    "PASS: backend health, bucket, gallery, and available asset-detail contracts. No assets modified.",
  );
} catch (error) {
  console.error(`FAIL: ${error.message}`);
  process.exitCode = 1;
}
