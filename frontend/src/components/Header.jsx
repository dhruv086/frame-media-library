import BucketSelect from "./BucketSelect";
import Icon from "./Icon";

export default function Header({
  buckets,
  bucket,
  onBucketChange,
  bucketLoading,
  onUpload,
  connected,
  loading,
}) {
  return (
    <header className="header">
      <div className="header-inner">
        <a href="#main" className="brand" aria-label="Frame media library">
          <span className="brand-mark">
            <span />
          </span>
          <span>
            frame<span className="brand-dot">.</span>
          </span>
          <span className="brand-divider" />
          <span className="brand-subtitle">Media workspace</span>
        </a>
        <div className="header-actions">
          <span
            className={`connection ${connected ? "" : "connection-offline"}`}
          >
            <i />
            {loading ? "Connecting" : connected ? "Connected" : "Unavailable"}
          </span>
          <BucketSelect
            buckets={buckets}
            bucket={bucket}
            onChange={onBucketChange}
            loading={bucketLoading}
          />
          <button
            className="button primary"
            onClick={onUpload}
            disabled={!bucket || bucketLoading}
          >
            <Icon name="plus" size={18} />
            <span>Upload assets</span>
          </button>
        </div>
      </div>
    </header>
  );
}
