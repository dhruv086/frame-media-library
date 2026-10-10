import { useRef, useState } from "react";
import { uploadAsset } from "../api/client";
import { ACCEPT, bucketLabel, formatBytes, validateFile } from "../utils";
import Icon from "./Icon";
import Modal from "./Modal";

export default function UploadModal({ bucket, onClose, onDone, notify }) {
  const [files, setFiles] = useState([]);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const input = useRef(null);
  const dragDepth = useRef(0);
  const ready = files.filter((item) => item.status === "ready");
  const completed = files.filter((item) => item.status === "success").length;
  const update = (id, changes) =>
    setFiles((current) =>
      current.map((item) => (item.id === id ? { ...item, ...changes } : item)),
    );

  function addFiles(list) {
    if (busy) return;
    const entries = Array.from(list).map((file) => {
      const error = validateFile(file);
      return {
        id: crypto.randomUUID(),
        file,
        progress: 0,
        status: error ? "invalid" : "ready",
        error,
      };
    });
    setFiles((current) => [...current, ...entries]);
  }

  /** Process files individually so a duplicate or network failure never hides other results. */
  async function startUpload() {
    if (!ready.length || busy) return;
    setBusy(true);
    let succeeded = 0;
    try {
      for (const item of ready) {
        update(item.id, { status: "uploading", error: "" });
        try {
          await uploadAsset(item.file, {
            bucket,
            onProgress: (progress) => update(item.id, { progress }),
          });
          update(item.id, { status: "success", progress: 100 });
          succeeded++;
          notify(`${item.file.name} uploaded.`);
        } catch (error) {
          update(item.id, { status: "error", error: error.message });
          notify(`${item.file.name}: ${error.message}`, "error");
        }
      }
    } finally {
      setBusy(false);
      if (succeeded) onDone();
    }
  }

  return (
    <Modal
      title="Upload assets"
      subtitle={
        <>
          Add images and videos to <strong>{bucketLabel(bucket)}</strong>.
        </>
      }
      onClose={onClose}
      busy={busy}
    >
      <div className="modal-body">
        <input
          ref={input}
          className="sr-only"
          type="file"
          multiple
          accept={ACCEPT}
          disabled={busy}
          aria-label="Choose files to upload"
          onChange={(event) => {
            addFiles(event.target.files);
            event.target.value = "";
          }}
        />
        <button
          type="button"
          className={`drop-zone ${dragging ? "dragging" : ""}`}
          disabled={busy}
          onClick={() => input.current.click()}
          onDragEnter={(event) => {
            event.preventDefault();
            dragDepth.current++;
            setDragging(true);
          }}
          onDragOver={(event) => {
            event.preventDefault();
            event.dataTransfer.dropEffect = "copy";
          }}
          onDragLeave={(event) => {
            event.preventDefault();
            if (--dragDepth.current <= 0) {
              dragDepth.current = 0;
              setDragging(false);
            }
          }}
          onDrop={(event) => {
            event.preventDefault();
            dragDepth.current = 0;
            setDragging(false);
            addFiles(event.dataTransfer.files);
          }}
        >
          <span className="upload-symbol">
            <Icon name="upload" size={27} />
          </span>
          <strong>
            Drop your files here, or <span>browse files</span>
          </strong>
          <span>JPG, JPEG, PNG, WebP, GIF, AVIF, MP4, WebM, MOV</span>
          <small>Up to 200 MB per file · Multiple files welcome</small>
        </button>
        {!!files.length && (
          <div className="upload-list" aria-live="polite">
            {files.map((item) => (
              <div
                key={item.id}
                className={`upload-item upload-${item.status}`}
              >
                <span className="file-symbol">
                  <Icon
                    name={
                      item.status === "success"
                        ? "check"
                        : item.status === "error" || item.status === "invalid"
                          ? "warning"
                          : "image"
                    }
                  />
                </span>
                <div className="upload-item-details">
                  <strong title={item.file.name}>{item.file.name}</strong>
                  <span>
                    {formatBytes(item.file.size)}{" "}
                    <span className="metadata-dot">·</span>{" "}
                    {item.status === "ready"
                      ? "Ready to upload"
                      : item.status === "success"
                        ? "Uploaded successfully"
                        : item.status === "uploading"
                          ? item.progress === 100
                            ? "Processing…"
                            : `Uploading ${item.progress}%`
                          : "Needs attention"}
                  </span>
                  {item.error && <p className="inline-error">{item.error}</p>}
                  {["uploading", "success"].includes(item.status) && (
                    <div
                      className="progress-track"
                      role="progressbar"
                      aria-label={`Upload progress: ${item.file.name}`}
                      aria-valuenow={item.progress}
                      aria-valuemin={0}
                      aria-valuemax={100}
                    >
                      <span style={{ width: `${item.progress}%` }} />
                    </div>
                  )}
                </div>
                {item.status === "error" && (
                  <button
                    className="text-button"
                    disabled={busy}
                    onClick={() =>
                      update(item.id, {
                        status: "ready",
                        progress: 0,
                        error: "",
                      })
                    }
                  >
                    Retry
                  </button>
                )}
                {!busy && item.status !== "success" && (
                  <button
                    className="icon-button"
                    aria-label={`Remove ${item.file.name}`}
                    onClick={() =>
                      setFiles((current) =>
                        current.filter((entry) => entry.id !== item.id),
                      )
                    }
                  >
                    <Icon name="close" size={16} />
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="modal-footer">
        <span className="footer-note">
          {completed
            ? `${completed} uploaded`
            : "Original quality. Safely stored."}
        </span>
        <button className="button secondary" disabled={busy} onClick={onClose}>
          {completed && !ready.length ? "Done" : "Cancel"}
        </button>
        <button
          className="button primary"
          disabled={busy || !ready.length}
          onClick={startUpload}
        >
          {busy ? (
            <span className="spinner" />
          ) : (
            <Icon name="upload" size={17} />
          )}{" "}
          {busy
            ? "Uploading…"
            : `Upload${ready.length ? ` ${ready.length} file${ready.length === 1 ? "" : "s"}` : ""}`}
        </button>
      </div>
    </Modal>
  );
}
