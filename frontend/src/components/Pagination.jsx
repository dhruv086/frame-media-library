import Icon from "./Icon";

export default function Pagination({
  page,
  totalPages,
  total,
  limit,
  onChange,
  disabled,
}) {
  if (!total) return null;
  const pages = [...new Set([1, page - 1, page, page + 1, totalPages])]
    .filter((number) => number >= 1 && number <= totalPages)
    .sort((a, b) => a - b);
  return (
    <div className="pagination">
      <span>
        Showing{" "}
        <strong>
          {(page - 1) * limit + 1}–{Math.min(page * limit, total)}
        </strong>{" "}
        of <strong>{total}</strong> assets
      </span>
      <nav aria-label="Gallery pagination">
        <button
          className="page-button"
          aria-label="Previous page"
          disabled={page === 1 || disabled}
          onClick={() => onChange(page - 1)}
        >
          <Icon name="chevron" className="rotate" size={16} />
        </button>
        {pages.map((number, index) => (
          <span key={number} className="page-entry">
            {index > 0 && number - pages[index - 1] > 1 && (
              <span className="page-ellipsis">…</span>
            )}
            <button
              className={`page-button ${page === number ? "current" : ""}`}
              aria-label={`Page ${number}`}
              aria-current={page === number ? "page" : undefined}
              disabled={disabled}
              onClick={() => onChange(number)}
            >
              {number}
            </button>
          </span>
        ))}
        <button
          className="page-button"
          aria-label="Next page"
          disabled={page >= totalPages || disabled}
          onClick={() => onChange(page + 1)}
        >
          <Icon name="chevron" size={16} />
        </button>
      </nav>
    </div>
  );
}
