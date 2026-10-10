import { useCallback, useEffect, useRef, useState } from "react";
import { getOptimized } from "../api/client";
import {
  assetId,
  bucketLabel,
  formatBytes,
  formatDate,
  formatDuration,
  isVideo,
  versionedUrl,
} from "../utils";
import Icon from "./Icon";
import Modal from "./Modal";
import VideoOptimizationPanel from "./VideoOptimizationPanel";

/** Read the decoded output dimensions rather than assuming the requested width. */
async function imageDimensions(url) {
  const image = new Image();
  image.src = url;
  await image.decode();
  if (!image.naturalWidth || !image.naturalHeight)
    throw new Error("The optimized image could not be decoded.");
  return { width: image.naturalWidth, height: image.naturalHeight };
}

export default function PreviewModal({ asset, onClose, notify }) {
  const [width, setWidth] = useState(
    String(Math.min(asset.width || 1200, 4000)),
  );
  const [quality, setQuality] = useState(80);
  const [format, setFormat] = useState("webp");
  const [busy, setBusy] = useState(false);
  const [variant, setVariant] = useState(null);
  const [showVariant, setShowVariant] = useState(false);
  const [error, setError] = useState("");
  const [mediaError, setMediaError] = useState(false);
  const objectUrl = useRef(null);
  const controller = useRef(null);
  const video = isVideo(asset);
  const original = versionedUrl(asset.url, asset.version);
  const activeVariant = showVariant ? variant : null;
  const displayed = activeVariant || asset;
  const source = activeVariant ? activeVariant.url : original;
  const settingsChanged =
    !video && variant &&
    (Number(width) !== variant.requestedWidth ||
      quality !== variant.quality ||
      format !== variant.format);
  const savings =
    variant && asset.size > 0 ? (1 - variant.size / asset.size) * 100 : 0;
  const showVideoVariant = useCallback((result) => {
    setVariant(result);
    setShowVariant(true);
    setMediaError(false);
  }, []);
  useEffect(
    () => () => {
      controller.current?.abort();
      if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
    },
    [],
  );
  useEffect(() => {
    setMediaError(false);
  }, [source]);

  /** Fetch the optimized bytes so the displayed size and saving reflect the actual output. */
  async function optimize(event) {
    event.preventDefault();
    if (!/^\d+$/.test(width) || Number(width) < 1 || Number(width) > 4000) {
      setError("Width must be a whole number between 1 and 4000.");
      return;
    }
    setBusy(true);
    setError("");
    const current = new AbortController();
    controller.current = current;
    let pendingUrl;
    try {
      const blob = await getOptimized(
        assetId(asset),
        { w: width, q: quality, format },
        current.signal,
      );
      if (!blob.size || !blob.type.startsWith("image/"))
        throw new Error("The server did not return a valid optimized image.");
      current.signal.throwIfAborted();
      pendingUrl = URL.createObjectURL(blob);
      const dimensions = await imageDimensions(pendingUrl);
      current.signal.throwIfAborted();
      if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
      objectUrl.current = pendingUrl;
      pendingUrl = null;
      setVariant({
        url: objectUrl.current,
        size: blob.size,
        format,
        ...dimensions,
        requestedWidth: Number(width),
        quality,
      });
      setShowVariant(true);
      notify("Optimized variant is ready.");
    } catch (failure) {
      if (!current.signal.aborted) {
        setError(failure.message);
        notify(failure.message, "error");
      }
    } finally {
      if (pendingUrl) URL.revokeObjectURL(pendingUrl);
      if (!current.signal.aborted) setBusy(false);
    }
  }

  return (
    <Modal
      title={asset.originalName}
      subtitle={`${video ? "Video" : "Image"} preview · Version ${asset.version || 1}`}
      onClose={onClose}
      wide
    >
      <div className="preview-layout">
        <div className="preview-main">
          <div className="preview-media">
            {mediaError ? (
              <div className="media-error">
                <Icon name="image" size={38} />
                <strong>Preview couldn’t be loaded</strong>
                <p>
                  The original may be unavailable or this format may not be
                  supported by your browser.
                </p>
                <a
                  className="button secondary"
                  href={original}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open original
                  <Icon name="external" size={15} />
                </a>
              </div>
            ) : video ? (
              <video
                key={source}
                src={source}
                controls
                playsInline
                preload="metadata"
                poster={versionedUrl(asset.thumbnailUrl, asset.version)}
                aria-label={asset.altText || asset.originalName}
                onError={() => {
                  setMediaError(true);
                  notify("Video preview could not be loaded.", "error");
                }}
              />
            ) : (
              <img
                src={source}
                alt={asset.altText || asset.originalName}
                onError={() => {
                  setMediaError(true);
                  notify("Image preview could not be loaded.", "error");
                }}
              />
            )}
            <span className="preview-source-label">
              {activeVariant
                ? `${activeVariant.format.toUpperCase()} · ${activeVariant.width} × ${activeVariant.height} px · ${video ? activeVariant.codec.toUpperCase() : `Q${activeVariant.quality}`}`
                : "ORIGINAL"}
            </span>
          </div>
          <div className="preview-toolbar">
            <span>
              {formatBytes(displayed.size)}
              {displayed.width && displayed.height
                ? ` · ${displayed.width} × ${displayed.height} px`
                : ""}
            </span>
            {variant && (
              <div className="segmented">
                <button
                  className={!showVariant ? "selected" : ""}
                  aria-pressed={!showVariant}
                  onClick={() => setShowVariant(false)}
                >
                  Original
                </button>
                <button
                  className={showVariant ? "selected" : ""}
                  aria-pressed={showVariant}
                  onClick={() => setShowVariant(true)}
                >
                  Optimized
                </button>
              </div>
            )}
            <div className="preview-links">
              <a href={original} target="_blank" rel="noreferrer">
                Open original
                <Icon name="external" size={14} />
              </a>
              {variant && (
                <a href={variant.url} target="_blank" rel="noreferrer">
                  Open optimized
                  <Icon name="external" size={14} />
                </a>
              )}
            </div>
          </div>
          {!video && (
            <p className="field-help preview-size-hint">
              Images display at their actual size or scale down to fit this preview.
            </p>
          )}
          {!video && (
            <form className="optimization-panel" onSubmit={optimize}>
              <div className="panel-title">
                <span className="panel-icon">
                  <Icon name="sparkles" size={19} />
                </span>
                <div>
                  <h3>Optimized variant</h3>
                  <p>Change settings, then select Generate preview.</p>
                </div>
              </div>
              <div className="optimization-controls">
                <div>
                  <label className="field-label" htmlFor="variant-width">
                    Width <span className="optional">px</span>
                  </label>
                  <input
                    id="variant-width"
                    type="number"
                    min="1"
                    max="4000"
                    step="1"
                    required
                    disabled={busy}
                    value={width}
                    onChange={(event) => setWidth(event.target.value)}
                  />
                </div>
                <div>
                  <label className="field-label" htmlFor="variant-format">
                    Format
                  </label>
                  <select
                    id="variant-format"
                    value={format}
                    disabled={busy}
                    onChange={(event) => setFormat(event.target.value)}
                  >
                    {["webp", "avif", "jpeg", "png"].map((item) => (
                      <option key={item} value={item}>
                        {item.toUpperCase()}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="quality-control">
                  <label className="field-label" htmlFor="variant-quality">
                    Quality <span>{quality}%</span>
                  </label>
                  <input
                    id="variant-quality"
                    type="range"
                    min="1"
                    max="100"
                    value={quality}
                    disabled={busy}
                    onChange={(event) => setQuality(Number(event.target.value))}
                  />
                </div>
              </div>
              {error && (
                <p className="inline-error" role="alert">
                  {error}
                </p>
              )}
              {settingsChanged && (
                <p className="field-help" role="status">
                  Settings changed. Select Generate preview to apply them.
                </p>
              )}
              <div className="optimization-footer">
                {variant ? (
                  <span className="savings">
                    {formatBytes(variant.size)} · {Math.abs(savings).toFixed(1)}
                    % {savings >= 0 ? "smaller" : "larger"}
                    {savings < 0 && " — try a lower quality"}
                  </span>
                ) : (
                  <span className="field-help">
                    Your original stays intact.
                  </span>
                )}
                <button
                  type="submit"
                  className="button primary"
                  disabled={busy}
                >
                  {busy ? (
                    <span className="spinner" />
                  ) : (
                    <Icon name="sparkles" size={16} />
                  )}{" "}
                  {busy ? "Optimizing…" : "Generate preview"}
                </button>
              </div>
            </form>
          )}
          {video && <VideoOptimizationPanel asset={asset} onReady={showVideoVariant} notify={notify} />}
        </div>
        <aside className="preview-details">
          <h3>{activeVariant ? "Optimized details" : "Original asset details"}</h3>
          <dl className="metadata-list">
            <div>
              <dt>Format</dt>
              <dd>
                <span className="format-badge">
                  {displayed.format?.toUpperCase()}
                </span>
              </dd>
            </div>
            <div>
              <dt>Dimensions</dt>
              <dd>
                {displayed.width && displayed.height
                  ? `${displayed.width} × ${displayed.height} px`
                  : "—"}
              </dd>
            </div>
            {video && (
              <div>
                <dt>Duration</dt>
                <dd>{formatDuration(displayed.duration)}</dd>
              </div>
            )}
            {video && <>
              <div><dt>Video codec</dt><dd>{(displayed.videoCodec || displayed.codec || "Unknown").toUpperCase()}</dd></div>
              <div><dt>Audio codec</dt><dd>{displayed.audioCodec?.toUpperCase() || "No audio"}</dd></div>
              <div><dt>{activeVariant ? "Actual total bitrate" : "Video bitrate"}</dt><dd>{(displayed.measuredBitrate || displayed.videoBitrate) ? `${Math.round((displayed.measuredBitrate || displayed.videoBitrate) / 1000)} kbps` : "Unavailable"}</dd></div>
            </>}
            <div>
              <dt>File size</dt>
              <dd>{formatBytes(displayed.size)}</dd>
            </div>
            <div>
              <dt>Bucket</dt>
              <dd>{bucketLabel(asset.bucket)}</dd>
            </div>
            <div>
              <dt>Uploaded</dt>
              <dd>{formatDate(asset.createdAt)}</dd>
            </div>
            <div>
              <dt>Expires</dt>
              <dd>
                {asset.expiresAt ? formatDate(asset.expiresAt) : "No expiry"}
              </dd>
            </div>
            <div className="metadata-full">
              <dt>Original storage key</dt>
              <dd className="mono">{asset.key}</dd>
            </div>
            <div className="metadata-full">
              <dt>Original URL</dt>
              <dd>
                <a
                  className="metadata-url"
                  href={asset.url}
                  target="_blank"
                  rel="noreferrer"
                >
                  {asset.url}
                </a>
              </dd>
            </div>
            <div className="metadata-full">
              <dt>Alt text</dt>
              <dd>
                {asset.altText || (
                  <span className="muted">No alt text added</span>
                )}
              </dd>
            </div>
            <div className="metadata-full">
              <dt>Tags</dt>
              <dd className="tags">
                {asset.tags?.length ? (
                  asset.tags.map((tag) => (
                    <span className="tag" key={tag}>
                      {tag}
                    </span>
                  ))
                ) : (
                  <span className="muted">No tags added</span>
                )}
              </dd>
            </div>
          </dl>
        </aside>
      </div>
    </Modal>
  );
}
