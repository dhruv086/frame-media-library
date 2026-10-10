import { useEffect, useState } from "react";
import { useAssets } from "../hooks/useAssets";
import { useToast } from "../hooks/useToast";
import { assetId, bucketLabel, formatBytes, isVideo } from "../utils";
import Header from "../components/Header";
import FilterBar from "../components/FilterBar";
import AssetGrid from "../components/AssetGrid";
import Skeleton from "../components/Skeleton";
import EmptyState from "../components/EmptyState";
import Pagination from "../components/Pagination";
import Toast from "../components/Toast";
import Icon from "../components/Icon";
import UploadModal from "../components/UploadModal";
import AssetModal from "../components/AssetModal";

const emptyFilters = { q: "", format: "", from: "", to: "" };

export default function Dashboard() {
  const { toasts, notify, dismiss } = useToast();
  const [inputs, setInputs] = useState(emptyFilters);
  const [filters, setFilters] = useState(emptyFilters);
  const [page, setPage] = useState(1);
  const [modal, setModal] = useState(null);
  const library = useAssets({ filters, page, setPage, notify });
  useEffect(() => {
    const timer = setTimeout(() => {
      setFilters((current) => ({ ...current, q: inputs.q.trim() }));
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [inputs.q]);

  function changeFilter(key, value) {
    setInputs((current) => ({ ...current, [key]: value }));
    if (key !== "q") {
      setFilters((current) => ({ ...current, [key]: value }));
      setPage(1);
    }
  }
  const reset = () => {
    setInputs(emptyFilters);
    setFilters(emptyFilters);
    setPage(1);
  };
  const close = () => setModal(null);
  const upload = () => setModal({ type: "upload" });

  async function onAction(type, asset) {
    if (type !== "copy") {
      setModal({ type, asset });
      return;
    }
    try {
      if (!navigator.clipboard?.writeText)
        throw new Error(
          "Clipboard access is unavailable. Open Preview to select and copy the original URL.",
        );
      await navigator.clipboard.writeText(asset.url);
      notify("Original URL copied to clipboard.");
    } catch (error) {
      notify(error.message || "Could not copy the URL.", "error");
    }
  }

  const videos = library.assets.filter(isVideo).length;
  const stats = [
    {
      icon: "grid",
      label: "Matching assets",
      value: library.total,
      note: "In selected bucket",
      className: "stat-green",
    },
    {
      icon: "image",
      label: "Images",
      value: library.assets.length - videos,
      note: "On this page",
      className: "stat-blue",
    },
    {
      icon: "video",
      label: "Videos",
      value: videos,
      note: "On this page",
      className: "stat-purple",
    },
    {
      icon: "storage",
      label: "Storage",
      value: formatBytes(
        library.assets.reduce((sum, asset) => sum + asset.size, 0),
      ),
      note: "On this page",
      className: "stat-sand",
    },
  ];
  const modalProps = { onClose: close, notify };
  return (
    <>
      <a className="skip-link" href="#main">
        Skip to media library
      </a>
      <Header
        buckets={library.buckets}
        bucket={library.bucket}
        onBucketChange={library.selectBucket}
        bucketLoading={library.bucketLoading}
        onUpload={upload}
        connected={library.connected}
        loading={library.bucketLoading}
      />
      <main id="main" className="main" tabIndex={-1}>
        <div className="breadcrumb">
          <span>Workspace</span>
          <Icon name="chevron" size={13} />
          <span>Media library</span>
        </div>
        <section className="page-heading">
          <div>
            <div className="eyebrow">
              <span />
              YOUR CREATIVE ASSETS, TOGETHER
            </div>
            <h1>
              Media library<span>.</span>
            </h1>
            <p>A little more organized. A lot more possible.</p>
          </div>
          <div className="heading-aside">
            <span className="library-symbol">
              <Icon name="grid" size={24} />
            </span>
            <div>
              <strong>One home for every asset</strong>
              <span>Upload. Organize. Make it yours.</span>
            </div>
          </div>
        </section>
        <section className="stats" aria-label="Library overview">
          {stats.map((stat) => (
            <div key={stat.label} className="stat-card">
              <span className={`stat-icon ${stat.className}`}>
                <Icon name={stat.icon} size={21} />
              </span>
              <div>
                <span className="stat-label">{stat.label}</span>
                <strong>
                  {library.loading ? "—" : library.error ? "—" : stat.value}
                </strong>
                <span className="stat-note">{stat.note}</span>
              </div>
            </div>
          ))}
        </section>
        <section className="library-section" aria-labelledby="assets-title">
          <div className="section-heading">
            <div>
              <h2 id="assets-title">
                All assets{" "}
                <span className="count-badge">
                  {library.error ? "—" : library.total}
                </span>
              </h2>
              <span className="section-description">
                Your collection, ready for what’s next.
              </span>
            </div>
            <div className="view-indicator">
              <Icon name="grid" size={16} />
              <span>Grid view</span>
            </div>
          </div>
          <FilterBar filters={inputs} onChange={changeFilter} onReset={reset} />
          <div className="gallery-content">
            {library.loading ? (
              <Skeleton />
            ) : library.error ? (
              <div className="error-state" role="alert">
                <span className="error-symbol">
                  <Icon name="warning" size={28} />
                </span>
                <h3>Let’s get you reconnected.</h3>
                <p>{library.error}</p>
                <button className="button secondary" onClick={library.retry}>
                  <Icon name="refresh" size={17} />
                  Try again
                </button>
              </div>
            ) : library.assets.length ? (
              <AssetGrid assets={library.assets} onAction={onAction} />
            ) : (
              <EmptyState
                filtered={Object.values(filters).some(Boolean)}
                onUpload={upload}
                onReset={reset}
                disabled={!library.bucket}
              />
            )}
          </div>
          {!library.error && (
            <Pagination
              page={page}
              totalPages={library.totalPages}
              total={library.total}
              limit={library.limit}
              onChange={(next) => {
                setPage(next);
                document
                  .getElementById("assets-title")
                  ?.scrollIntoView({ behavior: "smooth", block: "start" });
              }}
              disabled={library.loading}
            />
          )}
        </section>
        <footer className="page-footer">
          <span>
            <span className="footer-brand">frame.</span> A considered home for
            your media.
          </span>
          <span>
            <Icon name="folder" size={14} />
            {bucketLabel(library.bucket) || "Choose a storage bucket"}
          </span>
        </footer>
      </main>
      {modal?.type === "upload" && (
        <UploadModal
          {...modalProps}
          bucket={library.bucket}
          onDone={library.refresh}
        />
      )}
      {modal?.asset && (
        <AssetModal
          key={`${modal.type}-${assetId(modal.asset)}`}
          {...modalProps}
          type={modal.type}
          asset={modal.asset}
          onDone={library.refresh}
        />
      )}
      <Toast toasts={toasts} dismiss={dismiss} />
    </>
  );
}
