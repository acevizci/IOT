import { useState } from "react";
import { Trash2, Plus } from "lucide-react";
import { useAlertRules, useCreateAlertRule, useToggleAlertRule, useDeleteAlertRule } from "./useAlertRules";
import { useDevices } from "../devices/useDevices";

const CONDITION_LABEL: Record<string, string> = { gt: "büyükse", lt: "küçükse", eq: "eşitse" };

export function AlertRules() {
  const { data: rules, isLoading } = useAlertRules();
  const { data: devices } = useDevices({ limit: 200 });
  const createRule = useCreateAlertRule();
  const toggleRule = useToggleAlertRule();
  const deleteRule = useDeleteAlertRule();

  const [metricName, setMetricName] = useState("memory_used_percent");
  const [condition, setCondition] = useState<"gt" | "lt" | "eq">("gt");
  const [threshold, setThreshold] = useState(90);
  const [durationSeconds, setDurationSeconds] = useState(60);
  const [deviceId, setDeviceId] = useState<string>("");

  function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    createRule.mutate({
      metric_name: metricName,
      condition,
      threshold,
      duration_seconds: durationSeconds,
      device_id: deviceId || null
    });
  }

  return (
    <div>
      <h1 className="text-lg font-medium mb-1">Alarm kuralları</h1>
      <p className="text-sm text-text-secondary mb-5">
        Eşik değerlerini buradan tanımla — bir metrik belirttiğin süre boyunca koşulu sağlarsa alarm üretilir.
      </p>

      <form onSubmit={handleCreate} className="bg-surface-2 border border-border rounded-xl p-4 mb-5 flex items-end gap-3 flex-wrap">
        <Field label="Metrik">
          <input value={metricName} onChange={(e) => setMetricName(e.target.value)}
            className="px-2.5 py-1.5 text-sm rounded-md border border-border bg-surface-1 w-44" placeholder="memory_used_percent" />
        </Field>
        <Field label="Koşul">
          <select value={condition} onChange={(e) => setCondition(e.target.value as "gt" | "lt" | "eq")}
            className="px-2.5 py-1.5 text-sm rounded-md border border-border bg-surface-1">
            <option value="gt">büyükse (&gt;)</option>
            <option value="lt">küçükse (&lt;)</option>
            <option value="eq">eşitse (=)</option>
          </select>
        </Field>
        <Field label="Eşik değeri">
          <input type="number" value={threshold} onChange={(e) => setThreshold(Number(e.target.value))}
            className="px-2.5 py-1.5 text-sm rounded-md border border-border bg-surface-1 w-24" />
        </Field>
        <Field label="Süre (sn)">
          <input type="number" value={durationSeconds} onChange={(e) => setDurationSeconds(Number(e.target.value))}
            className="px-2.5 py-1.5 text-sm rounded-md border border-border bg-surface-1 w-20" />
        </Field>
        <Field label="Cihaz">
          <select value={deviceId} onChange={(e) => setDeviceId(e.target.value)}
            className="px-2.5 py-1.5 text-sm rounded-md border border-border bg-surface-1 w-40">
            <option value="">Tüm cihazlar</option>
            {devices?.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        </Field>
        <button type="submit" disabled={createRule.isPending}
          className="flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-md bg-[var(--text-accent)] text-white">
          <Plus size={15} />
          Kural ekle
        </button>
      </form>

      {isLoading && <p className="text-sm text-text-secondary">Yükleniyor...</p>}

      <div className="border border-border rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-surface-1 text-text-secondary text-left">
              <th className="p-3 font-medium">Metrik</th>
              <th className="p-3 font-medium">Koşul</th>
              <th className="p-3 font-medium">Cihaz</th>
              <th className="p-3 font-medium">Süre</th>
              <th className="p-3 font-medium">Aktif</th>
              <th className="p-3 font-medium"></th>
            </tr>
          </thead>
          <tbody>
            {rules?.map((r) => (
              <tr key={r.id} className="border-t border-border">
                <td className="p-3 font-medium">{r.metric_name}</td>
                <td className="p-3 text-text-secondary">{CONDITION_LABEL[r.condition]} {r.threshold}</td>
                <td className="p-3 text-text-secondary">{r.device_name ?? "Tüm cihazlar"}</td>
                <td className="p-3 text-text-secondary">{r.duration_seconds}s</td>
                <td className="p-3">
                  <input type="checkbox" checked={r.active} onChange={(e) => toggleRule.mutate({ id: r.id, active: e.target.checked })} />
                </td>
                <td className="p-3">
                  <button onClick={() => deleteRule.mutate(r.id)} className="text-text-muted hover:text-[var(--text-danger)]">
                    <Trash2 size={15} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {rules?.length === 0 && <p className="text-sm text-text-muted p-4">Henüz kural tanımlanmadı.</p>}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-xs text-text-secondary">{label}</label>
      {children}
    </div>
  );
}
