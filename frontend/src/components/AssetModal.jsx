import { useEffect, useState } from "react";
import { getAsset } from "../api/client";
import { assetId } from "../utils";
import Modal from "./Modal";
import PreviewModal from "./PreviewModal";
import ReplaceModal from "./ReplaceModal";
import EditModal from "./EditModal";
import ConfirmDialog from "./ConfirmDialog";

const dialogs = {
  preview: PreviewModal,
  replace: ReplaceModal,
  edit: EditModal,
  delete: ConfirmDialog,
};

/** Load current metadata for asset actions and cancel the request when dismissed. */
export default function AssetModal({ type, asset, onClose, onDone, notify }) {
  const id = assetId(asset);
  const [current, setCurrent] = useState(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      setError("");
      try {
        const result = await getAsset(id, { signal: controller.signal });
        if (!controller.signal.aborted) setCurrent(result);
      } catch (failure) {
        if (!controller.signal.aborted) {
          setError(failure.message);
          notify(failure.message, "error");
        }
      }
    }
    load();
    return () => controller.abort();
  }, [id, attempt, notify]);

  if (current) {
    const Dialog = dialogs[type];
    return (
      <Dialog
        asset={current}
        onClose={onClose}
        onDone={onDone}
        notify={notify}
      />
    );
  }

  return (
    <Modal
      title={error ? "Could not load asset" : "Loading asset…"}
      subtitle={asset.originalName}
      onClose={onClose}
    >
      <div className="modal-body" role="status" aria-live="polite">
        {error ? (
          <>
            <p className="inline-error">{error}</p>
            <button
              className="button secondary"
              onClick={() => setAttempt((value) => value + 1)}
            >
              Try again
            </button>
          </>
        ) : (
          <p>
            <span className="spinner" /> Loading the latest asset details…
          </p>
        )}
      </div>
    </Modal>
  );
}
