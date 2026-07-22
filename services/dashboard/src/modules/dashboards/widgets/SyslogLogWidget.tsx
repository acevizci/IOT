import { useQuery } from "@tanstack/react-query";
import { ScrollText } from "lucide-react";
import { fetchSyslogLog } from "../../../api/dashboards";
import { resolveRefreshInterval } from "./refreshInterval";

// Kullanıcı isteği: syslogReceiver.ts'in yayınladığı ham syslog mesajlarını (severity,
// appname, mesaj metni) zaman sırasıyla gösteren liste. Trap Log'dan farkı: burada asıl
// bilgi serbest-metin MESAJDIR, bir tür/etiket değil -- bu yüzden mesaj tam olarak
// gösterilir ve severity renk koduyla vurgulanır.

// RFC 5424 severity (0=en ciddi) -> tema renk token'ı. 075 erişilebilirlik geçişindeki
// SEVERITY_TEXT_COLORS mantığıyla tutarlı (kontrastlı metin renkleri).
function severityColor(severity: number): string {
  if (severity <= 3) return "var(--text-danger)";   // emerg/alert/crit/err
  if (severity === 4) return "var(--text-warning)";  // warning
  if (severity === 5) return "var(--text-accent)";   // notice
  return "var(--text-muted)";                         // info/debug
}

export function SyslogLogWidget({ config, title }: { config: Record<string, any>; title?: string | null }) {
  const deviceGroupId: string | undefined = config.device_group_id;
  const minSeverity: number | undefined =
    config.min_severity === undefined || config.min_severity === "" ? undefined : Number(config.min_severity);

  const { data, isLoading } = useQuery({
    queryKey: ["widget-syslog-log", deviceGroupId, config.limit, minSeverity],
    queryFn: () => fetchSyslogLog(deviceGroupId, config.limit || 20, minSeverity),
    refetchInterval: resolveRefreshInterval(config, 30000)
  });

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <p className="text-xs text-text-secondary mb-2">{title || "Syslog Günlüğü"}</p>
      {isLoading ? (
        <p className="text-xs text-text-muted">Yükleniyor...</p>
      ) : (
        <div className="flex-1 overflow-auto flex flex-col gap-1.5">
          {data?.map((row, i) => (
            <div key={i} className="flex items-start gap-2 bg-surface-1 border border-border rounded-md px-2.5 py-1.5">
              <ScrollText size={13} className="text-text-muted shrink-0 mt-0.5" />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-[10px] font-semibold uppercase shrink-0" style={{ color: severityColor(row.severity) }}>
                    {row.severity_name}
                  </span>
                  <span className="text-[10px] text-text-muted truncate">
                    {row.device_name}{row.appname ? ` · ${row.appname}` : ""}
                  </span>
                </div>
                <p className="text-xs text-text-primary break-words line-clamp-2">{row.message}</p>
              </div>
              <span className="text-[10px] text-text-muted shrink-0 mt-0.5">{new Date(row.time).toLocaleTimeString("tr-TR")}</span>
            </div>
          ))}
          {data?.length === 0 && <p className="text-xs text-text-muted py-2">Henüz syslog mesajı alınmadı.</p>}
        </div>
      )}
    </div>
  );
}
