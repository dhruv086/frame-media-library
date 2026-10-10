import { useState } from "react";
import Icon from "./Icon";
import {
  expiryStatus,
  formatBytes,
  formatDuration,
  isVideo,
  versionedUrl,
} from "../utils";

export default function AssetCard({ asset, onAction }) {
  const [failedSource, setFailedSource] = useState("");
  const thumbnail = versionedUrl(asset.thumbnailUrl, asset.version);
  const video = isVideo(asset);
  const expiry = expiryStatus(asset.expiresAt);
  return (
    <article className="asset-card">
      <button
        className="asset-thumbnail"
        onClick={() => onAction("preview", asset)}
        aria-label={`Preview ${asset.originalName}`}
      >
        {thumbnail && failedSource !== thumbnail ? (
          <img
            src={thumbnail}
            alt={asset.altText || asset.originalName}
            loading="lazy"
            onError={() => setFailedSource(thumbnail)}
          />
        ) : (
          <div className="thumbnail-fallback">
            <Icon name={video ? "video" : "image"} size={38} />
            <span>Preview unavailable</span>
          </div>
        )}
        <span className="thumbnail-kind">
          <Icon name={video ? "video" : "image"} size={13} />
          {video ? "VIDEO" : "IMAGE"}
        </span>
        {video && (
          <>
            <span className="play-overlay">
              <Icon name="play" size={22} />
            </span>
            {asset.duration != null && (
              <span className="duration">{formatDuration(asset.duration)}</span>
            )}
          </>
        )}
        {expiry && <span className="expiry-badge">{expiry}</span>}
        <span className="thumbnail-hover">
          <Icon name="eye" size={18} />
          Preview asset
        </span>
      </button>
      <div className="card-body">
        <div className="card-title-row">
          <h3 title={asset.originalName}>{asset.originalName}</h3>
          <span className="version">v{asset.version || 1}</span>
        </div>
        <div className="card-metadata">
          <span className={`format-badge ${video ? "format-video" : ""}`}>
            {asset.format?.toUpperCase()}
          </span>
          <span>{formatBytes(asset.size)}</span>
          {asset.width && asset.height && (
            <>
              <span className="metadata-dot">·</span>
              <span>
                {asset.width} × {asset.height}
              </span>
            </>
          )}
        </div>
        <div className="card-actions">
          <button
            className="preview-button"
            onClick={() => onAction("preview", asset)}
          >
            <Icon name="eye" size={16} />
            Preview
          </button>
          <div>
            {[
              ["replace", "replace", "Replace"],
              ["edit", "edit", "Edit metadata"],
              ["copy", "link", "Copy URL"],
              ["delete", "trash", "Delete"],
            ].map(([action, icon, label]) => (
              <button
                key={action}
                className={`icon-button ${action === "delete" ? "danger-icon" : ""}`}
                title={label}
                aria-label={`${label}: ${asset.originalName}`}
                onClick={() => onAction(action, asset)}
              >
                <Icon name={icon} size={16} />
              </button>
            ))}
          </div>
        </div>
      </div>
    </article>
  );
}
