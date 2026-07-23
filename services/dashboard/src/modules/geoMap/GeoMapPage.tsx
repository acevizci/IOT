import { useDeviceMapLocations } from "./useGeoMap";
import { MapView } from "./MapView";

// Zabbix'in "Geographical maps" özelliğine karşılık: koordinatı tanımlı TÜM
// cihazları (filtresiz) gerçek bir dünya haritasında gösterir. Filtrelenmiş
// (host grubu/host/tag) görünüm için bkz. dashboard'a eklenebilen Coğrafi
// Harita widget'ı (modules/dashboards/widgets/GeomapWidget.tsx).
export function GeoMapPage() {
  const { data: locations, isLoading } = useDeviceMapLocations();
  const withoutCoords = (locations?.length ?? 0) === 0;

  return (
    <div>
      <div className="mb-4">
        <h1 className="text-lg font-medium">Harita</h1>
        <p className="text-sm text-text-secondary">
          Koordinatı tanımlı cihazlar coğrafi konumlarında, en kötü açık alarm severity'sine göre renklendirilmiş şekilde gösterilir.
          Bir cihaza koordinat atamak için cihazı düzenle formunu kullanın.
        </p>
      </div>
      {isLoading && <p className="text-sm text-text-muted">Yükleniyor...</p>}
      {!isLoading && withoutCoords && (
        <p className="text-sm text-text-muted mb-3">Koordinatı tanımlı hiçbir cihaz yok. Cihaz düzenleme formundan enlem/boylam ekleyin.</p>
      )}
      <MapView locations={locations} className="w-full h-[70vh] rounded-2xl border border-border" />
    </div>
  );
}
