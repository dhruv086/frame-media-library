import { useState } from "react";
import { editAsset } from "../api/client";
import { assetId } from "../utils";
import Icon from "./Icon";
import Modal from "./Modal";

export default function EditModal({ asset, onClose, onDone, notify }) {
  const [altText, setAltText] = useState(asset.altText || "");
  const [tags, setTags] = useState(asset.tags || []);
  const [tagInput, setTagInput] = useState("");
  const [expiresAt, setExpiresAt] = useState(
    asset.expiresAt?.slice(0, 10) || "",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const parseTags = (value) =>
    value
      .split(",")
      .map((tag) => tag.trim())
      .filter(Boolean);
  const addTags = () => {
    setTags((current) => [...new Set([...current, ...parseTags(tagInput)])]);
    setTagInput("");
  };

  /** Include pending tag text and serialize a clearable end-of-day UTC expiry. */
  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const updated = await editAsset(assetId(asset), {
        altText,
        tags: [...new Set([...tags, ...parseTags(tagInput)])],
        expiresAt: expiresAt ? `${expiresAt}T23:59:59.999Z` : null,
      });
      onDone(updated);
      notify("Asset details saved.");
      onClose();
    } catch (failure) {
      setError(failure.message);
      notify(failure.message, "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Edit asset details"
      subtitle={asset.originalName}
      onClose={onClose}
      busy={busy}
    >
      <form onSubmit={submit}>
        <div className="modal-body form-stack">
          <div>
            <label className="field-label" htmlFor="alt-text">
              Alt text
            </label>
            <textarea
              id="alt-text"
              rows={3}
              value={altText}
              disabled={busy}
              placeholder="Describe what’s in this asset…"
              onChange={(event) => setAltText(event.target.value)}
            />
            <p className="field-help">
              A useful description makes your media more accessible.
            </p>
          </div>
          <div>
            <label className="field-label" htmlFor="tag-input">
              Tags
            </label>
            <div className="tag-input-wrapper">
              {tags.map((tag) => (
                <span className="tag" key={tag}>
                  {tag}
                  <button
                    type="button"
                    disabled={busy}
                    aria-label={`Remove tag ${tag}`}
                    onClick={() =>
                      setTags((current) =>
                        current.filter((item) => item !== tag),
                      )
                    }
                  >
                    <Icon name="close" size={12} />
                  </button>
                </span>
              ))}
              <input
                id="tag-input"
                value={tagInput}
                disabled={busy}
                placeholder={tags.length ? "Add another…" : "Add a tag…"}
                onChange={(event) => setTagInput(event.target.value)}
                onBlur={addTags}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === ",") {
                    event.preventDefault();
                    addTags();
                  }
                }}
              />
            </div>
            <p className="field-help">Press Enter or comma to add a tag.</p>
          </div>
          <div>
            <label className="field-label" htmlFor="expiry">
              Expiry date <span className="optional">Optional</span>
            </label>
            <div className="inline-field">
              <input
                id="expiry"
                type="date"
                value={expiresAt}
                disabled={busy}
                onChange={(event) => setExpiresAt(event.target.value)}
              />
              <button
                type="button"
                className="button secondary"
                disabled={busy || !expiresAt}
                onClick={() => setExpiresAt("")}
              >
                Clear
              </button>
            </div>
            <p className="field-help">
              Expires at the end of the selected day (UTC). Leave empty for no
              expiry.
            </p>
          </div>
          {error && (
            <p className="inline-error" role="alert">
              {error}
            </p>
          )}
        </div>
        <div className="modal-footer">
          <button
            type="button"
            className="button secondary"
            disabled={busy}
            onClick={onClose}
          >
            Cancel
          </button>
          <button className="button primary" type="submit" disabled={busy}>
            {busy && <span className="spinner" />}
            {busy ? "Saving…" : "Save changes"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
