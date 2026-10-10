export const FORMATS = [
  "jpg",
  "jpeg",
  "png",
  "webp",
  "gif",
  "avif",
  "mp4",
  "webm",
  "mov",
];
export const ACCEPT = FORMATS.map((format) => `.${format}`).join(",");
export const MAX_FILE_SIZE = 200 * 1024 * 1024;
export const bucketLabel = (name) =>
  name === "dev-assets" ? "Dhruv-assets" : name;
export const assetId = (asset) => asset.id || asset._id;
export const extension = (name = "") =>
  name.includes(".") ? name.split(".").pop().toLowerCase() : "";
export const isVideo = (asset) =>
  asset.mimeType?.startsWith("video/") ||
  ["mp4", "webm", "mov"].includes(asset.format?.toLowerCase());

export function formatBytes(bytes = 0) {
  if (!Number.isFinite(Number(bytes)) || Number(bytes) <= 0) return "0 B";
  const index = Math.min(
    Math.floor(Math.log(Number(bytes)) / Math.log(1024)),
    3,
  );
  return `${(Number(bytes) / 1024 ** index).toLocaleString(undefined, { maximumFractionDigits: index ? 1 : 0 })} ${["B", "KB", "MB", "GB"][index]}`;
}

export function formatDuration(seconds) {
  if (seconds === null || seconds === undefined) return "—";
  const rounded = Math.round(seconds);
  return `${Math.floor(rounded / 60)}:${String(rounded % 60).padStart(2, "0")}`;
}

export const formatDate = (date) =>
  date && Number.isFinite(new Date(date).getTime())
    ? new Date(date).toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
      })
    : "—";

/** Add a UI-only version parameter without changing the stored or copied asset URL. */
export function versionedUrl(url, version = 1) {
  if (!url) return "";
  const [base, fragment] = url.split("#");
  const separator = base.includes("?") ? "&" : "?";
  return `${base}${separator}v=${encodeURIComponent(version)}${fragment ? `#${fragment}` : ""}`;
}

/** Validate before sending bytes, with strict extension equality for replacements. */
export function validateFile(file, requiredFormat) {
  if (!file) return "Choose a file to continue.";
  const format = extension(file.name);
  if (!FORMATS.includes(format))
    return "Unsupported format. Choose a JPG, JPEG, PNG, WebP, GIF, AVIF, MP4, WebM, or MOV file.";
  if (requiredFormat && format !== requiredFormat.toLowerCase())
    return `Choose a .${requiredFormat} file. The extension must match the current asset.`;
  if (file.size > MAX_FILE_SIZE) return "This file exceeds the 200 MB limit.";
  if (file.size === 0) return "This file is empty. Choose another file.";
  return "";
}

export function expiryStatus(expiresAt, now = Date.now()) {
  if (!expiresAt) return null;
  const remaining = new Date(expiresAt).getTime() - now;
  if (remaining <= 0) return "Expired";
  return remaining <= 7 * 86400000 ? "Expires soon" : null;
}
