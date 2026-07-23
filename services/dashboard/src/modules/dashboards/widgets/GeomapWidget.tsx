import { useDeviceMapLocations } from "../../geoMap/useGeoMap";
import { MapView } from "../../geoMap/MapView";
import type { MapInitialView } from "../../geoMap/MapView";
import { resolveRefreshInterval } from "./refreshInterval";

// Zabbix'in "Geomap" dashboard widget'ıyla aynı fikir: Host grupları / Hosts /
// Tags filtresine göre daraltılmış cihaz kümesini haritada gösterir. Filtresiz
// TÜM koordinatlı cihazlar için standalone /geo-map sayfasına bkz. (GeoMapPage.tsx).
function parseInitialView(raw: string | undefined): MapInitialView | null {
  if (!raw) return null;
  const parts = raw.split(",").map((p) => Number(p.trim()));
  if (parts.length < 2 || parts.some((p) => Number.isNaN(p))) return null;
  return { lat: parts[0], lng: parts[1], zoom: parts[2] };
}

export function GeomapWidget({ config, title }: { config: Record<string, any>; title?: string | null }) {
  const { data: locations, isLoading } = useDeviceMapLocations(
    {
      deviceGroupIds: config.device_group_ids,
      deviceIds: config.device_ids,
      tags: config.tags,
      tagLogic: config.tag_logic
    },
    resolveRefreshInterval(config, 60000)
  );
  const initialView = parseInitialView(config.initial_view);

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <p className="text-xs text-text-secondary mb-2">{title || "Coğrafi Harita"}</p>
      {isLoading ? (
        <p className="text-xs text-text-muted">Yükleniyor...</p>
      ) : (locations?.length ?? 0) === 0 ? (
        <p className="text-xs text-text-muted">Filtreyle eşleşen, koordinatı tanımlı cihaz yok.</p>
      ) : (
        <MapView locations={locations} initialView={initialView} className="w-full flex-1 rounded-lg" />
      )}
    </div>
  );
}
