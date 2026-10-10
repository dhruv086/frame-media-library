export default function Skeleton({ count = 8 }) {
  return (
    <div className="asset-grid" aria-busy="true" aria-label="Loading assets">
      {Array.from({ length: count }, (_, index) => (
        <div
          key={index}
          className="asset-card skeleton-card"
          aria-hidden="true"
        >
          <div className="skeleton skeleton-image" />
          <div className="card-body">
            <div className="skeleton skeleton-line" />
            <div className="skeleton skeleton-line short" />
            <div className="skeleton skeleton-actions" />
          </div>
        </div>
      ))}
    </div>
  );
}
