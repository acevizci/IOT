import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { AlertTriangle, CheckCircle2, ShieldOff, ChevronLeft, ChevronRight, CheckCheck, Search } from "lucide-react";
import { useAlerts, useSuppressedAlerts, useSeveritySummary } from "./useAlerts";
import { useDevices } from "../devices/useDevices";
import { useDeviceGroups } from "../deviceGroups/useDeviceGroups";
import { SEVERITY_LABEL, SEVERITY_LEVELS, SEVERITY_STYLES } from "../shared/severity";

// Zabbix'in "Problems" sayfasindaki gibi -- mutlak tarihin yaninda goreceli bir
// "ne kadar suredir" gostergesi, operasyon ekibinin hizlica "bu ne kadar eski"
// sorusuna cevap bulmasini saglar (sadece mutlak tarih-saat okumak yavastir).
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

export function AlertList() {
  const [filter, setFilter] = useState<"open" | "resolved" | "suppressed" | undefined>("open");
  const [severity, setSeverity] = useState("");
  const [searchParams] = useSearchParams();
  const [deviceId, setDeviceId] = useState(searchParams.get("device_id") || "");
  const [deviceGroupId, setDeviceGroupId] = useState("");
  const [rangeHours, setRangeHours] = useState(0);
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);

  // Debounce: her tuş vuruşunda değil, yazma durduktan 350ms sonra sorgula.
  useEffect(() => {
    const timer = setTimeout(() => setSearch(searchInput), 350);
    return () => clearTimeout(timer);
  }, [searchInput]);

  const fromDate = rangeHours > 0 ? new Date(Date.now() - rangeHours * 3600 * 1000).toISOString() : undefined;

  const { data, isLoading } = useAlerts({
    status: filter === "suppressed" ? undefined : filter,
    severity: severity || undefined,
    device_id: deviceId || undefined,
    device_group_id: deviceGroupId || undefined,
    from: fromDate,
    search: search || undefined,
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

  useEffect(() => {
    setPage(1);
  }, [filter, severity, deviceId, deviceGroupId, rangeHours, search]);

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

      {/* Açık alarmların severity dağılımı -- hızlı bir "ortamda genel durum ne"
          özeti, bir kutucuğa tıklamak o severity'yi filtreler. */}
      {severitySummary && severitySummary.length > 0 && (
        <div className="flex items-center gap-2 mb-4 flex-wrap">
          {SEVERITY_LEVELS.map((s) => {
            const item = severitySummary.find((x) => x.severity === s);
            if (!item || item.count === 0) return null;
            return (
              <button
                key={s}
                onClick={() => { setFilter("open"); setSeverity(s); }}
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
          <select value={severity} onChange={(e) => setSeverity(e.target.value)} className="text-sm px-3 py-2 rounded-md border border-border bg-surface-1">
            <option value="">Önem: tümü</option>
            {SEVERITY_LEVELS.map((s) => <option key={s} value={s}>{SEVERITY_LABEL[s]}</option>)}
          </select>
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
          {(severity || deviceId || deviceGroupId || rangeHours > 0 || searchInput) && (
            <button onClick={() => { setSeverity(""); setDeviceId(""); setDeviceGroupId(""); setRangeHours(0); setSearchInput(""); }} className="text-xs px-3 py-2 rounded-md border border-border-strong hover:bg-surface-2">
              Sıfırla
            </button>
          )}
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

      {filter !== "suppressed" && (
      <div className="border border-border rounded-xl overflow-hidden bg-surface-2">
        {alerts?.map((a) => (
          <Link
            key={a.id}
            to={`/alerts/${a.id}`}
            className="flex items-start gap-3 px-4 py-3 border-b border-border last:border-0 hover:bg-surface-1"
            style={{ borderLeft: `3px solid ${a.resolved_at ? "var(--text-success)" : "var(--text-warning)"}` }}
          >
            {a.resolved_at ? (
              <CheckCircle2 size={16} className="text-[var(--text-success)] mt-0.5 shrink-0" />
            ) : (
              <AlertTriangle size={16} className="text-[var(--text-warning)] mt-0.5 shrink-0" />
            )}
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <p className="text-sm">{a.message}</p>
                <span className={`text-[11px] px-1.5 py-0.5 rounded shrink-0 font-medium ${SEVERITY_STYLES[a.severity] ?? "bg-surface-0 text-text-secondary border border-border"}`}>
                  {SEVERITY_LABEL[a.severity] ?? a.severity}
                </span>
                {a.acknowledged_at && (
                  <span className="text-[11px] px-1.5 py-0.5 rounded bg-[var(--bg-accent)] text-[var(--text-accent)] flex items-center gap-1 shrink-0">
                    <CheckCheck size={11} />
                    üstlenildi
                  </span>
                )}
              </div>
              <p className="text-xs text-text-muted mt-1">
                {a.device_name ?? "Bilinmeyen cihaz"} · {a.metric_name} · {timeSince(a.triggered_at)} önce ({new Date(a.triggered_at).toLocaleString("tr-TR")})
                {a.resolved_at && ` · çözüldü: ${timeSince(a.resolved_at)} önce`}
              </p>
            </div>
          </Link>
        ))}
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
