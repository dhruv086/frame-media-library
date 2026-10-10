export const API_URL = (
  import.meta.env?.VITE_API_URL || "http://localhost:4000"
).replace(/\/+$/, "");

/** Convert the shared error envelope into an Error, retaining status/code for callers. */
export function apiError(payload, status) {
  const error = new Error(
    payload?.error?.message || `Request failed (${status}). Please try again.`,
  );
  error.status = status;
  error.code = payload?.error?.code || "REQUEST_FAILED";
  return error;
}

/** Make a JSON or blob request, with cancellation and a bounded network timeout. */
export async function request(
  path,
  { body, responseType = "json", timeout = 30000, signal, ...options } = {},
) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, timeout);
  try {
    const response = await fetch(`${API_URL}${path}`, {
      ...options,
      signal: controller.signal,
      headers: {
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...options.headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) {
      let payload;
      try {
        payload = await response.json();
      } catch {
        payload = null;
      }
      throw apiError(payload, response.status);
    }
    if (response.status === 204) return null;
    return responseType === "blob"
      ? await response.blob()
      : await response.json();
  } catch (error) {
    if (error.name === "AbortError" && !signal?.aborted)
      throw new Error("The request timed out. Please try again.");
    if (error instanceof TypeError)
      throw new Error(
        "Unable to reach the media server. Check your connection and try again.",
      );
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}

/** Upload a single file with real byte progress; keep the server's error message intact. */
function upload(
  path,
  file,
  { bucket, onProgress, signal, method = "POST" } = {},
) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const abort = () => xhr.abort();
    const cleanup = () => signal?.removeEventListener("abort", abort);
    try {
      if (signal?.aborted)
        throw new DOMException("Upload cancelled.", "AbortError");
      xhr.open(method, `${API_URL}${path}`);
      xhr.timeout = 600000;
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable)
          onProgress?.(
            Math.min(100, Math.round((event.loaded / event.total) * 100)),
          );
      };
      xhr.onload = () => {
        cleanup();
        let payload;
        try {
          payload = JSON.parse(xhr.responseText);
        } catch {
          payload = null;
        }
        if (xhr.status >= 200 && xhr.status < 300 && payload) resolve(payload);
        else reject(apiError(payload, xhr.status));
      };
      xhr.onerror = () => {
        cleanup();
        reject(
          new Error("Upload failed. Check your connection and try again."),
        );
      };
      xhr.ontimeout = () => {
        cleanup();
        reject(new Error("Upload timed out. Please try again."));
      };
      xhr.onabort = () => {
        cleanup();
        reject(new DOMException("Upload cancelled.", "AbortError"));
      };
      signal?.addEventListener("abort", abort, { once: true });
      const data = new FormData();
      if (bucket) data.append("bucket", bucket);
      data.append("file", file);
      xhr.send(data);
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
}

export const getHealth = (options) => request("/api/health", options);
export const getBuckets = (options) => request("/buckets", options);
export const getAsset = (id, options) =>
  request(`/assets/${encodeURIComponent(id)}`, options);
export const getAssets = (params, options) => {
  const query = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== "" && value !== null && value !== undefined)
      query.set(key, String(value));
  });
  return request(`/assets?${query}`, options);
};
export const uploadAsset = (file, options) => upload("/assets", file, options);
export const replaceAsset = (id, file, options) =>
  upload(`/assets/${encodeURIComponent(id)}/replace`, file, {
    ...options,
    method: "PUT",
  });
export const editAsset = (id, body) =>
  request(`/assets/${encodeURIComponent(id)}`, { method: "PATCH", body });
export const deleteAsset = (id) =>
  request(`/assets/${encodeURIComponent(id)}`, { method: "DELETE" });
export const getOptimized = (id, params, signal) =>
  request(
    `/assets/${encodeURIComponent(id)}/optimized?${new URLSearchParams(params)}`,
    { responseType: "blob", timeout: 120000, signal },
  );

/** Queue a video derivative; poll the asset's variants for its persisted status. */
export const transcodeAsset = (id, body) =>
  request(`/assets/${encodeURIComponent(id)}/transcode`, { method: "POST", body });
