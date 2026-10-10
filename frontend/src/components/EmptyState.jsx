import Icon from "./Icon";

export default function EmptyState({ filtered, onUpload, onReset, disabled }) {
  return (
    <div className="empty-state">
      <div className="empty-art">
        <span className="empty-art-back" />
        <span className="empty-art-front">
          <Icon name={filtered ? "search" : "image"} size={34} />
        </span>
        <span className="empty-art-dot" />
      </div>
      <h3>
        {filtered
          ? "No assets match your search"
          : "Make room for your next great idea."}
      </h3>
      <p>
        {filtered
          ? "Try another filename, a different format, or a wider date range."
          : "Give your images and videos a home. Upload your first assets to get started."}
      </p>
      <button
        className={`button ${filtered ? "secondary" : "primary"}`}
        onClick={filtered ? onReset : onUpload}
        disabled={disabled}
      >
        {!filtered && <Icon name="plus" size={18} />}{" "}
        {filtered ? "Clear filters" : "Upload your first asset"}
      </button>
      {!filtered && (
        <span className="empty-hint">
          Images & videos · Up to 200 MB per file
        </span>
      )}
    </div>
  );
}
