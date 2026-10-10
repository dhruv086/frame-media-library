import { useState } from "react";
import { replaceAsset } from "../api/client";
import { assetId, formatBytes, validateFile } from "../utils";
import Icon from "./Icon";
import Modal from "./Modal";

export default function ReplaceModal({ asset, onClose, onDone, notify }) {
  const [file, setFile] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [result, setResult] = useState(null);

  async function submit(event) {
    event.preventDefault();
    const validation = validateFile(file, asset.format);
    if (validation) {
      setError(validation);
      return;
    }
    setBusy(true);
    setError("");
    try {
      const updated = await replaceAsset(assetId(asset), file, {
        onProgress: setProgress,
      });
      setResult(updated);
      onDone(updated);
      notify(
        `Content replaced. ${asset.originalName} is now v${updated.version}.`,
      );
    } catch (failure) {
      setError(failure.message);
      notify(failure.message, "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Replace asset"
      subtitle={asset.originalName}
      onClose={onClose}
      busy={busy}
    >
      <form onSubmit={submit}>
        <div className="modal-body">
          <div className="info-panel">
            <Icon name="replace" size={22} />
            <div>
              <strong>A fresh version, the same address.</strong>
              <p>
                The URL and filename stay the same, only the content changes.
                Your existing links will keep working.
              </p>
            </div>
          </div>
          {result ? (
            <div className="success-panel" role="status">
              <Icon name="check" size={28} />
              <h3>Replacement complete</h3>
              <p>
                Version {asset.version || 1} →{" "}
                <strong>Version {result.version}</strong>
              </p>
              <label htmlFor="same-url">Your unchanged URL</label>
              <input id="same-url" readOnly value={result.url} />
            </div>
          ) : (
            <>
              <label className="field-label" htmlFor="replacement">
                New .{asset.format} file
              </label>
              <input
                id="replacement"
                type="file"
                accept={`.${asset.format}`}
                disabled={busy}
                aria-describedby="replacement-help replacement-error"
                onChange={(event) => {
                  const selected = event.target.files[0];
                  setFile(selected || null);
                  setError(
                    selected ? validateFile(selected, asset.format) : "",
                  );
                  setProgress(0);
                }}
              />
              <p id="replacement-help" className="field-help">
                The extension must be .{asset.format}. Maximum file size: 200
                MB.
              </p>
              {file && (
                <p className="field-help">
                  {file.name} · {formatBytes(file.size)}
                </p>
              )}
              {error && (
                <p id="replacement-error" className="inline-error" role="alert">
                  {error}
                </p>
              )}
              {busy && (
                <div className="progress-block">
                  <span>
                    {progress === 100
                      ? "Processing your replacement…"
                      : `Uploading… ${progress}%`}
                  </span>
                  <div
                    className="progress-track"
                    role="progressbar"
                    aria-label="Replacement upload progress"
                    aria-valuenow={progress}
                    aria-valuemin={0}
                    aria-valuemax={100}
                  >
                    <span style={{ width: `${progress}%` }} />
                  </div>
                </div>
              )}
            </>
          )}
        </div>
        <div className="modal-footer">
          <button
            type="button"
            className="button secondary"
            disabled={busy}
            onClick={onClose}
          >
            {result ? "Done" : "Cancel"}
          </button>
          {!result && (
            <button
              type="submit"
              className="button primary"
              disabled={busy || !file || !!validateFile(file, asset.format)}
            >
              {busy && <span className="spinner" />}
              {busy ? "Replacing…" : "Replace content"}
            </button>
          )}
        </div>
      </form>
    </Modal>
  );
}
