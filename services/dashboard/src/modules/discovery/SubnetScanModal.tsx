import { useState, useEffect, useRef } from "react";
import { X, Radar, CircleCheck } from "lucide-react";
import { startSubnetScan, fetchScanJob } from "../../api/discovery";
import type { ScanJob } from "../../api/discovery";
import { useCreateDevice } from "../devices/useDevices";

export function SubnetScanModal({ onClose }: { onClose: () => void }) {
  const [cidr, setCidr] = useState("172.28.0.0/24");
  const [community, setCommunity] = useState("public");
  const [job, setJob] = useState<ScanJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedIps, setSelectedIps] = useState<Set<string>>(new Set());
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const createDevice = useCreateDevice();

  async function handleStartScan(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setJob(null);
    try {
      const { jobId } = await startSubnetScan(cidr, community);
      pollRef.current = setInterval(async () => {
        const updated = await fetchScanJob(jobId);
        setJob(updated);
        if (updated.status !== "running" && pollRef.current) {
          clearInterval(pollRef.current);
        }
      }, 2000);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  function toggleSelect(ip: string) {
    setSelectedIps((prev) => {
      const next = new Set(prev);
      if (next.has(ip)) next.delete(ip);
      else next.add(ip);
      return next;
    });
  }

  const [addErrors, setAddErrors] = useState<string[]>([]);

  async function handleAddSelected() {
    if (!job) return;
    const toAdd = job.found.filter((f) => selectedIps.has(f.ip));
    const errors: string[] = [];
    let successCount = 0;

    for (const item of toAdd) {
      const guess = item.sysDescr?.split(" ")[0] || "Device";
      try {
        await createDevice.mutateAsync({
          name: `${guess}-${item.ip.split(".").pop()}`,
          ip_address: item.ip,
          device_type: "server"
        });
        successCount++;
      } catch (err) {
        errors.push(`${item.ip}: ${(err as Error).message}`);
      }
    }

    if (errors.length === 0) {
      onClose();
    } else {
      setAddErrors(errors);
    }
  }

  const progressPercent = job ? Math.round((job.scanned / job.total) * 100) : 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} className="bg-surface-2 border border-border rounded-xl p-5 w-[480px] max-h-[80vh] flex flex-col">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-base font-medium">Ağ taraması</h2>
          <button onClick={onClose} className="text-text-muted"><X size={18} /></button>
        </div>

        <form onSubmit={handleStartScan} className="flex gap-2 mb-4">
          <input
            value={cidr}
            onChange={(e) => setCidr(e.target.value)}
            className="flex-1 px-2.5 py-1.5 text-sm rounded-md border border-border bg-surface-1"
            placeholder="192.168.1.0/24"
          />
          <input
            value={community}
            onChange={(e) => setCommunity(e.target.value)}
            className="w-24 px-2.5 py-1.5 text-sm rounded-md border border-border bg-surface-1"
            placeholder="public"
          />
          <button
            type="submit"
            disabled={job?.status === "running"}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-md bg-[var(--text-accent)] text-white disabled:opacity-50"
          >
            <Radar size={14} className={job?.status === "running" ? "animate-spin" : ""} />
            Taramayı başlat
          </button>
        </form>

        {error && <p className="text-sm text-[var(--text-danger)] mb-3">{error}</p>}

        {job && (
          <>
            <div className="mb-3">
              <div className="flex items-center justify-between text-xs text-text-secondary mb-1">
                <span>{job.status === "running" ? "Taranıyor..." : "Tamamlandı"}</span>
                <span>{job.scanned} / {job.total}</span>
              </div>
              <div className="h-1.5 bg-surface-0 rounded-full overflow-hidden">
                <div className="h-full bg-[var(--text-accent)] transition-all" style={{ width: `${progressPercent}%` }} />
              </div>
            </div>

            <div className="flex-1 overflow-y-auto border border-border rounded-lg">
              {job.found.length === 0 && job.status === "completed" && (
                <p className="text-sm text-text-muted p-4">Bu aralıkta SNMP'ye yanıt veren cihaz bulunamadı.</p>
              )}
              {job.found.map((item) => (
                <label key={item.ip} className="flex items-center gap-3 px-3 py-2.5 border-b border-border last:border-0 hover:bg-surface-1 cursor-pointer">
                  <input type="checkbox" checked={selectedIps.has(item.ip)} onChange={() => toggleSelect(item.ip)} />
                  <CircleCheck size={14} className="text-[var(--text-success)] shrink-0" />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium font-mono">{item.ip}</p>
                    <p className="text-xs text-text-muted truncate">{item.sysDescr} · {item.interfaceCount} interface</p>
                  </div>
                </label>
              ))}
            </div>

            {addErrors.length > 0 && (
              <div className="mt-3 text-xs bg-[var(--bg-warning)] text-[var(--text-warning)] p-2.5 rounded-md">
                {addErrors.map((e, i) => <p key={i}>{e}</p>)}
              </div>
            )}

            {job.found.length > 0 && (
              <button
                onClick={handleAddSelected}
                disabled={selectedIps.size === 0 || createDevice.isPending}
                className="w-full mt-4 py-2 text-sm rounded-md bg-[var(--text-accent)] text-white disabled:opacity-50"
              >
                {createDevice.isPending ? "Ekleniyor..." : `${selectedIps.size} cihazı ekle`}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
