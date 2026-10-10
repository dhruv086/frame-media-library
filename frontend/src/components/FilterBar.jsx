import Icon from "./Icon";
import { FORMATS } from "../utils";

export default function FilterBar({ filters, onChange, onReset }) {
  const active = Object.values(filters).some(Boolean);
  return (
    <div className="filter-bar">
      <div className="search-field">
        <Icon name="search" size={19} />
        <label className="sr-only" htmlFor="search">
          Search by filename
        </label>
        <input
          id="search"
          type="search"
          maxLength={200}
          placeholder="Search by filename…"
          value={filters.q}
          onChange={(event) => onChange("q", event.target.value)}
        />
        {filters.q && (
          <button
            className="icon-button"
            aria-label="Clear search"
            onClick={() => onChange("q", "")}
          >
            <Icon name="close" size={15} />
          </button>
        )}
      </div>
      <div className="filter-control">
        <label htmlFor="format">Format</label>
        <select
          id="format"
          value={filters.format}
          onChange={(event) => onChange("format", event.target.value)}
        >
          <option value="">All formats</option>
          {FORMATS.map((format) => (
            <option key={format} value={format}>
              {format.toUpperCase()}
            </option>
          ))}
        </select>
      </div>
      <div className="filter-control date-control">
        <label htmlFor="date-from">From</label>
        <input
          id="date-from"
          type="date"
          value={filters.from}
          max={filters.to || undefined}
          onChange={(event) => onChange("from", event.target.value)}
        />
      </div>
      <div className="filter-control date-control">
        <label htmlFor="date-to">To</label>
        <input
          id="date-to"
          type="date"
          value={filters.to}
          min={filters.from || undefined}
          onChange={(event) => onChange("to", event.target.value)}
        />
      </div>
      <button className="reset-button" disabled={!active} onClick={onReset}>
        <Icon name="refresh" size={15} />
        Reset
      </button>
    </div>
  );
}
