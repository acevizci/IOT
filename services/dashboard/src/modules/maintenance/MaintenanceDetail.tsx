import { useParams, Link } from "react-router-dom";
import { ArrowLeft, Clock, Router, Folders } from "lucide-react";
import { useMaintenanceWindow } from "./useMaintenance";

export function MaintenanceDetail() {
  const { id } = useParams<{ id: string }>();
  const { data: mw, isLoading } = useMaintenanceWindow(id!);

  if (isLoading) return <p className="text-sm text-text-secondary">Yükleniyor...</p>;
  if (!mw) return <p className="text-sm text-[var(--text-danger)]">Bakım penceresi bulunamadı.</p>;

  return (
    <div>
      <Link to="/maintenance" className="flex items-center gap-1.5 text-sm text-text-secondary mb-3 w-fit">
        <ArrowLeft size={15} />
        Bakım pencerelerine dön
      </Link>

      <div className="flex items-center gap-2 mb-1">
        <Clock size={18} className={mw.is_active ? "text-[var(--text-warning)]" : "text-text-secondary"} />
        <h1 className="text-lg font-medium">{mw.name}</h1>
        {mw.is_active && <span className="text-[11px] px-2 py-0.5 rounded-full bg-[var(--bg-warning)] text-[var(--text-warning)] font-medium">aktif</span>}
      </div>
      <p className="text-sm text-text-secondary mb-5">
        {new Date(mw.starts_at).toLocaleString("tr-TR")} → {new Date(mw.ends_at).toLocaleString("tr-TR")}
      </p>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <div className="flex items-center gap-1.5 mb-2">
            <Router size={15} className="text-text-secondary" />
            <p className="text-sm font-medium">Kapsanan cihazlar ({mw.devices.length})</p>
          </div>
          <div className="border border-border rounded-xl overflow-hidden">
            {mw.devices.map((d) => (
              <Link key={d.id} to={`/devices/${d.id}`} className="block px-4 py-2.5 border-b border-border last:border-0 hover:bg-surface-1 text-sm">
                {d.name}
              </Link>
            ))}
            {mw.devices.length === 0 && <p className="text-sm text-text-muted p-4">Doğrudan cihaz seçilmedi.</p>}
          </div>
        </div>

        <div>
          <div className="flex items-center gap-1.5 mb-2">
            <Folders size={15} className="text-text-secondary" />
            <p className="text-sm font-medium">Kapsanan host grupları ({mw.groups.length})</p>
          </div>
          <div className="border border-border rounded-xl overflow-hidden">
            {mw.groups.map((g) => (
              <Link key={g.id} to={`/device-groups/${g.id}`} className="block px-4 py-2.5 border-b border-border last:border-0 hover:bg-surface-1 text-sm">
                {g.name}
              </Link>
            ))}
            {mw.groups.length === 0 && <p className="text-sm text-text-muted p-4">Host grubu seçilmedi.</p>}
          </div>
        </div>
      </div>
    </div>
  );
}
