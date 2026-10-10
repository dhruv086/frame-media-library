import AssetCard from "./AssetCard";
import { assetId } from "../utils";

export default function AssetGrid({ assets, onAction }) {
  return (
    <div className="asset-grid">
      {assets.map((asset) => (
        <AssetCard key={assetId(asset)} asset={asset} onAction={onAction} />
      ))}
    </div>
  );
}
