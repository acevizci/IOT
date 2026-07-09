import { useState, useEffect, useMemo, Fragment } from "react";
import { useParams, Link } from "react-router-dom";
import { ArrowLeft, AlertTriangle, CheckCircle2, ShieldAlert, Network, Activity } from "lucide-react";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from "recharts";
import { useMetricNames, useMetrics } from "./useMetrics";
import { useDevice, useLatestData, useDeviceTemplates, useAssignDeviceTemplate, useRemoveDeviceTemplate, useDeviceDiagnostics, useDeviceCollectorConfigs, useSetDeviceCollectorConfig, useDeleteDeviceCollectorConfig } from "./useDevices";
import { useCredentials } from "../credentials/useCredentials";
import { DeviceRelationsPanel } from "../relations/RelationsPanel";
import { useDeviceRules, useCreateDeviceRule, useDeleteDeviceRule, useToggleDeviceRule, useRuleDependencies, useSetRuleDependency, useRemoveRuleDependency } from "./useDeviceRules";
import type { DeviceAlertRule } from "../../api/deviceRules";
import { SEVERITY_LEVELS, SEVERITY_LABEL } from "../shared/severity";
import { Trash2, Plus, Link2 } from "lucide-react";
import { useAlertTemplates } from "../templates/useAlertTemplates";
import { useState as useStateAlias } from "react";
import { X, Settings2 } from "lucide-react";

const RANGE_OPTIONS = [
  { label: "1 saat", hours: 1 },
  { label: "6 saat", hours: 6 },
  { label: "24 saat", hours: 24 },
  { label: "7 gün", hours: 168 }
];

export function DeviceDetail() {
  const { id } = useParams<{ id: string }>();
  const { data: device } = useDevice(id!);
  const [tab, setTab] = useState<"diagnostics" | "relations" | "charts" | "latest" | "templates" | "rules">("diagnostics");

  return (
    <div>
      <Link to="/devices" className="flex items-center gap-1.5 text-sm text-text-secondary mb-3 w-fit">
        <ArrowLeft size={15} />
        Cihazlara dön
      </Link>

      <div className="flex items-center justify-between mb-2">
        <h1 className="text-lg font-medium">{device?.name ?? "Cihaz detayı"}</h1>
      </div>

      {device && (
        <div className="flex items-center gap-2 mb-4 flex-wrap">
          <span className="text-xs text-text-secondary font-mono">{device.ip_address}</span>
          <span className="text-xs text-text-secondary">· {device.device_type}</span>
          {device.location && <span className="text-xs text-text-secondary">· {device.location}</span>}
          {(device.attributes?.tags ?? []).map((t) => (
            <span key={t} className="text-[11px] px-1.5 py-0.5 rounded bg-surface-1 text-text-secondary border border-border">{t}</span>
          ))}
        </div>
      )}

      <div className="flex gap-1 bg-surface-1 rounded-md p-1 border border-border w-fit mb-4">
        <button onClick={() => setTab("diagnostics")} className={`text-xs px-3 py-1.5 rounded ${tab === "diagnostics" ? "bg-[var(--bg-accent)] text-[var(--text-accent)] font-medium" : "text-text-secondary"}`}>
          Sorun giderme
        </button>
        <button onClick={() => setTab("relations")} className={`text-xs px-3 py-1.5 rounded ${tab === "relations" ? "bg-[var(--bg-accent)] text-[var(--text-accent)] font-medium" : "text-text-secondary"}`}>
          İlişkiler
        </button>
        <button onClick={() => setTab("charts")} className={`text-xs px-3 py-1.5 rounded ${tab === "charts" ? "bg-[var(--bg-accent)] text-[var(--text-accent)] font-medium" : "text-text-secondary"}`}>
          Grafikler
        </button>
        <button onClick={() => setTab("latest")} className={`text-xs px-3 py-1.5 rounded ${tab === "latest" ? "bg-[var(--bg-accent)] text-[var(--text-accent)] font-medium" : "text-text-secondary"}`}>
          Güncel değerler
        </button>
        <button onClick={() => setTab("templates")} className={`text-xs px-3 py-1.5 rounded ${tab === "templates" ? "bg-[var(--bg-accent)] text-[var(--text-accent)] font-medium" : "text-text-secondary"}`}>
          Şablonlar
        </button>
        <button onClick={() => setTab("rules")} className={`text-xs px-3 py-1.5 rounded ${tab === "rules" ? "bg-[var(--bg-accent)] text-[var(--text-accent)] font-medium" : "text-text-secondary"}`}>
          Kurallar
        </button>
        <button onClick={() => setTab("connections")} className={`text-xs px-3 py-1.5 rounded ${tab === "connections" ? "bg-[var(--bg-accent)] text-[var(--text-accent)] font-medium" : "text-text-secondary"}`}>
          Bağlantı Ayarları
        </button>
      </div>

      {tab === "diagnostics" && <DiagnosticsTab deviceId={id!} />}
      {tab === "relations" && <DeviceRelationsPanel deviceId={id!} />}
      {tab === "charts" && <ChartsTab deviceId={id!} />}
      {tab === "latest" && <LatestDataTab deviceId={id!} />}
      {tab === "templates" && <TemplatesTab deviceId={id!} />}
      {tab === "rules" && <RulesTab deviceId={id!} />}
      {tab === "connections" && <ConnectionsTab deviceId={id!} />}
    </div>
  );
}

function DiagnosticsTab({ deviceId }: { deviceId: string }) {
  const { data, isLoading } = useDeviceDiagnostics(deviceId);

  if (isLoading) return <p className="text-sm text-text-secondary">Yükleniyor...</p>;
  if (!data) return null;

  const rootCauseNeighbors = data.topology_neighbors.filter((n) => n.likely_root_cause);

  return (
    <div className="flex flex-col gap-4">
      {rootCauseNeighbors.length > 0 && (
        <div className="bg-[var(--bg-danger)] border border-[var(--text-danger)] rounded-xl p-4">
          <div className="flex items-center gap-1.5 mb-2 text-[var(--text-danger)] font-medium text-sm">
            <ShieldAlert size={15} />
            Olası kök neden bulundu
          </div>
          {rootCauseNeighbors.map((n) => (
            <p key={n.id} className="text-sm text-[var(--text-danger)]">
              Bu cihaz topolojide <Link to={`/devices/${n.id}`} className="underline font-medium">{n.name}</Link>'a bağlı,
              orada da {new Date(n.open_alert_triggered_at!).toLocaleString("tr-TR")} tarihinden beri açık bir alarm var
              ({n.open_alert_message}) — asıl sorun orada olabilir.
            </p>
          ))}
        </div>
      )}

      <div className="grid grid-cols-2 gap-4">
        <div className="bg-surface-2 border border-border rounded-xl p-4">
          <p className="text-sm font-medium mb-3 flex items-center gap-1.5">
            <Activity size={14} />
            Son 48 saatteki alarmlar
          </p>
          <div className="flex flex-col gap-2.5">
            {data.recent_alerts.map((a) => (
              <Link key={a.id} to={`/alerts/${a.id}`} className="flex items-start gap-2 text-xs hover:opacity-80">
                {a.resolved_at ? (
                  <CheckCircle2 size={13} className="text-[var(--text-success)] mt-0.5 shrink-0" />
                ) : (
                  <AlertTriangle size={13} className="text-[var(--text-warning)] mt-0.5 shrink-0" />
                )}
                <div className="min-w-0">
                  <p className="truncate">{a.message}</p>
                  <p className="text-text-muted mt-0.5">{new Date(a.triggered_at).toLocaleString("tr-TR")}</p>
                </div>
              </Link>
            ))}
            {data.recent_alerts.length === 0 && <p className="text-xs text-text-muted">Son 48 saatte alarm yok.</p>}
          </div>
        </div>

        <div className="bg-surface-2 border border-border rounded-xl p-4">
          <p className="text-sm font-medium mb-3">Son yapılandırma değişiklikleri</p>
          <div className="flex flex-col gap-2">
            {data.recent_changes.map((c) => (
              <div key={c.id} className="text-xs">
                <div className="flex items-center gap-1.5">
                  <span className="font-medium">{c.method}</span>
                  <span className="text-text-muted font-mono truncate">{c.path}</span>
                </div>
                <p className="text-text-muted mt-0.5">{c.user_email} · {new Date(c.created_at).toLocaleString("tr-TR")}</p>
              </div>
            ))}
            {data.recent_changes.length === 0 && <p className="text-xs text-text-muted">Son dönemde yapılandırma değişikliği yok.</p>}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="bg-surface-2 border border-border rounded-xl p-4">
          <p className="text-sm font-medium mb-3 flex items-center gap-1.5">
            <Network size={14} />
            Topolojide bağlı komşu cihazlar
          </p>
          <div className="flex flex-col gap-2">
            {data.topology_neighbors.map((n) => (
              <div key={n.id} className="flex items-center justify-between text-xs">
                <Link to={`/devices/${n.id}`} className="font-medium hover:text-text-accent">{n.name}</Link>
                {n.open_alert_message ? (
                  <span className={`px-1.5 py-0.5 rounded ${n.likely_root_cause ? "bg-[var(--bg-danger)] text-[var(--text-danger)]" : "bg-[var(--bg-warning)] text-[var(--text-warning)]"}`}>
                    {n.likely_root_cause ? "olası kök neden" : "orada da alarm var"}
                  </span>
                ) : (
                  <span className="text-text-muted">sağlıklı</span>
                )}
              </div>
            ))}
            {data.topology_neighbors.length === 0 && <p className="text-xs text-text-muted">Topolojide bağlı komşu tanımlanmadı.</p>}
          </div>
        </div>

        <div className="bg-surface-2 border border-border rounded-xl p-4">
          <p className="text-sm font-medium mb-3">Aynı zaman aralığında başka cihazlardaki alarmlar</p>
          <div className="flex flex-col gap-2">
            {data.concurrent_incidents.map((c) => (
              <Link key={c.id} to={`/alerts/${c.id}`} className="text-xs hover:opacity-80 block">
                <span className="font-medium">{c.device_name}</span> — {c.message}
                <p className="text-text-muted mt-0.5">{new Date(c.triggered_at).toLocaleString("tr-TR")}</p>
              </Link>
            ))}
            {data.concurrent_incidents.length === 0 && (
              <p className="text-xs text-text-muted">
                {data.anchor_time ? "Bu zaman aralığında başka cihazda alarm yok — izole bir olay gibi görünüyor." : "Şu an açık bir alarm yok."}
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function ChartsTab({ deviceId }: { deviceId: string }) {
  const { data: metricEntries } = useMetricNames(deviceId);
  const [selectedMetric, setSelectedMetric] = useState<string>("");
  const [selectedInterface, setSelectedInterface] = useState<string | undefined>(undefined);
  const [hours, setHours] = useState(6);

  const uniqueMetricNames = useMemo(() => Array.from(new Set(metricEntries?.map((m) => m.metric_name) ?? [])), [metricEntries]);
  const interfacesForMetric = useMemo(
    () => metricEntries?.filter((m) => m.metric_name === selectedMetric && m.interface).map((m) => m.interface as string) ?? [],
    [metricEntries, selectedMetric]
  );

  useEffect(() => {
    if (uniqueMetricNames.length > 0 && !selectedMetric) setSelectedMetric(uniqueMetricNames[0]);
  }, [uniqueMetricNames]);

  useEffect(() => {
    setSelectedInterface(interfacesForMetric.length > 0 ? interfacesForMetric[0] : undefined);
  }, [selectedMetric]);

  const { data } = useMetrics(deviceId, selectedMetric, hours, selectedInterface);
  const chartData = (data?.rows ?? []).map((p) => ({
    time: new Date(p.time).toLocaleString("tr-TR", { hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit" }),
    value: Number(p.value.toFixed(2))
  }));

  return (
    <div>
      <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
        <div className="flex gap-2 flex-wrap">
          {uniqueMetricNames.map((m) => (
            <button key={m} onClick={() => setSelectedMetric(m)} className={`text-xs px-3 py-1.5 rounded-md border ${selectedMetric === m ? "bg-[var(--bg-accent)] text-[var(--text-accent)] border-transparent font-medium" : "border-border text-text-secondary"}`}>
              {m}
            </button>
          ))}
        </div>
        <div className="flex gap-1 bg-surface-1 rounded-md p-1 border border-border">
          {RANGE_OPTIONS.map((r) => (
            <button key={r.hours} onClick={() => setHours(r.hours)} className={`text-xs px-2.5 py-1 rounded ${hours === r.hours ? "bg-[var(--bg-accent)] text-[var(--text-accent)] font-medium" : "text-text-secondary"}`}>
              {r.label}
            </button>
          ))}
        </div>
      </div>

      {interfacesForMetric.length > 0 && (
        <div className="flex gap-2 mb-3">
          {interfacesForMetric.map((iface) => (
            <button key={iface} onClick={() => setSelectedInterface(iface)} className={`text-xs px-2.5 py-1 rounded-md border ${selectedInterface === iface ? "border-[var(--text-accent)] text-[var(--text-accent)]" : "border-border text-text-secondary"}`}>
              {iface}
            </button>
          ))}
        </div>
      )}

      <div className="bg-surface-2 border border-border rounded-xl p-4">
        <div className="flex items-center justify-between mb-3">
          <p className="text-sm font-medium">
            {selectedMetric || "Metrik seçin"}
            {selectedInterface && <span className="text-text-secondary font-normal"> · {selectedInterface}</span>}
          </p>
          {data?.source && <span className="text-xs text-text-muted">kaynak: {data.source}</span>}
        </div>
        <ResponsiveContainer width="100%" height={280}>
          <LineChart data={chartData}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
            <XAxis dataKey="time" tick={{ fontSize: 11, fill: "var(--text-secondary)" }} />
            <YAxis tick={{ fontSize: 12, fill: "var(--text-secondary)" }} />
            <Tooltip contentStyle={{ background: "var(--surface-1)", border: "1px solid var(--border)", fontSize: 13 }} />
            <Line type="monotone" dataKey="value" stroke="var(--text-accent)" strokeWidth={2} dot={false} />
          </LineChart>
        </ResponsiveContainer>
        {chartData.length === 0 && <p className="text-sm text-text-muted py-8 text-center">Veri bulunamadı.</p>}
      </div>
    </div>
  );
}

function LatestDataTab({ deviceId }: { deviceId: string }) {
  const { data: latestData, isLoading } = useLatestData(deviceId);

  return (
    <div className="bg-surface-2 border border-border rounded-xl overflow-hidden">
      {isLoading && <p className="text-sm text-text-secondary p-4">Yükleniyor...</p>}
      <table className="w-full text-sm">
        <thead>
          <tr className="bg-surface-1 text-text-secondary text-left">
            <th className="p-3 font-medium">Metrik</th>
            <th className="p-3 font-medium">Interface</th>
            <th className="p-3 font-medium text-right">Değer</th>
            <th className="p-3 font-medium">Birim</th>
            <th className="p-3 font-medium">Zaman</th>
          </tr>
        </thead>
        <tbody>
          {latestData?.map((d, i) => (
            <tr key={i} className="border-t border-border">
              <td className="p-3 font-medium">{d.metric_name}</td>
              <td className="p-3 text-text-secondary">{d.interface ?? "-"}</td>
              <td className="p-3 text-right font-medium">{Number(d.value).toLocaleString("tr-TR", { maximumFractionDigits: 2 })}</td>
              <td className="p-3 text-text-secondary">{d.unit ?? "-"}</td>
              <td className="p-3 text-text-muted text-xs">{new Date(d.time).toLocaleString("tr-TR")}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {latestData?.length === 0 && <p className="text-sm text-text-muted p-4">Son 1 saatte veri yok.</p>}
    </div>
  );
}


function TemplatesTab({ deviceId }: { deviceId: string }) {
  const { data: assignedTemplates } = useDeviceTemplates(deviceId);
  const { data: allTemplates } = useAlertTemplates();
  const assignTemplate = useAssignDeviceTemplate(deviceId);
  const removeTemplate = useRemoveDeviceTemplate(deviceId);
  const [selectedTemplateId, setSelectedTemplateId] = useStateAlias("");

  const assignedIds = new Set(assignedTemplates?.map((t) => t.id) ?? []);
  const availableTemplates = allTemplates?.filter((t) => !assignedIds.has(t.id)) ?? [];

  function handleAssign(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedTemplateId) return;
    assignTemplate.mutate(selectedTemplateId, { onSuccess: () => setSelectedTemplateId("") });
  }

  return (
    <div>
      <p className="text-sm text-text-secondary mb-3">
        Atanmış şablonlar, bu cihazdan hangi özel SNMP metriklerinin (Items) toplanacağını belirler.
      </p>

      <form onSubmit={handleAssign} className="flex items-end gap-2 mb-4">
        <select value={selectedTemplateId} onChange={(e) => setSelectedTemplateId(e.target.value)} className="px-2.5 py-1.5 text-sm rounded-md border border-border bg-surface-1 w-56">
          <option value="">Şablon seç</option>
          {availableTemplates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
        <button type="submit" disabled={!selectedTemplateId || assignTemplate.isPending} className="px-3 py-1.5 text-sm rounded-md bg-[var(--text-accent)] text-white disabled:opacity-50">
          Ata
        </button>
      </form>

      <div className="border border-border rounded-xl overflow-hidden">
        {assignedTemplates?.map((t) => (
          <div key={t.id} className="flex items-center gap-3 px-4 py-2.5 border-b border-border last:border-0">
            <p className="text-sm font-medium flex-1">{t.name}</p>
            <button onClick={() => removeTemplate.mutate(t.id)} className="text-text-muted hover:text-[var(--text-danger)]">
              <X size={14} />
            </button>
          </div>
        ))}
        {assignedTemplates?.length === 0 && <p className="text-sm text-text-muted p-4">Bu cihaza henüz şablon atanmadı.</p>}
      </div>
    </div>
  );
}


function RulesTab({ deviceId }: { deviceId: string }) {
  const { data: rules, isLoading } = useDeviceRules(deviceId);
  const createRule = useCreateDeviceRule(deviceId);
  const deleteRule = useDeleteDeviceRule(deviceId);
  const toggleRule = useToggleDeviceRule(deviceId);

  const [showForm, setShowForm] = useState(false);
  const [metricName, setMetricName] = useState("");
  const [condition, setCondition] = useState<"gt" | "lt" | "eq">("gt");
  const [threshold, setThreshold] = useState(0);
  const [duration, setDuration] = useState(60);
  const [severity, setSeverity] = useState("warning");

  function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    createRule.mutate(
      { metric_name: metricName, condition, threshold, duration_seconds: duration, severity },
      { onSuccess: () => { setMetricName(""); setThreshold(0); setShowForm(false); } }
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <p className="text-sm text-text-secondary">
          Bu cihaza özel eşik kuralları. Şablondan gelen kurallar da burada görünür ama sadece bu cihaza özel olanlar düzenlenebilir.
        </p>
        <button onClick={() => setShowForm((v) => !v)} className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md border border-border-strong hover:bg-surface-1 shrink-0">
          <Plus size={13} />
          Kural ekle
        </button>
      </div>

      {showForm && (
        <form onSubmit={handleCreate} className="bg-surface-2 border border-border rounded-xl p-3 mb-3 flex items-end gap-2 flex-wrap">
          <input value={metricName} onChange={(e) => setMetricName(e.target.value)} placeholder="metric_name" required className="px-2 py-1.5 text-sm rounded-md border border-border bg-surface-1 w-36" />
          <select value={condition} onChange={(e) => setCondition(e.target.value as "gt" | "lt" | "eq")} className="px-2 py-1.5 text-sm rounded-md border border-border bg-surface-1">
            <option value="gt">&gt;</option>
            <option value="lt">&lt;</option>
            <option value="eq">=</option>
          </select>
          <input type="number" value={threshold} onChange={(e) => setThreshold(Number(e.target.value))} className="px-2 py-1.5 text-sm rounded-md border border-border bg-surface-1 w-20" />
          <input type="number" value={duration} onChange={(e) => setDuration(Number(e.target.value))} className="px-2 py-1.5 text-sm rounded-md border border-border bg-surface-1 w-20" title="süre (sn)" />
          <select value={severity} onChange={(e) => setSeverity(e.target.value)} className="px-2 py-1.5 text-sm rounded-md border border-border bg-surface-1">
            {SEVERITY_LEVELS.map((s) => <option key={s} value={s}>{SEVERITY_LABEL[s]}</option>)}
          </select>
          <button type="submit" disabled={createRule.isPending} className="px-3 py-1.5 text-sm rounded-md bg-[var(--text-accent)] text-white">
            Ekle
          </button>
        </form>
      )}

      {isLoading && <p className="text-sm text-text-secondary">Yükleniyor...</p>}

      <div className="border border-border rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-surface-1 text-text-secondary text-left">
              <th className="p-3 font-medium">Metrik</th>
              <th className="p-3 font-medium">Koşul</th>
              <th className="p-3 font-medium">Kaynak</th>
              <th className="p-3 font-medium">Aktif</th>
              <th className="p-3 font-medium w-10"></th>
              <th className="p-3 font-medium w-10"></th>
            </tr>
          </thead>
          <tbody>
            {rules?.map((r) => (
              <RuleRow key={r.id} rule={r} deviceId={deviceId} allRules={rules} deleteRule={deleteRule} toggleRule={toggleRule} />
            ))}
          </tbody>
        </table>
        {rules?.length === 0 && <p className="text-sm text-text-muted p-4">Kural tanımlanmadı.</p>}
      </div>
    </div>
  );
}

function RuleRow({
  rule,
  deviceId,
  allRules,
  deleteRule,
  toggleRule
}: {
  rule: DeviceAlertRule;
  deviceId: string;
  allRules: DeviceAlertRule[] | undefined;
  deleteRule: ReturnType<typeof useDeleteDeviceRule>;
  toggleRule: ReturnType<typeof useToggleDeviceRule>;
}) {
  const [showDepForm, setShowDepForm] = useState(false);
  const [selectedDependsOn, setSelectedDependsOn] = useState("");
  const { data: dependencies } = useRuleDependencies(rule.id);
  const setDependency = useSetRuleDependency(deviceId);
  const removeDependency = useRemoveRuleDependency(deviceId);

  // Kendisi ve zaten bağımlı olduğu kurallar dışındaki, bu cihazın diğer kuralları
  const dependencyOptions = (allRules ?? []).filter(
    (other) => other.id !== rule.id && !dependencies?.some((d) => d.depends_on_rule_id === other.id)
  );

  function handleAddDependency() {
    if (!selectedDependsOn) return;
    setDependency.mutate({ ruleId: rule.id, dependsOnRuleId: selectedDependsOn }, { onSuccess: () => setSelectedDependsOn("") });
  }

  return (
    <Fragment>
      <tr className="border-t border-border">
        <td className="p-3 font-medium align-top">
          {rule.metric_name}
          {dependencies && dependencies.length > 0 && (
            <div className="flex flex-col gap-0.5 mt-1">
              {dependencies.map((d) => (
                <span key={d.depends_on_rule_id} className="text-[11px] text-text-muted flex items-center gap-1">
                  ↳ bağımlı: {d.metric_name}
                  <button onClick={() => removeDependency.mutate({ ruleId: rule.id, dependsOnRuleId: d.depends_on_rule_id })} className="text-text-muted hover:text-[var(--text-danger)]">
                    <X size={11} />
                  </button>
                </span>
              ))}
            </div>
          )}
        </td>
        <td className="p-3 text-text-secondary align-top">{rule.condition === "gt" ? ">" : rule.condition === "lt" ? "<" : "="} {rule.threshold} · {rule.duration_seconds}s</td>
        <td className="p-3 align-top">
          <span className={`text-xs px-2 py-0.5 rounded-full ${rule.from_template ? "bg-surface-2 text-text-muted" : "bg-[var(--bg-accent)] text-[var(--text-accent)]"}`}>
            {rule.from_template ? "şablondan" : "özel"}
          </span>
        </td>
        <td className="p-3 align-top">
          <input type="checkbox" checked={rule.active} onChange={(e) => toggleRule.mutate({ ruleId: rule.id, active: e.target.checked })} />
        </td>
        <td className="p-3 align-top">
          {dependencyOptions.length > 0 && (
            <button onClick={() => setShowDepForm((v) => !v)} title="Buna bağımlı yap" className="text-text-muted hover:text-text-accent">
              <Link2 size={14} />
            </button>
          )}
        </td>
        <td className="p-3 align-top">
          {!rule.from_template && (
            <button onClick={() => deleteRule.mutate(rule.id)} className="text-text-muted hover:text-[var(--text-danger)]"><Trash2 size={14} /></button>
          )}
        </td>
      </tr>
      {showDepForm && (
        <tr className="bg-surface-1 border-t border-border">
          <td colSpan={6} className="p-3">
            <div className="flex items-center gap-2">
              <span className="text-xs text-text-secondary shrink-0">Şu kural açıksa bu alarm bastırılsın:</span>
              <select value={selectedDependsOn} onChange={(e) => setSelectedDependsOn(e.target.value)} className="px-2 py-1.5 text-sm rounded-md border border-border bg-surface-2 w-56">
                <option value="">Kural seç</option>
                {dependencyOptions.map((o) => (
                  <option key={o.id} value={o.id}>{o.metric_name} ({o.condition === "gt" ? ">" : o.condition === "lt" ? "<" : "="} {o.threshold})</option>
                ))}
              </select>
              <button onClick={handleAddDependency} disabled={!selectedDependsOn || setDependency.isPending} className="text-xs px-3 py-1.5 rounded-md bg-[var(--text-accent)] text-white disabled:opacity-50">
                Ekle
              </button>
            </div>
          </td>
        </tr>
      )}
    </Fragment>
  );
}


const SSH_PORTS_DEFAULT = 22;
const SQL_PORTS_DEFAULT: Record<string, number> = { sql_postgres: 5432, sql_mysql: 3306 };

function ConnectionsTab({ deviceId }: { deviceId: string }) {
  const { data: configs, isLoading } = useDeviceCollectorConfigs(deviceId);
  const { data: credentials } = useCredentials();
  const setConfig = useSetDeviceCollectorConfig(deviceId);
  const deleteConfig = useDeleteDeviceCollectorConfig(deviceId);

  const [showForm, setShowForm] = useState<string | null>(null);
  const [port, setPort] = useState("");
  const [database, setDatabase] = useState("");
  const [credentialId, setCredentialId] = useState("");

  function openForm(collectorType: string) {
    const existing = configs?.find((c) => c.collector_type === collectorType);
    setPort(existing?.config.port?.toString() || (collectorType === "ssh_exec" ? String(SSH_PORTS_DEFAULT) : String(SQL_PORTS_DEFAULT[collectorType] || "")));
    setDatabase(existing?.config.database || "");
    setCredentialId(existing?.config.credential_id || "");
    setShowForm(collectorType);
  }

  function saveConfig(collectorType: string) {
    const config: Record<string, any> = { port: Number(port), credential_id: credentialId };
    if (collectorType !== "ssh_exec") config.database = database;
    setConfig.mutate({ collectorType, config }, { onSuccess: () => setShowForm(null) });
  }

  const definedTypes = new Set(configs?.map((c) => c.collector_type));

  return (
    <div>
      <p className="text-sm text-text-secondary mb-4">
        Bu cihaza SSH/SQL ile bağlanırken kullanılacak port ve kimlik bilgisi. Şablonlardaki metrikler (komut/sorgu)
        bu ayarları kullanarak bu cihaza özel şekilde çalışır — aynı şablon başka bir cihaza uygulandığında o cihazın kendi ayarı kullanılır.
      </p>

      {isLoading && <p className="text-sm text-text-secondary">Yükleniyor...</p>}

      <div className="flex flex-col gap-3">
        {[
          { key: "ssh_exec", label: "SSH" },
          { key: "sql_postgres", label: "PostgreSQL" },
          { key: "sql_mysql", label: "MySQL" }
        ].map((type) => {
          const existing = configs?.find((c) => c.collector_type === type.key);
          return (
            <div key={type.key} className="border border-border rounded-xl p-3.5">
              <div className="flex items-center justify-between mb-1">
                <div className="flex items-center gap-1.5">
                  <Settings2 size={14} className="text-text-secondary" />
                  <p className="text-sm font-medium">{type.label}</p>
                  {definedTypes.has(type.key) && <span className="text-[11px] px-2 py-0.5 rounded-full bg-[var(--bg-success)] text-[var(--text-success)]">yapılandırıldı</span>}
                </div>
                <div className="flex gap-2">
                  <button onClick={() => openForm(type.key)} className="text-xs text-text-accent">{existing ? "düzenle" : "yapılandır"}</button>
                  {existing && <button onClick={() => deleteConfig.mutate(type.key)} className="text-xs text-[var(--text-danger)]">kaldır</button>}
                </div>
              </div>

              {existing && showForm !== type.key && (
                <p className="text-xs text-text-muted">
                  port: {existing.config.port} {existing.config.database && `· db: ${existing.config.database}`} · kimlik: {credentials?.find((c) => c.id === existing.config.credential_id)?.name ?? "?"}
                </p>
              )}

              {showForm === type.key && (
                <div className="flex items-end gap-2 mt-2 flex-wrap">
                  <div>
                    <label className="text-[11px] text-text-secondary block mb-0.5">Port</label>
                    <input type="number" value={port} onChange={(e) => setPort(e.target.value)} className="px-2 py-1 text-xs rounded-md border border-border bg-surface-1 w-20" />
                  </div>
                  {type.key !== "ssh_exec" && (
                    <div>
                      <label className="text-[11px] text-text-secondary block mb-0.5">Veritabanı adı</label>
                      <input value={database} onChange={(e) => setDatabase(e.target.value)} className="px-2 py-1 text-xs rounded-md border border-border bg-surface-1 w-32" />
                    </div>
                  )}
                  <div>
                    <label className="text-[11px] text-text-secondary block mb-0.5">Kimlik bilgisi</label>
                    <select value={credentialId} onChange={(e) => setCredentialId(e.target.value)} className="px-2 py-1 text-xs rounded-md border border-border bg-surface-1 w-36">
                      <option value="">Seç</option>
                      {credentials?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                    </select>
                  </div>
                  <button onClick={() => saveConfig(type.key)} className="text-xs px-2.5 py-1 rounded-md bg-[var(--text-accent)] text-white">Kaydet</button>
                  <button onClick={() => setShowForm(null)} className="text-xs text-text-muted">İptal</button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
