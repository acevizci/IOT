import { useState } from "react";
import { useDevices } from "./useDevices";

const STATUS_STYLES: Record<string, string> = {
  active: "bg-[var(--bg-success)] text-[var(--text-success)]",
  degraded: "bg-[var(--bg-warning)] text-[var(--text-warning)]",
  down: "bg-[var(--bg-danger)] text-[var(--text-danger)]"
};

export function DeviceList() {
  const [search, setSearch] = useState("");
  const { data: devices, isLoading, error } = useDevices({ search, limit: 50 });

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-lg font-medium">Cihazlar</h1>
          <p className="text-sm text-text-secondary">{devices?.length ?? 0} cihaz</p>
        </div>
      </div>

      <input
        type="text"
        placeholder="İsim veya IP ara..."
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        className="mb-4 px-3 py-2 text-sm rounded-md border border-border bg-surface-1 max-w-xs w-full"
      />

      {isLoading && <p className="text-sm text-text-secondary">Yükleniyor...</p>}
      {error && <p className="text-sm text-[var(--text-danger)]">Hata: {(error as Error).message}</p>}

      {devices && (
        <div className="border border-border rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-surface-1 text-text-secondary text-left">
                <th className="p-3 font-medium">İsim</th>
                <th className="p-3 font-medium">IP adresi</th>
                <th className="p-3 font-medium">Tip</th>
                <th className="p-3 font-medium">Lokasyon</th>
                <th className="p-3 font-medium">Durum</th>
              </tr>
            </thead>
            <tbody>
              {devices.map((d) => (
                <tr key={d.id} className="border-t border-border">
                  <td className="p-3 font-medium">{d.name}</td>
                  <td className="p-3 text-text-secondary">{d.ip_address}</td>
                  <td className="p-3 text-text-secondary">{d.device_type}</td>
                  <td className="p-3 text-text-secondary">{d.location ?? "-"}</td>
                  <td className="p-3">
                    <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${STATUS_STYLES[d.status] ?? ""}`}>
                      {d.status}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
