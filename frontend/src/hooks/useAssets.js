import { useCallback, useEffect, useState } from "react";
import { getAssets, getBuckets, getHealth } from "../api/client";

/** Load the selected bucket and cancel stale gallery requests when filters change. */
export function useAssets({ filters, page, setPage, notify }) {
  const [buckets, setBuckets] = useState([]);
  const [health, setHealth] = useState(null);
  const [bucket, setBucket] = useState("");
  const [bucketLoading, setBucketLoading] = useState(true);
  const [bucketError, setBucketError] = useState("");
  const [bucketAttempt, setBucketAttempt] = useState(0);
  const [data, setData] = useState({
    assets: [],
    total: 0,
    totalPages: 0,
    limit: 12,
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    async function loadBuckets() {
      setBucketLoading(true);
      setBucketError("");
      setHealth(null);
      try {
        const [status, result] = await Promise.all([
          getHealth({ signal: controller.signal }),
          getBuckets({ signal: controller.signal }),
        ]);
        if (controller.signal.aborted) return;
        if (status.status !== "ok" || status.database !== "connected")
          throw new Error(
            "The media server database is unavailable. Please try again.",
          );
        setHealth(status);
        const available = (result.buckets || []).map((item) =>
          typeof item === "string" ? { name: item } : item,
        );
        setBuckets(available);
        setBucket((current) =>
          available.some((item) => item.name === current)
            ? current
            : available[0]?.name || "",
        );
      } catch (failure) {
        if (!controller.signal.aborted) {
          setBucketError(failure.message);
          notify(failure.message, "error");
        }
      } finally {
        if (!controller.signal.aborted) setBucketLoading(false);
      }
    }
    loadBuckets();
    return () => controller.abort();
  }, [bucketAttempt, notify]);

  useEffect(() => {
    if (!bucket || bucketLoading || bucketError) return;
    const controller = new AbortController();
    async function load() {
      setLoading(true);
      setError("");
      try {
        const result = await getAssets(
          { bucket, ...filters, page, limit: 12 },
          { signal: controller.signal },
        );
        if (!controller.signal.aborted) {
          if (page > Math.max(1, result.totalPages))
            setPage(Math.max(1, result.totalPages));
          else setData(result);
        }
      } catch (failure) {
        if (!controller.signal.aborted) {
          setError(failure.message);
          notify(failure.message, "error");
        }
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }
    load();
    return () => controller.abort();
  }, [
    bucket,
    bucketLoading,
    bucketError,
    filters.q,
    filters.format,
    filters.from,
    filters.to,
    page,
    revision,
    notify,
    setPage,
  ]);

  const refresh = useCallback(() => setRevision((value) => value + 1), []);
  const retry = useCallback(() => {
    if (bucketError || !bucket) setBucketAttempt((value) => value + 1);
    else refresh();
  }, [bucketError, bucket, refresh]);
  const selectBucket = (name) => {
    setPage(1);
    setBucket(name);
  };
  return {
    ...data,
    buckets,
    bucket,
    selectBucket,
    loading: loading || bucketLoading,
    bucketLoading,
    connected: health?.status === "ok" && !bucketError && !error,
    error: bucketError || error,
    refresh,
    retry,
  };
}
