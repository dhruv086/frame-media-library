import { useEffect, useState } from "react";
import { getAsset, transcodeAsset } from "../api/client";
import { assetId, formatBytes } from "../utils";
import Icon from "./Icon";

/** Configure video encoding, poll its persisted job, and preview ready derivatives. */
export default function VideoOptimizationPanel({ asset, onReady, notify }) {
  const [resolution, setResolution] = useState(720);
  const [bitrate, setBitrate] = useState("2500");
  const [codec, setCodec] = useState("h264");
  const [crf, setCrf] = useState(28);
  const [variants, setVariants] = useState(asset.variants || []);
  const [job, setJob] = useState(() => asset.variants?.find((item) => ["queued", "processing"].includes(item.status)) || null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const busy = submitting || ["queued", "processing"].includes(job?.status);

  useEffect(() => {
    if (!job || !["queued", "processing"].includes(job.status)) return;
    const controller = new AbortController();
    const started = Date.now();
    let timer;
    async function poll() {
      try {
        const updated = await getAsset(assetId(asset), { signal: controller.signal });
        if (controller.signal.aborted) return;
        setVariants(updated.variants || []);
        const current = updated.variants?.find((item) => item.key === job.key);
        if (!current) throw new Error("The original changed or this variant was removed. Reopen the preview to try again.");
        setJob(current);
        if (current.status === "ready") {
          onReady(current);
          notify("Optimized video is ready.");
        } else if (current.status === "failed") {
          setError(current.error || "Video processing failed. Select Retry optimization.");
        } else if (Date.now() - started > 15 * 60 * 1000) {
          throw new Error("Processing is taking longer than expected. Reopen the preview to check its status.");
        } else timer = setTimeout(poll, 1000);
      } catch (failure) {
        if (!controller.signal.aborted) {
          setError(failure.message);
          setJob((current) => current ? { ...current, status: "failed" } : null);
        }
      }
    }
    timer = setTimeout(poll, 1000);
    return () => { controller.abort(); clearTimeout(timer); };
  }, [asset.id, asset._id, job?.key, job?.status, onReady, notify]);

  async function submit(event) {
    event.preventDefault();
    if (!/^\d+$/.test(bitrate) || Number(bitrate) < 100 || Number(bitrate) > 20000) {
      setError("Bitrate must be a whole number between 100 and 20000 kbps.");
      return;
    }
    setSubmitting(true);
    setError("");
    try {
      const result = await transcodeAsset(assetId(asset), { resolution, bitrate: Number(bitrate), codec, crf });
      setVariants((current) => [...current.filter((item) => item.key !== result.variant.key), result.variant]);
      setJob(result.variant);
      if (result.variant.status === "ready") {
        onReady(result.variant);
        notify("Cached optimized video is ready.");
      }
    } catch (failure) { setError(failure.message); }
    finally { setSubmitting(false); }
  }

  const ready = variants.filter((item) => item.status === "ready" && item.version === asset.version);
  return (
    <form className="optimization-panel video-optimization-panel" onSubmit={submit}>
      <div className="panel-title">
        <span className="panel-icon"><Icon name="video" size={19} /></span>
        <div><h3>Optimized video</h3><p>Choose resolution, bitrate, codec, and quality.</p></div>
      </div>
      <div className="optimization-controls video-optimization-controls">
        <div>
          <label className="field-label" htmlFor="video-resolution">Resolution limit</label>
          <select id="video-resolution" value={resolution} disabled={busy} onChange={(event) => {
            const value = Number(event.target.value);
            setResolution(value);
            setBitrate(String({ 480: 1000, 720: 2500, 1080: 5000 }[value]));
          }}>
            <option value="480">480p · Small</option><option value="720">720p · Balanced</option><option value="1080">1080p · High</option>
          </select>
        </div>
        <div>
          <label className="field-label" htmlFor="video-codec">Codec / format</label>
          <select id="video-codec" value={codec} disabled={busy} onChange={(event) => setCodec(event.target.value)}>
            <option value="h264">H.264 / MP4</option><option value="vp9">VP9 / WebM</option>
          </select>
        </div>
        <div>
          <label className="field-label" htmlFor="video-bitrate">Video bitrate limit <span className="optional">kbps</span></label>
          <input id="video-bitrate" type="number" min="100" max="20000" step="1" required value={bitrate} disabled={busy} onChange={(event) => setBitrate(event.target.value)} />
        </div>
        <div>
          <label className="field-label" htmlFor="video-crf">Quality <span>CRF {crf}</span></label>
          <input id="video-crf" type="range" min="18" max="40" value={crf} disabled={busy} onChange={(event) => setCrf(Number(event.target.value))} />
        </div>
      </div>
      <p className="field-help">Resolution preserves aspect ratio without enlarging the original. Lower CRF means higher quality. Actual bitrate varies with the video.</p>
      {error && <p className="inline-error" role="alert">{error}</p>}
      {busy && <p className="field-help" role="status">{job?.status === "processing" ? "Encoding video…" : "Waiting for video processing…"} Processing continues if you close this preview.</p>}
      <div className="optimization-footer">
        <span className="field-help">Your original stays intact.</span>
        <button type="submit" className="button primary" disabled={busy}>
          {busy ? <span className="spinner" /> : <Icon name="sparkles" size={16} />}{" "}
          {busy ? "Processing…" : error || job?.status === "failed" ? "Retry optimization" : "Generate video preview"}
        </button>
      </div>
      {ready.length > 0 && <div className="video-variants">
        <h4>Saved video variants</h4>
        {ready.map((item) => {
          const savings = asset.size > 0 ? (1 - item.size / asset.size) * 100 : 0;
          return <button type="button" className="video-variant button secondary" key={item.key} onClick={() => onReady(item)}>
            <span>{item.codec.toUpperCase()} · {item.width} × {item.height} px · {formatBytes(item.size)}</span>
            <span>{Math.abs(savings).toFixed(1)}% {savings >= 0 ? "smaller" : "larger"} · {Math.round(item.measuredBitrate / 1000)} kbps actual</span>
          </button>;
        })}
      </div>}
    </form>
  );
}
