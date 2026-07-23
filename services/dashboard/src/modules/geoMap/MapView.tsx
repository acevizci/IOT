import { useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { SEVERITY_LABEL } from "../shared/severity";
import type { DeviceMapLocation } from "../../api/devices";

// Ortak Leaflet harita mantığı -- hem standalone /geo-map sayfası (GeoMapPage.tsx)
// hem de dashboard'a eklenebilen Coğrafi Harita widget'ı (GeomapWidget.tsx)
// tarafından paylaşılır. react-leaflet yerine saf leaflet kullanıldı -- React 19
// ile peer-dependency riski almamak için. Pin'ler L.divIcon ile (SVG circleMarker
// değil) çiziliyor, çünkü CSS custom property'lerini (tema renkleri) doğrudan
// kullanabiliyoruz.
function severityColor(maxSeverity: string | null): string {
  switch (maxSeverity) {
    case "critical":
    case "disaster":
    case "high":
      return "var(--text-danger)";
    case "average":
    case "warning":
      return "var(--text-warning)";
    case "info":
      return "var(--text-secondary)";
    default:
      return "var(--text-success)";
  }
}

function buildIcon(device: DeviceMapLocation): L.DivIcon {
  const color = severityColor(device.max_severity);
  return L.divIcon({
    className: "",
    html: `<div style="width:16px;height:16px;border-radius:50%;background:${color};border:2px solid white;box-shadow:0 0 0 1px rgba(0,0,0,0.25);"></div>`,
    iconSize: [16, 16],
    iconAnchor: [8, 8],
    popupAnchor: [0, -8]
  });
}

function escapeHtml(value: string): string {
  const div = document.createElement("div");
  div.textContent = value;
  return div.innerHTML;
}

export interface MapInitialView {
  lat: number;
  lng: number;
  zoom?: number;
}

export function MapView({
  locations,
  initialView,
  className
}: {
  locations: DeviceMapLocation[] | undefined;
  initialView?: MapInitialView | null;
  className?: string;
}) {
  const navigate = useNavigate();
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const markersRef = useRef<L.LayerGroup | null>(null);

  useEffect(() => {
    if (!mapContainerRef.current || mapRef.current) return;
    const map = L.map(mapContainerRef.current).setView(
      initialView ? [initialView.lat, initialView.lng] : [41.0082, 28.9784],
      initialView?.zoom ?? 5
    );
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: "&copy; OpenStreetMap katkıda bulunanları",
      maxZoom: 19
    }).addTo(map);
    markersRef.current = L.layerGroup().addTo(map);
    mapRef.current = map;
    return () => {
      map.remove();
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    const markerLayer = markersRef.current;
    if (!map || !markerLayer || !locations) return;
    markerLayer.clearLayers();

    for (const device of locations) {
      const marker = L.marker([device.latitude, device.longitude], { icon: buildIcon(device) });
      const severityText = device.max_severity
        ? `${SEVERITY_LABEL[device.max_severity] ?? device.max_severity} (${device.open_alert_count} açık alarm)`
        : "Sorun yok";
      const popupEl = document.createElement("div");
      popupEl.className = "text-sm";
      popupEl.innerHTML = `
        <div class="font-medium mb-1">${escapeHtml(device.name)}</div>
        ${device.location ? `<div class="text-xs text-text-secondary mb-1">${escapeHtml(device.location)}</div>` : ""}
        <div class="text-xs mb-2">${escapeHtml(severityText)}</div>
      `;
      const link = document.createElement("button");
      link.textContent = "Cihaz detayına git";
      link.className = "text-xs text-[var(--text-accent)] underline";
      link.onclick = () => navigate(`/devices/${device.id}`);
      popupEl.appendChild(link);
      marker.bindPopup(popupEl);
      marker.addTo(markerLayer);
    }

    // Sabit bir başlangıç görünümü (widget'ın "Initial view" ayarı) verilmişse
    // otomatik fitBounds yapılmıyor -- kullanıcının seçtiği merkez/zoom korunur
    // (Zabbix'in Geomap widget'ındaki "Initial view" alanıyla aynı davranış).
    if (!initialView && locations.length > 0) {
      const bounds = L.latLngBounds(locations.map((d) => [d.latitude, d.longitude] as [number, number]));
      map.fitBounds(bounds, { padding: [40, 40], maxZoom: 12 });
    }
  }, [locations, initialView, navigate]);

  return <div ref={mapContainerRef} className={className ?? "w-full h-full rounded-2xl border border-border"} />;
}
