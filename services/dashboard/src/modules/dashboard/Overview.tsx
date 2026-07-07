import { useDevices } from "../devices/useDevices";

export function Overview() {
  const { data: devices } = useDevices({ limit: 10 });

  const total = devices?.length ?? 0;
  const healthy = devices?.filter((d) => d.status === "active").length ?? 0;

  return (
    <div>
      <h1 className="text-lg font-medium mb-4">Genel bakış</h1>
      <div className="grid grid-cols-4 gap-3">
        <div className="bg-surface-1 rounded-xl p-4">
          <p className="text-xs text-text-secondary mb-1">Toplam cihaz</p>
          <p className="text-2xl font-medium">{total}</p>
        </div>
        <div className="bg-surface-1 rounded-xl p-4">
          <p className="text-xs text-text-secondary mb-1">Sağlıklı</p>
          <p className="text-2xl font-medium text-[var(--text-success)]">{healthy}</p>
        </div>
      </div>
    </div>
  );
}
