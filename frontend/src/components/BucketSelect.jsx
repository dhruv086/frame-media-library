import Icon from "./Icon";
import { bucketLabel } from "../utils";

export default function BucketSelect({ buckets, bucket, onChange, loading }) {
  return (
    <div className="bucket-control">
      <Icon name="folder" size={18} />
      <label className="sr-only" htmlFor="bucket">
        Storage bucket
      </label>
      <select
        id="bucket"
        value={bucket}
        disabled={loading || !buckets.length}
        onChange={(event) => onChange(event.target.value)}
      >
        {!buckets.length && (
          <option value="">
            {loading ? "Loading buckets…" : "No buckets available"}
          </option>
        )}
        {buckets.map((item) => (
          <option key={item.name} value={item.name}>
            {bucketLabel(item.name)}
          </option>
        ))}
      </select>
    </div>
  );
}
