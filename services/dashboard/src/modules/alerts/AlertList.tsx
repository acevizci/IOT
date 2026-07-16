import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { AlertTriangle, CheckCircle2, ShieldOff, ChevronLeft, ChevronRight, CheckCheck, Search, ChevronUp, ChevronDown } from "lucide-react";
import { useAlerts, useSuppressedAlerts, useSeveritySummary, useBulkAcknowledgeAlerts } from "./useAlerts";
import { useDevices } from "../devices/useDevices";
import { useDeviceGroups } from "../deviceGroups/useDeviceGroups";
import { SEVERITY_LABEL, SEVERITY_LEVELS, SEVERITY_STYLES } from "../shared/severity";

function timeSince(dateStr: string): string {
  const seconds = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (seconds < 60) return `${seconds}sn`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}dk`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}s ${Math.floor((seconds % 3600) / 60)}dk`;
  return `${Math.floor(seconds / 86400)}g ${Math.floor((seconds % 86400) / 3600)}s`;
}

const PAGE_SIZE = 50;
const RANGE_OPTIONS = [
  { label: "Tüm zamanlar", hours: 0 },
  { label: "Son 1 saat", hours: 1 },
  { label: "Son 24 saat", hours: 24 },
  { label: "Son 7 gün", hours: 168 }
];

type SortKey = "triggered_at" | "duration" | "severity";

export function AlertList() {
  const navigate = useNavigate();
  const [filter, setFilter] = useState<"open" | "resolved" | "suppressed" | undefined>("open");
  const [selectedSeverities, setSelectedSeverities] = useState<string[]>([]);
  function toggleSeverity(s: string) {
    setSelectedSeverities((prev) => (prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]));
  }
  const [searchParams] = useSearchParams();
  const [deviceId, setDeviceId] = useState(searchParams.get("device_id") || "");
  const [deviceGroupId, setDeviceGroupId] = useState("");
  const [rangeHours, setRangeHours] = useState(0);
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [activeTags, setActiveTags] = useState<string[]>([]);
  const [sortKey, setSortKey] = useState<SortKey>("triggered_at");
  const [sortOrder, setSortOrder] = useState<"asc" | "desc">("desc");

  function handleSort(key: SortKey) {
    if (sortKey === key) setSortOrder((o) => (o === "asc" ? "desc" : "asc"));
    else {
      setSortKey(key);
      setSortOrder("desc");
    }
  }
  function SortIcon({ column }: { column: SortKey }) {
    if (sortKey !== column) return null;
    return sortOrder === "asc" ? <ChevronUp size={12} className="inline ml-0.5" /> : <ChevronDown size={12} className="inline ml-0.5" />;
  }

  useEffect(() => {
    const timer = setTimeout(() => setSearch(searchInput), 350);
    return () => clearTimeout(timer);
  }, [searchInput]);

  const fromDate = rangeHours > 0 ? new Date(Date.now() - rangeHours * 3600 * 1000).toISOString() : undefined;

  const { data, isLoading } = useAlerts({
    status: filter === "suppressed" ? undefined : filter,
    severity: selectedSeverities.length > 0 ? selectedSeverities.join(",") : undefined,
    device_id: deviceId || undefined,
    device_group_id: deviceGroupId || undefined,
    from: fromDate,
    search: search || undefined,
    tags: activeTags.length > 0 ? activeTags.join(",") : undefined,
    sort: sortKey,
    order: sortOrder,
    page,
    limit: PAGE_SIZE
  });
  const alerts = data?.items;
  const total = data?.total ?? 0;
  const totalPages = data?.totalPages ?? 1;
  const { data: suppressedAlerts } = useSuppressedAlerts();
  const { data: devicesData } = useDevices({ limit: 200 });
  const devices = devicesData?.items;
  const { data: deviceGroups } = useDeviceGroups();
  const { data: severitySummary } = useSeveritySummary(deviceId || undefined, deviceGroupId || undefined);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const bulkAcknowledge = useBulkAcknowledgeAlerts();

  function toggleTagFilter(tagKey: string, tagValue: string) {
    const entry = `${tagKey}:${tagValue}`;
    setActiveTags((prev) => (prev.includes(entry) ? prev.filter((t) => t !== entry) : [...prev, entry]));
  }

  function toggleSelect(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }
  function toggleSelectAll() {
    if (alerts && selectedIds.size === alerts.length) setSelectedIds(new Set());
    else setSelectedIds(new Set(alerts?.map((a) => a.id) ?? []));
  }
  function handleBulkAcknowledge() {
    bulkAcknowledge.mutate(Array.from(selectedIds), { onSuccess: () => setSelectedIds(new Set()) });
  }

  useEffect(() => {
    setPage(1);
  }, [filter, selectedSeverities, deviceId, deviceGroupId, rangeHours, search, activeTags, sortKey, sortOrder]);

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <h1 className="text-lg font-medium">Alarmlar</h1>
        <div className="flex gap-1 bg-surface-1 rounded-md p-1 border border-border">
          <FilterTab label="Açık" active={filter === "open"} onClick={() => setFilter("open")} />
          <FilterTab label="Çözüldü" active={filter === "resolved"} onClick={() => setFilter("resolved")} />
          <FilterTab label="Bastırılanlar" active={filter === "suppressed"} onClick={() => setFilter("suppressed")} />
          <FilterTab label="Tümü" active={filter === undefined} onClick={() => setFilter(undefined)} />
        </div>
      </div>

      {severitySummary && severitySummary.length > 0 && (
        <div className="flex items-center gap-2 mb-4 flex-wrap">
          {SEVERITY_LEVELS.map((s) => {
            const item = severitySummary.find((x) => x.severity === s);
            if (!item || item.count === 0) return null;
            return (
              <button
                key={s}
                onClick={() => { setFilter("open"); setSelectedSeverities([s]); }}
                className={`flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg font-medium ${SEVERITY_STYLES[s] ?? "bg-surface-1 text-text-secondary"}`}
              >
                {item.count} {SEVERITY_LABEL[s]}
              </button>
            );
          })}
        </div>
      )}

      {filter !== "suppressed" && (
        <div className="flex items-center gap-2 mb-4 flex-wrap">
          <div className="relative">
            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-muted" />
            <input
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder="Mesaj veya metrik ara..."
              className="text-sm pl-8 pr-3 py-2 rounded-md border border-border bg-surface-1 w-56"
            />
          </div>
          <div className="flex items-center gap-1 bg-surface-1 border border-border rounded-md px-2 py-1">
            {SEVERITY_LEVELS.map((s) => (
              <label key={s} className="flex items-center gap-1 text-xs px-1.5 py-1 rounded cursor-pointer hover:bg-surface-2">
                <input type="checkbox" checked={selectedSeverities.includes(s)} onChange={() => toggleSeverity(s)} className="w-3 h-3" />
                {SEVERITY_LABEL[s]}
              </label>
            ))}
          </div>
          <select value={deviceId} onChange={(e) => setDeviceId(e.target.value)} className="text-sm px-3 py-2 rounded-md border border-border bg-surface-1">
            <option value="">Cihaz: tümü</option>
            {devices?.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
          <select value={deviceGroupId} onChange={(e) => setDeviceGroupId(e.target.value)} className="text-sm px-3 py-2 rounded-md border border-border bg-surface-1">
            <option value="">Host grubu: tümü</option>
            {deviceGroups?.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
          </select>
          <select value={rangeHours} onChange={(e) => setRangeHours(Number(e.target.value))} className="text-sm px-3 py-2 rounded-md border border-border bg-surface-1">
            {RANGE_OPTIONS.map((r) => <option key={r.hours} value={r.hours}>{r.label}</option>)}
          </select>
          {(selectedSeverities.length > 0 || deviceId || deviceGroupId || rangeHours > 0 || searchInput || activeTags.length > 0) && (
            <button onClick={() => { setSelectedSeverities([]); setDeviceId(""); setDeviceGroupId(""); setRangeHours(0); setSearchInput(""); setActiveTags([]); }} className="text-xs px-3 py-2 rounded-md border border-border-strong hover:bg-surface-2">
              Sıfırla
            </button>
          )}
        </div>
      )}

      {activeTags.length > 0 && (
        <div className="flex items-center gap-1.5 mb-4 flex-wrap">
          {activeTags.map((t) => {
            const [k, v] = t.split(":");
            return (
              <button
                key={t}
                onClick={() => setActiveTags((prev) => prev.filter((x) => x !== t))}
                className="flex items-center gap-1 text-[11px] px-2 py-1 rounded-full bg-[var(--bg-accent)] text-[var(--text-accent)]"
              >
                {k}: {v}
                <span className="ml-0.5">×</span>
              </button>
            );
          })}
        </div>
      )}

      {isLoading && <p className="text-sm text-text-secondary">Yükleniyor...</p>}

      {filter === "suppressed" && (
        <div className="border border-border rounded-xl overflow-hidden bg-surface-2 mb-2">
          <div className="px-4 py-2.5 bg-surface-1 border-b border-border">
            <p className="text-xs text-text-secondary">
              Bu alarmlar eşiği aştı ama bağımlı oldukları başka bir alarm zaten açık olduğu için bildirim/kayıt oluşturulmadı.
            </p>
          </div>
          {suppressedAlerts?.map((s) => (
            <div key={s.id} className="flex items-start gap-3 px-4 py-3 border-b border-border last:border-0">
              <ShieldOff size={16} className="text-text-muted mt-0.5 shrink-0" />
              <div className="min-w-0 flex-1">
                <p className="text-sm">{s.message}</p>
                <p className="text-xs text-text-muted mt-1">
                  {s.device_name} · {s.suppressing_metric} zaten alarm verdiği için bastırıldı · {new Date(s.suppressed_at).toLocaleString("tr-TR")}
                </p>
              </div>
            </div>
          ))}
          {suppressedAlerts?.length === 0 && <p className="text-sm text-text-muted p-4">Hiç bastırılan alarm yok.</p>}
        </div>
      )}

      {selectedIds.size > 0 && filter === "open" && (
        <div className="flex items-center gap-3 mb-2 px-1">
          <button
            onClick={handleBulkAcknowledge}
            disabled={bulkAcknowledge.isPending}
            className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md bg-[var(--text-accent)] text-white disabled:opacity-50"
          >
            <CheckCheck size={13} />
            {selectedIds.size} alarmı üstlen
          </button>
        </div>
      )}

      {filter !== "suppressed" && (
        <div className="border border-border rounded-xl overflow-hidden bg-surface-2">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-surface-1 text-text-secondary text-left border-b border-border">
                {filter === "open" && (
                  <th className="p-2.5 w-8">
                    <input type="checkbox" checked={!!alerts && alerts.length > 0 && selectedIds.size === alerts.length} onChange={toggleSelectAll} />
                  </th>
                )}
                <th
                  className="p-2.5 font-medium cursor-pointer select-none hover:text-text-primary w-24"
                  onClick={() => handleSort("severity")}
                >
                  Önem<SortIcon column="severity" />
                </th>
                <th className="p-2.5 font-medium">Problem</th>
                <th className="p-2.5 font-medium">Cihaz</th>
                <th
                  className="p-2.5 font-medium cursor-pointer select-none hover:text-text-primary w-32"
                  onClick={() => handleSort("triggered_at")}
                >
                  Süre<SortIcon column="triggered_at" />
                </th>
                <th className="p-2.5 font-medium w-20">Ack</th>
                <th className="p-2.5 font-medium">Etiketler</th>
              </tr>
            </thead>
            <tbody>
              {alerts?.map((a) => (
                <tr
                  key={a.id}
                  onClick={() => navigate(`/alerts/${a.id}`)}
                  className="border-b border-border last:border-0 hover:bg-surface-1 cursor-pointer"
                  style={{ borderLeft: `3px solid ${a.resolved_at ? "var(--text-success)" : "var(--text-warning)"}` }}
                >
                  {filter === "open" && (
                    <td className="p-2.5" onClick={(e) => e.stopPropagation()}>
                      <input type="checkbox" checked={selectedIds.has(a.id)} onChange={() => toggleSelect(a.id)} />
                    </td>
                  )}
                  <td className="p-2.5 align-top">
                    <span className={`text-[11px] px-1.5 py-0.5 rounded font-medium ${SEVERITY_STYLES[a.severity] ?? "bg-surface-0 text-text-secondary border border-border"}`}>
                      {SEVERITY_LABEL[a.severity] ?? a.severity}
                    </span>
                  </td>
                  <td className="p-2.5 align-top">
                    <div className="flex items-center gap-2">
                      {a.resolved_at ? (
                        <CheckCircle2 size={14} className="text-[var(--text-success)] shrink-0" />
                      ) : (
                        <AlertTriangle size={14} className="text-[var(--text-warning)] shrink-0" />
                      )}
                      <span>{a.message}</span>
                    </div>
                    <p className="text-[11px] text-text-muted mt-0.5">{a.metric_name}</p>
                  </td>
                  <td className="p-2.5 align-top text-text-secondary">{a.device_name ?? "Bilinmeyen cihaz"}</td>
                  <td className="p-2.5 align-top text-text-muted" title={new Date(a.triggered_at).toLocaleString("tr-TR")}>
                    {timeSince(a.triggered_at)}
                    {a.resolved_at && <div className="text-[11px]">çözüldü: {timeSince(a.resolved_at)}</div>}
                  </td>
                  <td className="p-2.5 align-top">
                    {a.acknowledged_at && (
                      <span className="text-[11px] px-1.5 py-0.5 rounded bg-[var(--bg-accent)] text-[var(--text-accent)] flex items-center gap-1 w-fit">
                        <CheckCheck size={11} />
                        üstlenildi
                      </span>
                    )}
                  </td>
                  <td className="p-2.5 align-top" onClick={(e) => e.stopPropagation()}>
                    {a.tags && a.tags.length > 0 && (
                      <div className="flex items-center gap-1 flex-wrap">
                        {a.tags.map((t, i) => (
                          <span
                            key={i}
                            onClick={() => toggleTagFilter(t.tag, t.value)}
                            className={`text-[10px] px-1.5 py-0.5 rounded-full cursor-pointer ${
                              activeTags.includes(`${t.tag}:${t.value}`)
                                ? "bg-[var(--bg-accent)] text-[var(--text-accent)]"
                                : "bg-surface-1 text-text-muted border border-border hover:border-border-strong"
                            }`}
                          >
                            {t.tag}: {t.value}
                          </span>
                        ))}
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {alerts?.length === 0 && <p className="text-sm text-text-muted p-4">Bu filtrede alarm yok.</p>}
          {totalPages > 1 && (
            <div className="flex items-center justify-between px-4 py-2.5 border-t border-border bg-surface-1">
              <span className="text-xs text-text-secondary">
                Sayfa {page} / {totalPages} · toplam {total} alarm
              </span>
              <div className="flex items-center gap-1.5">
                <button
                  onClick={() => setPage((p) => Math.max(p - 1, 1))}
                  disabled={page <= 1}
                  className="flex items-center gap-1 text-xs px-2.5 py-1.5 rounded-md border border-border-strong disabled:opacity-40 disabled:cursor-not-allowed hover:bg-surface-2"
                >
                  <ChevronLeft size={13} />
                  Önceki
                </button>
                <button
                  onClick={() => setPage((p) => Math.min(p + 1, totalPages))}
                  disabled={page >= totalPages}
                  className="flex items-center gap-1 text-xs px-2.5 py-1.5 rounded-md border border-border-strong disabled:opacity-40 disabled:cursor-not-allowed hover:bg-surface-2"
                >
                  Sonraki
                  <ChevronRight size={13} />
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function FilterTab({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} className={`text-xs px-3 py-1.5 rounded ${active ? "bg-[var(--bg-accent)] text-[var(--text-accent)] font-medium" : "text-text-secondary"}`}>
      {label}
    </button>
  );
}
