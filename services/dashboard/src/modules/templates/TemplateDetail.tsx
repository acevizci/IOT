import { useState } from "react";
import { useParams, Link } from "react-router-dom";
import { ArrowLeft, Plus, Trash2, Pencil, Check, X } from "lucide-react";
import {
  useAlertTemplate, useTemplateDevices, useUpdateTemplate,
  useAddTemplateRule, useUpdateTemplateRule, useDeleteTemplateRule
} from "./useAlertTemplates";
import { useTemplateItems, useCreateTemplateItem, useDeleteTemplateItem, useUpdateTemplateItem } from "./useTemplateItems";
import { useTemplateWebScenarios, useCreateWebScenario, useDeleteWebScenario } from "../webScenarios/useWebScenarios";
import { Globe } from "lucide-react";
import { useCollectorTypes } from "./useCollectorTypes";
import { SEVERITY_LABEL, SEVERITY_LEVELS } from "../shared/severity";

const CONDITION_LABEL: Record<string, string> = { gt: "büyükse", lt: "küçükse", eq: "eşitse" };

export function TemplateDetail() {
  const { id } = useParams<{ id: string }>();
  const { data: template, isLoading } = useAlertTemplate(id!);
  const { data: items, isLoading: itemsLoading } = useTemplateItems(id!);
  const { data: devices } = useTemplateDevices(id!);

  const updateTemplate = useUpdateTemplate(id!);
  const addRule = useAddTemplateRule(id!);
  const updateRule = useUpdateTemplateRule(id!);
  const deleteRule = useDeleteTemplateRule(id!);
  const createItem = useCreateTemplateItem(id!);
  const deleteItem = useDeleteTemplateItem(id!);
  const updateItem = useUpdateTemplateItem(id!);

  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState("");

  const [showRuleForm, setShowRuleForm] = useState(false);
  const [ruleMetric, setRuleMetric] = useState("");
  const [ruleCondition, setRuleCondition] = useState<"gt" | "lt" | "eq">("gt");
  const [ruleThreshold, setRuleThreshold] = useState(0);
  const [ruleDuration, setRuleDuration] = useState(60);
  const [ruleSeverity, setRuleSeverity] = useState("warning");
  const [editingRuleId, setEditingRuleId] = useState<string | null>(null);
  const [editThreshold, setEditThreshold] = useState(0);

  const { data: collectorTypes } = useCollectorTypes();

  const [activeTab, setActiveTab] = useState<"items" | "rules" | "web">("rules");

  const { data: webScenarios } = useTemplateWebScenarios(id!);
  const createScenario = useCreateWebScenario(id!);
  const deleteScenario = useDeleteWebScenario(id!);
  const [showScenarioForm, setShowScenarioForm] = useState(false);
  const [scenarioName, setScenarioName] = useState("");
  const [scenarioSteps, setScenarioSteps] = useState<Array<{ name: string; url: string; expected_status_code: number }>>([
    { name: "", url: "", expected_status_code: 200 }
  ]);

  function addScenarioStep() {
    setScenarioSteps([...scenarioSteps, { name: "", url: "", expected_status_code: 200 }]);
  }
  function updateScenarioStep(i: number, field: "name" | "url" | "expected_status_code", value: string) {
    setScenarioSteps(scenarioSteps.map((s, idx) => (idx === i ? { ...s, [field]: field === "expected_status_code" ? Number(value) : value } : s)));
  }
  function removeScenarioStep(i: number) {
    setScenarioSteps(scenarioSteps.filter((_, idx) => idx !== i));
  }
  function handleCreateScenario(e: React.FormEvent) {
    e.preventDefault();
    createScenario.mutate(
      { name: scenarioName, polling_interval_seconds: 300, steps: scenarioSteps },
      { onSuccess: () => { setScenarioName(""); setScenarioSteps([{ name: "", url: "", expected_status_code: 200 }]); setShowScenarioForm(false); } }
    );
  }

  const [showItemForm, setShowItemForm] = useState(false);
  const [itemMetric, setItemMetric] = useState("");
  const [itemCollectorType, setItemCollectorType] = useState("snmp");
  const [itemOid, setItemOid] = useState("");
  const [itemConfig, setItemConfig] = useState<Record<string, string>>({});

  const selectedCollector = collectorTypes?.find((c) => c.key === itemCollectorType);

  function startEditName() {
    setNameDraft(template?.name || "");
    setEditingName(true);
  }
  function saveEditName() {
    updateTemplate.mutate({ name: nameDraft }, { onSuccess: () => setEditingName(false) });
  }

  function handleAddRule(e: React.FormEvent) {
    e.preventDefault();
    addRule.mutate(
      { metric_name: ruleMetric, condition: ruleCondition, threshold: ruleThreshold, duration_seconds: ruleDuration, severity: ruleSeverity },
      { onSuccess: () => { setRuleMetric(""); setRuleThreshold(0); setShowRuleForm(false); } }
    );
  }

  const [editDependsOn, setEditDependsOn] = useState<string>("");

  function startEditRule(ruleId: string, currentThreshold: number, currentDependsOn: string | null) {
    setEditingRuleId(ruleId);
    setEditThreshold(currentThreshold);
    setEditDependsOn(currentDependsOn || "");
  }
  function saveEditRule(ruleId: string) {
    updateRule.mutate(
      { ruleId, input: { threshold: editThreshold, depends_on_template_rule_id: editDependsOn || null } },
      { onSuccess: () => setEditingRuleId(null) }
    );
  }

  function handleCreateItem(e: React.FormEvent) {
    e.preventDefault();
    createItem.mutate(
      {
        metric_name: itemMetric,
        oid: itemCollectorType === "snmp" ? itemOid : undefined,
        data_type: "gauge",
        polling_interval_seconds: 60,
        is_table: false,
        collector_type: itemCollectorType,
        connection_config: itemCollectorType === "snmp" ? {} : itemConfig
      },
      { onSuccess: () => { setItemMetric(""); setItemOid(""); setItemConfig({}); setShowItemForm(false); } }
    );
  }

  function updateConfigField(field: string, value: string) {
    setItemConfig((prev) => ({ ...prev, [field]: value }));
  }

  if (isLoading) return <p className="text-sm text-text-secondary">Yükleniyor...</p>;
  if (!template) return <p className="text-sm text-[var(--text-danger)]">Şablon bulunamadı.</p>;

  return (
    <div>
      <Link to="/templates" className="flex items-center gap-1.5 text-sm text-text-secondary mb-3 w-fit">
        <ArrowLeft size={15} />
        Şablonlara dön
      </Link>

      {editingName ? (
        <div className="flex items-center gap-2 mb-1">
          <input value={nameDraft} onChange={(e) => setNameDraft(e.target.value)} className="text-lg font-medium px-2 py-1 rounded-md border border-border bg-surface-1" autoFocus />
          <button onClick={saveEditName} className="text-[var(--text-success)]"><Check size={18} /></button>
          <button onClick={() => setEditingName(false)} className="text-text-muted"><X size={18} /></button>
        </div>
      ) : (
        <div className="flex items-center gap-2 mb-1">
          <h1 className="text-lg font-medium">{template.name}</h1>
          <button onClick={startEditName} className="text-text-muted hover:text-text-accent"><Pencil size={14} /></button>
        </div>
      )}

      <div className="flex items-center gap-2 mb-3 flex-wrap">
        <p className="text-sm text-text-secondary">{template.device_type ?? "Tüm cihaz tipleri"}</p>
        {(template.tags ?? []).map((tag) => (
          <span key={tag} className="text-[11px] px-2 py-0.5 rounded-full bg-surface-2 border border-border text-text-secondary">{tag}</span>
        ))}
      </div>

      {(template.parent_template_name || (template.children && template.children.length > 0)) && (
        <div className="bg-surface-1 rounded-xl p-3.5 mb-5 flex gap-8">
          <div>
            <p className="text-xs text-text-secondary mb-1">Miras alınan şablon</p>
            {template.parent_template_name ? (
              <Link to={`/templates/${template.parent_template_id}`} className="text-sm text-text-accent">{template.parent_template_name}</Link>
            ) : <p className="text-sm text-text-muted">Yok</p>}
          </div>
          <div>
            <p className="text-xs text-text-secondary mb-1">Bu şablonu miras alanlar</p>
            {template.children && template.children.length > 0 ? (
              <div className="flex gap-2 flex-wrap">
                {template.children.map((c) => <Link key={c.id} to={`/templates/${c.id}`} className="text-sm text-text-accent">{c.name}</Link>)}
              </div>
            ) : <p className="text-sm text-text-muted">Yok</p>}
          </div>
        </div>
      )}

      <div className="bg-[var(--bg-accent)] rounded-lg px-3 py-2 mb-4 text-xs text-[var(--text-accent)]">
        <strong>Not:</strong> Items (metrik tanımları) cihazlara canlı bağlıdır — burada yaptığın değişiklik atanmış tüm cihazlara anında yansır.
        Alarm kuralları ise cihaza <strong>kopyalanır</strong> — burada değişiklik yapmak, şablonu daha önce uygulamış olduğun cihazları etkilemez;
        değişikliği yaymak için şablonu ilgili host grubuna tekrar uygulaman gerekir.
      </div>

      <div className="flex gap-1 bg-surface-1 rounded-md p-1 border border-border w-fit mb-4">
        <button onClick={() => setActiveTab("rules")} className={`text-xs px-3 py-1.5 rounded ${activeTab === "rules" ? "bg-[var(--bg-accent)] text-[var(--text-accent)] font-medium" : "text-text-secondary"}`}>
          Kurallar ({template.rules.length})
        </button>
        <button onClick={() => setActiveTab("items")} className={`text-xs px-3 py-1.5 rounded ${activeTab === "items" ? "bg-[var(--bg-accent)] text-[var(--text-accent)] font-medium" : "text-text-secondary"}`}>
          Items ({items?.length ?? 0})
        </button>
        <button onClick={() => setActiveTab("web")} className={`text-xs px-3 py-1.5 rounded ${activeTab === "web" ? "bg-[var(--bg-accent)] text-[var(--text-accent)] font-medium" : "text-text-secondary"}`}>
          Web Senaryoları ({webScenarios?.length ?? 0})
        </button>
      </div>

      {activeTab === "web" && (
        <div className="mb-4">
          <div className="flex items-center justify-between mb-2">
            <p className="text-sm text-text-secondary">Çok adımlı HTTP durum kontrolü — her adım otomatik olarak response_code/response_time/status metrikleri üretir</p>
            <button onClick={() => setShowScenarioForm((v) => !v)} className="text-xs text-text-accent flex items-center gap-1 shrink-0"><Plus size={13} />Senaryo ekle</button>
          </div>

          {showScenarioForm && (
            <form onSubmit={handleCreateScenario} className="bg-surface-2 border border-border rounded-lg p-3 mb-3 flex flex-col gap-2">
              <input value={scenarioName} onChange={(e) => setScenarioName(e.target.value)} placeholder="Senaryo adı" required className="px-2 py-1 text-sm rounded-md border border-border bg-surface-1" />
              {scenarioSteps.map((step, i) => (
                <div key={i} className="flex items-center gap-2">
                  <input value={step.name} onChange={(e) => updateScenarioStep(i, "name", e.target.value)} placeholder="Adım adı" required className="px-2 py-1 text-xs rounded-md border border-border bg-surface-1 w-32" />
                  <input value={step.url} onChange={(e) => updateScenarioStep(i, "url", e.target.value)} placeholder="URL" required className="px-2 py-1 text-xs rounded-md border border-border bg-surface-1 flex-1" />
                  <input type="number" value={step.expected_status_code} onChange={(e) => updateScenarioStep(i, "expected_status_code", e.target.value)} className="px-2 py-1 text-xs rounded-md border border-border bg-surface-1 w-16" />
                  {scenarioSteps.length > 1 && <button type="button" onClick={() => removeScenarioStep(i)} className="text-text-muted hover:text-[var(--text-danger)]"><Trash2 size={13} /></button>}
                </div>
              ))}
              <button type="button" onClick={addScenarioStep} className="text-xs text-text-accent w-fit">+ Adım ekle</button>
              <button type="submit" className="px-2.5 py-1 text-xs rounded-md bg-[var(--text-accent)] text-white w-fit">Kaydet</button>
            </form>
          )}

          <div className="border border-border rounded-xl overflow-hidden">
            {webScenarios?.map((ws) => (
              <div key={ws.id} className="flex items-center gap-3 px-4 py-2.5 border-b border-border last:border-0">
                <Globe size={15} className="text-text-secondary shrink-0" />
                <Link to={`/web-scenarios/${ws.id}`} className="text-sm font-medium flex-1 hover:text-text-accent">{ws.name}</Link>
                <span className="text-xs text-text-muted">{ws.step_count} adım</span>
                <button onClick={() => deleteScenario.mutate(ws.id)} className="text-text-muted hover:text-[var(--text-danger)]"><Trash2 size={14} /></button>
              </div>
            ))}
            {webScenarios?.length === 0 && <p className="text-sm text-text-muted p-4">Henüz Web Senaryosu tanımlanmadı.</p>}
          </div>
        </div>
      )}

      {activeTab !== "web" && (
      <div className="grid grid-cols-2 gap-4 mb-4">
        {activeTab === "rules" && (
        <div>
          <div className="flex items-center justify-between mb-2">
            <p className="text-sm font-medium">Alarm kuralları</p>
            <button onClick={() => setShowRuleForm((v) => !v)} className="text-xs text-text-accent flex items-center gap-1"><Plus size={13} />Ekle</button>
          </div>

          {showRuleForm && (
            <form onSubmit={handleAddRule} className="bg-surface-2 border border-border rounded-lg p-2.5 mb-2 flex flex-col gap-1.5">
              <input value={ruleMetric} onChange={(e) => setRuleMetric(e.target.value)} placeholder="metric_name" required className="px-2 py-1 text-xs rounded-md border border-border bg-surface-1" />
              <div className="flex gap-1.5">
                <select value={ruleCondition} onChange={(e) => setRuleCondition(e.target.value as any)} className="px-2 py-1 text-xs rounded-md border border-border bg-surface-1">
                  <option value="gt">&gt;</option><option value="lt">&lt;</option><option value="eq">=</option>
                </select>
                <input type="number" value={ruleThreshold} onChange={(e) => setRuleThreshold(Number(e.target.value))} className="w-16 px-2 py-1 text-xs rounded-md border border-border bg-surface-1" />
                <input type="number" value={ruleDuration} onChange={(e) => setRuleDuration(Number(e.target.value))} className="w-16 px-2 py-1 text-xs rounded-md border border-border bg-surface-1" title="süre (sn)" />
                <select value={ruleSeverity} onChange={(e) => setRuleSeverity(e.target.value)} className="px-2 py-1 text-xs rounded-md border border-border bg-surface-1">
                  {SEVERITY_LEVELS.map((s) => <option key={s} value={s}>{SEVERITY_LABEL[s]}</option>)}
                </select>
              </div>
              <button type="submit" className="px-2.5 py-1 text-xs rounded-md bg-[var(--text-accent)] text-white">Ekle</button>
            </form>
          )}

          <div className="border border-border rounded-xl overflow-hidden">
            {template.rules.map((r) => (
              <div key={r.id} className="px-4 py-2.5 border-b border-border last:border-0 text-sm">
                <div className="flex items-center justify-between">
                  <p className="font-medium">{r.metric_name}</p>
                  <div className="flex gap-1.5">
                    <button onClick={() => startEditRule(r.id, r.threshold, r.depends_on_template_rule_id)} className="text-text-muted hover:text-text-accent"><Pencil size={12} /></button>
                    <button onClick={() => deleteRule.mutate(r.id)} className="text-text-muted hover:text-[var(--text-danger)]"><Trash2 size={12} /></button>
                  </div>
                </div>
                {editingRuleId === r.id ? (
                  <div className="flex flex-col gap-1.5 mt-1">
                    <div className="flex items-center gap-1.5">
                      <input type="number" value={editThreshold} onChange={(e) => setEditThreshold(Number(e.target.value))} className="w-20 px-1.5 py-0.5 text-xs rounded border border-border bg-surface-1" />
                      <select value={editDependsOn} onChange={(e) => setEditDependsOn(e.target.value)} className="text-xs px-1.5 py-0.5 rounded border border-border bg-surface-1 w-32">
                        <option value="">Bağımlı değil</option>
                        {template.rules.filter((other) => other.id !== r.id).map((other) => (
                          <option key={other.id} value={other.id}>↳ {other.metric_name}</option>
                        ))}
                      </select>
                      <button onClick={() => saveEditRule(r.id)} className="text-[var(--text-success)]"><Check size={14} /></button>
                      <button onClick={() => setEditingRuleId(null)} className="text-text-muted"><X size={14} /></button>
                    </div>
                  </div>
                ) : (
                  <p className="text-xs text-text-secondary">
                    {CONDITION_LABEL[r.condition]} {r.threshold} · {r.duration_seconds}s · {SEVERITY_LABEL[r.severity] ?? r.severity}
                  </p>
                )}
                {r.depends_on_metric_name && <p className="text-xs text-text-muted mt-1">↳ bağımlı: {r.depends_on_metric_name}</p>}
              </div>
            ))}
            {template.rules.length === 0 && <p className="text-sm text-text-muted p-4">Kural yok.</p>}
          </div>
        </div>
        )}

        {activeTab === "items" && (
        <div>
          <div className="flex items-center justify-between mb-2">
            <p className="text-sm font-medium">Metrik tanımları (Items)</p>
            <button onClick={() => setShowItemForm((v) => !v)} className="text-xs text-text-accent flex items-center gap-1"><Plus size={13} />Ekle</button>
          </div>

          {showItemForm && (
            <form onSubmit={handleCreateItem} className="bg-surface-2 border border-border rounded-lg p-2.5 mb-2 flex flex-col gap-1.5">
              <input value={itemMetric} onChange={(e) => setItemMetric(e.target.value)} placeholder="metric_name" required className="px-2 py-1 text-xs rounded-md border border-border bg-surface-1" />

              <select value={itemCollectorType} onChange={(e) => { setItemCollectorType(e.target.value); setItemConfig({}); }} className="px-2 py-1 text-xs rounded-md border border-border bg-surface-1">
                {collectorTypes?.map((c) => <option key={c.key} value={c.key}>{c.display_name}</option>)}
              </select>

              {itemCollectorType === "snmp" && (
                <input value={itemOid} onChange={(e) => setItemOid(e.target.value)} placeholder="OID" required className="px-2 py-1 text-xs rounded-md border border-border bg-surface-1 font-mono" />
              )}

              {itemCollectorType === "tcp_port" && (
                <input type="number" value={itemConfig.port || ""} onChange={(e) => updateConfigField("port", e.target.value)} placeholder="Port (örn. 5432)" required className="px-2 py-1 text-xs rounded-md border border-border bg-surface-1" />
              )}

              {itemCollectorType === "http_json" && (
                <>
                  <input value={itemConfig.url || ""} onChange={(e) => updateConfigField("url", e.target.value)} placeholder="URL (http://...)" required className="px-2 py-1 text-xs rounded-md border border-border bg-surface-1" />
                  <input value={itemConfig.json_path || ""} onChange={(e) => updateConfigField("json_path", e.target.value)} placeholder="JSON alanı (örn. data.value)" className="px-2 py-1 text-xs rounded-md border border-border bg-surface-1" />
                </>
              )}

              {(itemCollectorType === "sql_postgres" || itemCollectorType === "sql_mysql") && (
                <>
                  <textarea value={itemConfig.query || ""} onChange={(e) => updateConfigField("query", e.target.value)} placeholder="SELECT ..." required className="px-2 py-1 text-xs rounded-md border border-border bg-surface-1 font-mono h-14" />
                  <p className="text-[10px] text-text-muted">Host/port/veritabanı/kimlik bilgisi, bu şablonun uygulandığı her cihazın kendi "Bağlantı Ayarları" sekmesinden (makro override) gelir.</p>
                </>
              )}

              {itemCollectorType === "ssh_exec" && (
                <>
                  <input value={itemConfig.command || ""} onChange={(e) => updateConfigField("command", e.target.value)} placeholder="Komut (örn. nproc)" required className="px-2 py-1 text-xs rounded-md border border-border bg-surface-1 font-mono" />
                  <input value={itemConfig.parse_pattern || ""} onChange={(e) => updateConfigField("parse_pattern", e.target.value)} placeholder="Regex (opsiyonel, boşsa son satır kullanılır)" className="px-2 py-1 text-xs rounded-md border border-border bg-surface-1 font-mono" />
                  <p className="text-[10px] text-text-muted">Host/port/kimlik bilgisi, bu şablonun uygulandığı her cihazın kendi "Bağlantı Ayarları" sekmesinden (makro override) gelir.</p>
                </>
              )}

              {selectedCollector && (
                <p className="text-[10px] text-text-muted">{selectedCollector.handler_service} tarafından işlenir</p>
              )}

              <button type="submit" className="px-2.5 py-1 text-xs rounded-md bg-[var(--text-accent)] text-white">Ekle</button>
            </form>
          )}

          {itemsLoading && <p className="text-sm text-text-secondary">Yükleniyor...</p>}

          <div className="border border-border rounded-xl overflow-hidden">
            {items?.map((item) => (
              <div key={item.id} className="flex items-center gap-3 px-4 py-2.5 border-b border-border last:border-0">
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium">{item.metric_name}</p>
                  <p className="text-xs text-text-muted font-mono truncate">
                    {item.oid || (item.formula ? `formül: ${item.formula}` : JSON.stringify(item.connection_config))}
                  </p>
                </div>
                <span className="text-[11px] px-2 py-0.5 rounded-full bg-surface-1 border border-border text-text-secondary shrink-0">
                  {collectorTypes?.find((c) => c.key === item.collector_type)?.display_name ?? item.collector_type}
                </span>
                <button onClick={() => deleteItem.mutate(item.id)} className="text-text-muted hover:text-[var(--text-danger)] shrink-0"><Trash2 size={13} /></button>
              </div>
            ))}
            {items?.length === 0 && <p className="text-sm text-text-muted p-4">Henüz özel metrik tanımlanmadı.</p>}
          </div>
        </div>
        )}
      </div>
      )}

      <div>
        <p className="text-sm font-medium mb-2">Bu şablonu kullanan cihazlar ({devices?.length ?? 0})</p>
        <div className="border border-border rounded-xl overflow-hidden">
          {devices?.map((d) => (
            <Link key={d.id} to={`/devices/${d.id}`} className="flex items-center gap-3 px-4 py-2.5 border-b border-border last:border-0 hover:bg-surface-1 text-sm">
              <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${d.status === "active" ? "bg-[var(--text-success)]" : "bg-[var(--text-warning)]"}`} />
              <span className="font-medium flex-1">{d.name}</span>
              <span className="text-text-secondary font-mono text-xs">{d.ip_address}</span>
              <span className="text-text-secondary text-xs">{d.device_type}</span>
            </Link>
          ))}
          {devices?.length === 0 && <p className="text-sm text-text-muted p-4">Bu şablon henüz hiçbir cihaza uygulanmadı.</p>}
        </div>
      </div>
    </div>
  );
}
