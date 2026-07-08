import { Folders, LayoutTemplate, SlidersHorizontal, Bell } from "lucide-react";
import { useDeviceRelations } from "./useRelations";
import { SEVERITY_LABEL } from "../shared/severity";

export function DeviceRelationsPanel({ deviceId }: { deviceId: string }) {
  const { data, isLoading } = useDeviceRelations(deviceId);

  if (isLoading) return <p className="text-sm text-text-secondary">Yükleniyor...</p>;
  if (!data) return null;

  return (
    <div className="grid grid-cols-2 gap-3">
      <RelationCard icon={<Folders size={15} />} title="Host grupları">
        <div className="flex gap-1.5 flex-wrap">
          {data.device_groups.map((g) => (
            <span key={g.id} className="text-xs px-2.5 py-1 rounded-full bg-surface-2 border border-border">{g.name}</span>
          ))}
          {data.device_groups.length === 0 && <span className="text-xs text-text-muted">Hiçbir gruba ait değil</span>}
        </div>
      </RelationCard>

      <RelationCard icon={<LayoutTemplate size={15} />} title="Atanmış şablonlar">
        <div className="flex flex-col gap-1">
          {data.templates.map((t) => (
            <div key={t.id} className="flex items-center gap-2 text-sm">
              <span className="text-text-accent">{t.name}</span>
              <span className="text-xs text-text-muted">{t.item_count} item · {t.rule_count} kural</span>
            </div>
          ))}
          {data.templates.length === 0 && <span className="text-xs text-text-muted">Şablon atanmadı</span>}
        </div>
      </RelationCard>

      <RelationCard icon={<SlidersHorizontal size={15} />} title="Etkin alarm kuralları" span2 note="şablondan + özel">
        <div className="flex flex-col gap-1.5">
          {data.alert_rules.map((r) => (
            <div key={r.id} className="flex flex-col gap-0.5">
              <div className="flex items-center gap-2 text-xs">
                <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${r.severity === "high" || r.severity === "disaster" ? "bg-[var(--text-danger)]" : "bg-[var(--text-warning)]"}`} />
                <span className="flex-1">{r.metric_name} {r.condition === "gt" ? ">" : r.condition === "lt" ? "<" : "="} {r.threshold} · {r.duration_seconds}s</span>
                <span className={`text-[11px] px-2 py-0.5 rounded-full ${r.from_template ? "bg-surface-2 text-text-muted" : "bg-[var(--bg-accent)] text-[var(--text-accent)]"}`}>
                  {r.from_template ? "şablondan" : "özel"}
                </span>
              </div>
              {r.depends_on_metric_name && (
                <p className="text-[11px] text-text-muted pl-3.5">↳ bağımlı: {r.depends_on_metric_name} (o alarm açıksa bu bastırılır)</p>
              )}
            </div>
          ))}
          {data.alert_rules.length === 0 && <span className="text-xs text-text-muted">Kural tanımlanmadı</span>}
        </div>
      </RelationCard>

      <RelationCard icon={<Bell size={15} />} title="Bu cihazdan kim bildirim alıyor" span2>
        <div className="flex flex-col gap-1.5">
          {data.notification_targets.map((n, i) => (
            <div key={i} className="flex items-center gap-2 text-xs">
              <span className="flex-1 truncate">{n.destination}</span>
              <span className="text-text-muted">{n.media_type} · min: {SEVERITY_LABEL[n.min_severity] ?? n.min_severity}</span>
            </div>
          ))}
          {data.notification_targets.length === 0 && <span className="text-xs text-text-muted">Bildirim tanımlanmadı</span>}
        </div>
      </RelationCard>
    </div>
  );
}

function RelationCard({ icon, title, note, span2, children }: { icon: React.ReactNode; title: string; note?: string; span2?: boolean; children: React.ReactNode }) {
  return (
    <div className={`bg-surface-1 rounded-xl p-3.5 ${span2 ? "col-span-2" : ""}`}>
      <div className="flex items-center gap-1.5 mb-2.5">
        <span className="text-text-secondary">{icon}</span>
        <span className="text-[13px] font-medium">{title}</span>
        {note && <span className="text-[11px] text-text-muted">{note}</span>}
      </div>
      {children}
    </div>
  );
}
