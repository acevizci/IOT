import { useState, useEffect, useRef, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Save, RotateCcw, X } from "lucide-react";
import { fetchFullTopology, saveTopologyPositions } from "../../api/topology";
import { fetchDeviceCard } from "../../api/dashboards";
import type { FullTopologyDevice } from "../../api/topology";

const SEVERITY_LINK_COLOR: Record<string, string> = {
  info: "#6b7280", warning: "#f59e0b", average: "#f97316", high: "#ef4444", disaster: "#991b1b"
};

function computeInitialLayout(devices: FullTopologyDevice[]): Record<string, { x: number; y: number }> {
  const positions: Record<string, { x: number; y: number }> = {};
  const needsLayout = devices.filter((d) => d.x === 0 && d.y === 0);
  const cx = 400, cy = 300, radius = 220;
  needsLayout.forEach((d, i) => {
    const angle = (2 * Math.PI * i) / Math.max(needsLayout.length, 1);
    positions[d.id] = { x: cx + radius * Math.cos(angle), y: cy + radius * Math.sin(angle) };
  });
  devices.forEach((d) => {
    if (!(d.x === 0 && d.y === 0)) positions[d.id] = { x: d.x, y: d.y };
  });
  return positions;
}

// Ekran piksel koordinatını (mouse event) SVG'nin kendi viewBox koordinat sistemine
// çevirir — viewBox boyutu (800x600) gerçek render boyutundan farklı olduğu için
// düz "clientX - rect.left" hesabı sistematik bir kaymaya (sürüklerken imlecin
// düğümden kopması) yol açıyordu. getScreenCTM() gerçek dönüşüm matrisini verir.
function screenToSvgPoint(svg: SVGSVGElement, clientX: number, clientY: number) {
  const pt = svg.createSVGPoint();
  pt.x = clientX;
  pt.y = clientY;
  const ctm = svg.getScreenCTM();
  if (!ctm) return { x: clientX, y: clientY };
  const transformed = pt.matrixTransform(ctm.inverse());
  return { x: transformed.x, y: transformed.y };
}

export function TopologyGraph() {
  const { data, isLoading } = useQuery({ queryKey: ["topology-full"], queryFn: fetchFullTopology });
  const qc = useQueryClient();
  const saveMutation = useMutation({
    mutationFn: saveTopologyPositions,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["topology-full"] })
  });

  const [positions, setPositions] = useState<Record<string, { x: number; y: number }>>({});
  const [dragging, setDragging] = useState<string | null>(null);
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });
  const [dirty, setDirty] = useState(false);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  useEffect(() => {
    if (data?.devices) setPositions(computeInitialLayout(data.devices));
  }, [data]);

  const { data: selectedCard } = useQuery({
    queryKey: ["topology-device-card", selectedDeviceId],
    queryFn: () => fetchDeviceCard(selectedDeviceId!),
    enabled: !!selectedDeviceId
  });

  function handlePointerDown(e: React.PointerEvent, deviceId: string) {
    if (!svgRef.current) return;
    const svgPoint = screenToSvgPoint(svgRef.current, e.clientX, e.clientY);
    const nodePos = positions[deviceId];
    // Tıklanan nokta ile düğümün gerçek merkezi arasındaki farkı (offset) saklıyoruz —
    // sürüklerken bu farkı koruyarak düğümün "sıçramasını" önlüyoruz.
    setDragOffset({ x: svgPoint.x - nodePos.x, y: svgPoint.y - nodePos.y });
    setDragging(deviceId);
  }

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragging || !svgRef.current) return;
    const svgPoint = screenToSvgPoint(svgRef.current, e.clientX, e.clientY);
    setPositions((prev) => ({
      ...prev,
      [dragging]: { x: svgPoint.x - dragOffset.x, y: svgPoint.y - dragOffset.y }
    }));
    setDirty(true);
  }, [dragging, dragOffset]);

  function handleSave() {
    const payload = Object.entries(positions).map(([device_id, p]) => ({ device_id, x: p.x, y: p.y }));
    saveMutation.mutate(payload, { onSuccess: () => setDirty(false) });
  }

  function handleReset() {
    if (data?.devices) setPositions(computeInitialLayout(data.devices));
    setDirty(false);
  }

  if (isLoading) return <p className="text-sm text-text-secondary">Yükleniyor...</p>;
  if (!data) return null;

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <p className="text-xs text-text-secondary">
          {data.devices.length} cihaz · {data.links.length} bağlantı ·
          {" "}{data.devices.filter((d) => d.open_alert_count > 0).length} cihazda açık alarm
        </p>
        {dirty && (
          <div className="flex items-center gap-2">
            <button onClick={handleReset} className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg text-text-secondary hover:bg-surface-1">
              <RotateCcw size={13} />
              Sıfırla
            </button>
            <button onClick={handleSave} className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg bg-[var(--text-accent)] text-white hover:opacity-90">
              <Save size={13} />
              Konumları Kaydet
            </button>
          </div>
        )}
      </div>

      <div className="flex gap-3">
        <svg
          ref={svgRef}
          viewBox="0 0 800 600"
          className="flex-1 h-[600px] bg-surface-2 border border-border rounded-2xl"
          onPointerMove={handlePointerMove}
          onPointerUp={() => setDragging(null)}
          onPointerLeave={() => setDragging(null)}
        >
          {data.links.map((link) => {
            const a = positions[link.device_a_id];
            const b = positions[link.device_b_id];
            if (!a || !b) return null;
            const deviceA = data.devices.find((d) => d.id === link.device_a_id);
            const deviceB = data.devices.find((d) => d.id === link.device_b_id);
            const worstSeverity = deviceA?.max_severity || deviceB?.max_severity;
            const color = worstSeverity ? SEVERITY_LINK_COLOR[worstSeverity] || "#888" : "var(--border-strong)";
            return <line key={link.id} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={color} strokeWidth={2} />;
          })}

          {data.devices.map((device) => {
            const pos = positions[device.id];
            if (!pos) return null;
            const hasAlert = device.open_alert_count > 0;
            const fillColor = device.status !== "active" ? "var(--text-danger)" : hasAlert ? (SEVERITY_LINK_COLOR[device.max_severity || ""] || "var(--text-warning)") : "var(--text-success)";
            return (
              <g
                key={device.id}
                transform={`translate(${pos.x}, ${pos.y})`}
                className="cursor-move"
                onPointerDown={(e) => handlePointerDown(e, device.id)}
                onClick={() => setSelectedDeviceId(device.id)}
              >
                <circle r={22} fill="var(--surface-1)" stroke={selectedDeviceId === device.id ? "var(--text-accent)" : fillColor} strokeWidth={selectedDeviceId === device.id ? 4 : 3} />
                <circle r={5} fill={fillColor} />
                <text y={38} textAnchor="middle" className="text-[11px] fill-current text-text-secondary select-none">
                  {device.name}
                </text>
                {hasAlert && (
                  <text y={-30} textAnchor="middle" className="text-[10px] fill-current" style={{ color: fillColor }}>
                    {device.open_alert_count} alarm
                  </text>
                )}
              </g>
            );
          })}
        </svg>

        {selectedDeviceId && (
          <div className="w-64 shrink-0 bg-surface-2 border border-border rounded-2xl p-4">
            <div className="flex items-center justify-between mb-3">
              <p className="text-sm font-medium">Cihaz Detayı</p>
              <button onClick={() => setSelectedDeviceId(null)} className="text-text-muted hover:text-text-secondary"><X size={14} /></button>
            </div>
            {selectedCard ? (
              <div className="flex flex-col gap-2 text-xs">
                <Link to={`/devices/${selectedCard.id}`} className="text-sm font-medium text-text-accent hover:underline">{selectedCard.name}</Link>
                <p className="text-text-muted font-mono">{selectedCard.ip_address}</p>
                <div className="flex items-center gap-1.5">
                  <span className={`w-2 h-2 rounded-full ${selectedCard.status === "active" ? "bg-[var(--text-success)]" : "bg-[var(--text-danger)]"}`} />
                  <span className="text-text-secondary">{selectedCard.status}</span>
                </div>
                <p className="text-text-secondary">{selectedCard.device_type} · {selectedCard.vendor}</p>
                {selectedCard.open_alert_count > 0 && (
                  <Link to={`/alerts?device_id=${selectedCard.id}`} className="text-[var(--text-danger)] hover:underline">
                    {selectedCard.open_alert_count} açık alarm →
                  </Link>
                )}
                {selectedCard.templates.length > 0 && (
                  <div>
                    <p className="text-text-muted mb-1">Şablonlar:</p>
                    {selectedCard.templates.map((t) => <p key={t} className="text-text-secondary">{t}</p>)}
                  </div>
                )}
              </div>
            ) : (
              <p className="text-xs text-text-muted">Yükleniyor...</p>
            )}
          </div>
        )}
      </div>

      <div className="flex gap-4 mt-3 text-xs text-text-secondary">
        <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full bg-[var(--text-success)]" />Sağlıklı</span>
        <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full bg-[var(--text-warning)]" />Alarm var</span>
        <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full bg-[var(--text-danger)]" />Down</span>
      </div>
    </div>
  );
}
