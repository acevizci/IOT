import { useState, useEffect, useRef, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Save, RotateCcw, X, ZoomOut } from "lucide-react";
import { fetchFullTopology, saveTopologyPositions, fetchDeviceDiagnostics, deleteTopologyLink } from "../../api/topology";
import { fetchDeviceCard } from "../../api/dashboards";
import type { FullTopologyDevice, FullTopologyGroup, FullTopologyHierarchyLink } from "../../api/topology";
import { SEVERITY_COLORS as SEVERITY_LINK_COLOR } from "../../theme";

function computeInitialLayout(
  devices: FullTopologyDevice[],
  hierarchyLinks: FullTopologyHierarchyLink[]
): Record<string, { x: number; y: number }> {
  const positions: Record<string, { x: number; y: number }> = {};
  const sourceDeviceIds = new Set(hierarchyLinks.map((l) => l.source_device_id));
  const cx = 400, cy = 300, radius = 220;

  // 1. geçiş: vCenter/ESXi (hiyerarşi kaynağı) OLMAYAN, kaydedilmiş konumu olmayan
  // cihazları dairesel yerleştir.
  const needsLayout = devices.filter((d) => d.x === 0 && d.y === 0 && !sourceDeviceIds.has(d.id));
  needsLayout.forEach((d, i) => {
    const angle = (2 * Math.PI * i) / Math.max(needsLayout.length, 1);
    positions[d.id] = { x: cx + radius * Math.cos(angle), y: cy + radius * Math.sin(angle) };
  });

  // Kaydedilmiş (elle sürüklenmiş) konumları koru.
  devices.forEach((d) => {
    if (!(d.x === 0 && d.y === 0)) positions[d.id] = { x: d.x, y: d.y };
  });

  // 2. geçiş: TÜM İLİŞKİLER (kullanıcı isteği) -- kaydedilmiş konumu OLMAYAN vCenter/
  // ESXi'yi, kendi senkronize ettiği host'larının ORTALAMA konumuna (biraz yukarısına,
  // hiyerarşik "üst düğüm" hissi versin diye) otomatik yerleştir.
  devices.forEach((d) => {
    if (!(d.x === 0 && d.y === 0)) return; // zaten kaydedilmiş konumu var, dokunma
    if (!sourceDeviceIds.has(d.id)) return; // vCenter değil, 1. geçişte zaten yerleşti
    const targetIds = hierarchyLinks.filter((l) => l.source_device_id === d.id).map((l) => l.target_device_id);
    const targetPositions = targetIds.map((id) => positions[id]).filter(Boolean) as Array<{ x: number; y: number }>;
    if (targetPositions.length === 0) {
      positions[d.id] = { x: cx, y: cy };
      return;
    }
    const avgX = targetPositions.reduce((s, p) => s + p.x, 0) / targetPositions.length;
    const avgY = targetPositions.reduce((s, p) => s + p.y, 0) / targetPositions.length;
    positions[d.id] = { x: avgX, y: avgY - 100 };
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

// TÜM İLİŞKİLER (kullanıcı isteği): grup üyelerinin GERÇEK (sürüklenmiş) konumlarına
// göre bir "sınır kutusu" (bounding box) hesaplar -- kullanıcı düğümleri sürükledikçe
// bu kutu OTOMATİK güncellenir, ayrı bir grup-layout algoritması gerekmez.
function computeGroupBounds(
  group: FullTopologyGroup,
  positions: Record<string, { x: number; y: number }>
): { x: number; y: number; width: number; height: number } | null {
  const memberPositions = group.member_device_ids.map((id) => positions[id]).filter(Boolean) as Array<{ x: number; y: number }>;
  if (memberPositions.length < 2) return null;
  const pad = 45;
  const xs = memberPositions.map((p) => p.x);
  const ys = memberPositions.map((p) => p.y);
  const minX = Math.min(...xs) - pad, maxX = Math.max(...xs) + pad;
  const minY = Math.min(...ys) - pad, maxY = Math.max(...ys) + pad;
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

export function TopologyGraph() {
  const { data, isLoading } = useQuery({ queryKey: ["topology-full"], queryFn: fetchFullTopology });
  const qc = useQueryClient();
  const saveMutation = useMutation({
    mutationFn: saveTopologyPositions,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["topology-full"] })
  });
  // Dashboard eksikliği (kullanıcı geri bildirimi): bağlantı silme arayüzü hiç
  // yoktu (backend zaten destekliyordu, sadece frontend'de kullanılmıyordu).
  const deleteLinkMutation = useMutation({
    mutationFn: deleteTopologyLink,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["topology-full"] })
  });
  function handleDeleteLink(e: React.MouseEvent, linkId: string, label: string) {
    e.stopPropagation();
    if (!confirm(`"${label}" bağlantısını silmek istediğinize emin misiniz?`)) return;
    deleteLinkMutation.mutate(linkId);
  }

  const [positions, setPositions] = useState<Record<string, { x: number; y: number }>>({});
  const [dragging, setDragging] = useState<string | null>(null);
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });
  const [dirty, setDirty] = useState(false);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  // TÜM İLİŞKİLER dönemi eklentisi (kalite geliştirmesi): zoom/pan -- sabit 800x600
  // viewBox, cihaz sayısı arttıkça (VMware host'ları + VM'ler dahil) kullanılamaz
  // hale geliyordu. Dinamik viewBox + tekerlek zoom + arka plana sürükleyerek pan.
  const [viewBox, setViewBox] = useState({ x: 0, y: 0, width: 800, height: 600 });
  const [isPanning, setIsPanning] = useState(false);
  const panStartRef = useRef<{ x: number; y: number; vbX: number; vbY: number } | null>(null);

  useEffect(() => {
    if (data?.devices) setPositions(computeInitialLayout(data.devices, data.hierarchyLinks || []));
  }, [data]);

  const { data: selectedCard } = useQuery({
    queryKey: ["topology-device-card", selectedDeviceId],
    queryFn: () => fetchDeviceCard(selectedDeviceId!),
    enabled: !!selectedDeviceId
  });

  // TÜM İLİŞKİLER: seçilen cihazın açık bir alarmı varsa, topoloji komşularından
  // "olası kök neden" olarak işaretlenenleri (backend'in SolarWinds-tarzı zamansal
  // analizi) grafikte GÖRSEL olarak vurgulamak için.
  const { data: diagnostics } = useQuery({
    queryKey: ["topology-device-diagnostics", selectedDeviceId],
    queryFn: () => fetchDeviceDiagnostics(selectedDeviceId!),
    enabled: !!selectedDeviceId
  });
  const rootCauseIds = new Set((diagnostics?.topology_neighbors ?? []).filter((n) => n.likely_root_cause).map((n) => n.id));

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
    if (isPanning && panStartRef.current) {
      const scale = viewBox.width / 800; // zoom seviyesine göre pan hızını ayarla
      const dx = (e.clientX - panStartRef.current.x) * scale;
      const dy = (e.clientY - panStartRef.current.y) * scale;
      setViewBox((prev) => ({ ...prev, x: panStartRef.current!.vbX - dx, y: panStartRef.current!.vbY - dy }));
      return;
    }
    if (!dragging || !svgRef.current) return;
    const svgPoint = screenToSvgPoint(svgRef.current, e.clientX, e.clientY);
    setPositions((prev) => ({
      ...prev,
      [dragging]: { x: svgPoint.x - dragOffset.x, y: svgPoint.y - dragOffset.y }
    }));
    setDirty(true);
  }, [dragging, dragOffset, isPanning, viewBox.width]);

  function handleSvgPointerDown(e: React.PointerEvent<SVGSVGElement>) {
    // Sadece BOŞ alana (bir düğüme değil) tıklanınca pan başlat.
    if (e.target !== svgRef.current) return;
    setIsPanning(true);
    panStartRef.current = { x: e.clientX, y: e.clientY, vbX: viewBox.x, vbY: viewBox.y };
  }

  function handleWheel(e: React.WheelEvent<SVGSVGElement>) {
    e.preventDefault();
    const scaleFactor = e.deltaY > 0 ? 1.1 : 0.9;
    setViewBox((prev) => {
      const newWidth = Math.min(Math.max(prev.width * scaleFactor, 200), 2400);
      const newHeight = newWidth * (600 / 800);
      const dx = (prev.width - newWidth) / 2;
      const dy = (prev.height - newHeight) / 2;
      return { x: prev.x + dx, y: prev.y + dy, width: newWidth, height: newHeight };
    });
  }

  function handleZoomReset() {
    setViewBox({ x: 0, y: 0, width: 800, height: 600 });
  }

  function handleSave() {
    const payload = Object.entries(positions).map(([device_id, p]) => ({ device_id, x: p.x, y: p.y }));
    saveMutation.mutate(payload, { onSuccess: () => setDirty(false) });
  }

  function handleReset() {
    if (data?.devices) setPositions(computeInitialLayout(data.devices, data.hierarchyLinks || []));
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
        <div className="flex items-center gap-2">
          <button onClick={handleZoomReset} title="Yakınlaştırmayı sıfırla" className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg text-text-secondary hover:bg-surface-1">
            <ZoomOut size={13} />
            Yakınlaştırmayı sıfırla
          </button>
          {dirty && (
            <>
              <button onClick={handleReset} className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg text-text-secondary hover:bg-surface-1">
                <RotateCcw size={13} />
                Sıfırla
              </button>
              <button onClick={handleSave} className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg bg-[var(--text-accent)] text-white hover:opacity-90">
                <Save size={13} />
                Konumları Kaydet
              </button>
            </>
          )}
        </div>
      </div>

      <div className="flex gap-3">
        <svg
          ref={svgRef}
          viewBox={`${viewBox.x} ${viewBox.y} ${viewBox.width} ${viewBox.height}`}
          className="flex-1 h-[600px] bg-surface-2 border border-border rounded-2xl cursor-grab active:cursor-grabbing"
          onPointerDown={handleSvgPointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={() => { setDragging(null); setIsPanning(false); }}
          onPointerLeave={() => { setDragging(null); setIsPanning(false); }}
          onWheel={handleWheel}
        >
          {/* TÜM İLİŞKİLER: device_group kümeleme çerçeveleri (VMware cluster'ları vb.) --
              en arkada render edilir ki düğümlerin/bağlantıların üzerini örtmesin. */}
          {data.groups?.map((group) => {
            const bounds = computeGroupBounds(group, positions);
            if (!bounds) return null;
            return (
              <g key={group.id}>
                <rect
                  x={bounds.x} y={bounds.y} width={bounds.width} height={bounds.height}
                  rx={12} fill={group.is_vmware_managed ? "rgba(63,184,138,0.05)" : "rgba(154,157,152,0.05)"}
                  stroke="var(--border-strong)" strokeWidth={1} strokeDasharray="5,4"
                />
                <text x={bounds.x + 10} y={bounds.y + 16} className="text-[10px] fill-current text-text-muted select-none">
                  {group.name}
                </text>
              </g>
            );
          })}

          {/* TÜM İLİŞKİLER: vCenter/ESXi'den host'larına hiyerarşi bağlantıları --
              manuel bağlantılardan (device_links) farklı stille (kesikli, ince). */}
          {/* TÜM İLİŞKİLER: gerçek NetFlow/sFlow trafiğine dayalı otomatik kenarlar --
              kalınlık trafik hacmine (log ölçekli) göre, soluk/nötr renk -- "kesin"
              bir bağlantı değil, "gözlemlenen" bir ilişki olduğu için diğerlerinden
              görsel olarak ayrışıyor. */}
          {data.trafficEdges?.map((edge, i) => {
            const a = positions[edge.device_a_id];
            const b = positions[edge.device_b_id];
            if (!a || !b) return null;
            const maxBytes = Math.max(...data.trafficEdges.map((e) => e.total_bytes), 1);
            const widthScale = Math.log(edge.total_bytes + 1) / Math.log(maxBytes + 1);
            return (
              <line
                key={`t-${i}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y}
                stroke="var(--text-info)" strokeWidth={1 + widthScale * 3} opacity={0.25}
              />
            );
          })}

          {data.hierarchyLinks?.map((link: FullTopologyHierarchyLink, i: number) => {
            const a = positions[link.source_device_id];
            const b = positions[link.target_device_id];
            if (!a || !b) return null;
            return (
              <line
                key={`h-${i}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y}
                stroke="var(--text-accent)" strokeWidth={1} strokeDasharray="3,3" opacity={0.4}
              />
            );
          })}

          {data.links.map((link) => {
            const a = positions[link.device_a_id];
            const b = positions[link.device_b_id];
            if (!a || !b) return null;
            const deviceA = data.devices.find((d) => d.id === link.device_a_id);
            const deviceB = data.devices.find((d) => d.id === link.device_b_id);
            const worstSeverity = deviceA?.max_severity || deviceB?.max_severity;
            const isAutoDiscovered = link.discovery_method === "lldp" || link.discovery_method === "cdp";
            // TÜM İLİŞKİLER: otomatik keşfedilen (LLDP/CDP) bağlantılar, alarm yoksa
            // "sage" (marka) rengiyle vurgulanıyor -- manuel bağlantılardan (nötr gri)
            // görsel olarak ayrışsın diye. Alarm varsa severity rengi HER ZAMAN öncelikli.
            const color = worstSeverity ? SEVERITY_LINK_COLOR[worstSeverity] || "#888" : isAutoDiscovered ? "var(--text-success)" : "var(--border-strong)";
            const linkLabel = `${deviceA?.name || "?"} — ${deviceB?.name || "?"}`;
            return (
              <g key={link.id}>
                <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={color} strokeWidth={2} opacity={isAutoDiscovered && !worstSeverity ? 0.6 : 1} pointerEvents="none" />
                {/* Dashboard eksikliği (kullanıcı geri bildirimi): görünür çizgi çok
                    ince olduğu için tıklaması zordu -- görünmez, daha kalın bir
                    "tıklama alanı" çizgisi ekleniyor (silme için tıklanabilir). */}
                <line
                  x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="transparent" strokeWidth={12}
                  className="cursor-pointer"
                  onClick={(e) => handleDeleteLink(e, link.id, linkLabel)}
                >
                  <title>{linkLabel} -- silmek için tıklayın</title>
                </line>
              </g>
            );
          })}

          {data.devices.map((device) => {
            const pos = positions[device.id];
            if (!pos) return null;
            const hasAlert = device.open_alert_count > 0;
            const fillColor = device.status !== "active" ? "var(--text-danger)" : hasAlert ? (SEVERITY_LINK_COLOR[device.max_severity || ""] || "var(--text-warning)") : "var(--text-success)";
            const isLikelyRootCause = rootCauseIds.has(device.id);
            return (
              <g
                key={device.id}
                transform={`translate(${pos.x}, ${pos.y})`}
                className="cursor-move"
                onPointerDown={(e) => handlePointerDown(e, device.id)}
                onClick={() => setSelectedDeviceId(device.id)}
              >
                {/* TÜM İLİŞKİLER: bu düğüm, seçili (alarmlı) cihazın "olası kök nedeni"
                    olarak işaretlenmişse (backend'in zamansal komşu analizi) dışında
                    ekstra, dikkat çekici bir kesikli halka gösteriliyor. */}
                {isLikelyRootCause && (
                  <circle r={30} fill="none" stroke="var(--text-danger)" strokeWidth={2} strokeDasharray="4,3" opacity={0.7} />
                )}
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
                {isLikelyRootCause && (
                  <text y={50} textAnchor="middle" className="text-[9px] fill-current text-[var(--text-danger)] select-none font-medium">
                    Olası kök neden
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
                {selectedCard.vms.length > 0 && (
                  <div>
                    <p className="text-text-muted mb-1">Bu host'taki VM'ler ({selectedCard.vms.length}):</p>
                    <div className="flex flex-col gap-0.5 max-h-40 overflow-y-auto">
                      {selectedCard.vms.map((vm) => (
                        <div key={vm.name} className="flex items-center gap-1.5">
                          <span className={`w-1.5 h-1.5 rounded-full ${vm.power_state === 1 ? "bg-[var(--text-success)]" : "bg-text-muted"}`} />
                          <span className="text-text-secondary truncate">{vm.name}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <p className="text-xs text-text-muted">Yükleniyor...</p>
            )}
          </div>
        )}
      </div>

      <div className="flex gap-4 mt-3 text-xs text-text-secondary flex-wrap">
        <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full bg-[var(--text-success)]" />Sağlıklı</span>
        <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full bg-[var(--text-warning)]" />Alarm var</span>
        <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full bg-[var(--text-danger)]" />Down</span>
        <span className="flex items-center gap-1.5"><span className="w-4 h-0.5 bg-[var(--text-success)] opacity-60" />Otomatik keşfedildi (LLDP)</span>
        <span className="flex items-center gap-1.5"><span className="w-4 h-0.5 bg-[var(--text-info)] opacity-40" />Gözlemlenen trafik</span>
        <span className="flex items-center gap-1.5"><span className="w-4 h-0.5 border-t border-dashed border-[var(--text-accent)]" />vCenter/ESXi hiyerarşisi</span>
      </div>
      <p className="text-[10px] text-text-muted mt-2">İpucu: mouse tekerleğiyle yakınlaştır, boş alana tıklayıp sürükleyerek gez, bir bağlantıya tıklayarak sil.</p>
    </div>
  );
}
