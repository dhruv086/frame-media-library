import { useState } from "react";
import { deleteAsset } from "../api/client";
import { assetId } from "../utils";
import Modal from "./Modal";
import Icon from "./Icon";

export default function ConfirmDialog({ asset, onClose, onDone, notify }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function confirm() {
    setBusy(true);
    setError("");
    try {
      await deleteAsset(assetId(asset));
      onDone();
      notify(`${asset.originalName} deleted.`);
      onClose();
    } catch (failure) {
      setError(failure.message);
      notify(failure.message, "error");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title="Delete this asset?" onClose={onClose} busy={busy}>
      <div className="modal-body">
        <div className="delete-symbol">
          <Icon name="trash" size={25} />
        </div>
        <p className="delete-description">
          <strong>{asset.originalName}</strong> and its generated variants will
          be permanently deleted. Links to this asset will stop working.
        </p>
        {error && (
          <p className="inline-error" role="alert">
            {error}
          </p>
        )}
      </div>
      <div className="modal-footer">
        <button className="button secondary" disabled={busy} onClick={onClose}>
          Keep asset
        </button>
        <button className="button danger" disabled={busy} onClick={confirm}>
          {busy && <span className="spinner" />}
          {busy ? "Deleting…" : "Delete asset"}
        </button>
      </div>
    </Modal>
  );
}
