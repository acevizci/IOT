import { useState } from "react";
import { useParams, Link, useNavigate } from "react-router-dom";
import { ArrowLeft, Plus, Trash2, Pencil, Check, X, Lock, Copy } from "lucide-react";
import {
  useAlertTemplate, useTemplateDevices, useUpdateTemplate,
  useAddTemplateRule, useUpdateTemplateRule, useDeleteTemplateRule, useSetTemplateRuleEscalationPolicy,
  useCloneTemplate
} from "./useAlertTemplates";
import { useEscalationPolicies } from "../escalationPolicies/useEscalationPolicies";
import { useTemplateItems, useCreateTemplateItem, useDeleteTemplateItem } from "./useTemplateItems";
import { useTemplateWebScenarios, useCreateWebScenario, useDeleteWebScenario } from "../webScenarios/useWebScenarios";
import { Globe } from "lucide-react";
import { useCollectorTypes } from "./useCollectorTypes";
import { useValueMaps } from "../valueMaps/useValueMaps";
import { SEVERITY_LABEL, SEVERITY_LEVELS } from "../shared/severity";

const CONDITION_LABEL: Record<string, string> = { gt: "büyükse", lt: "küçükse", eq: "eşitse" };

// Şablon kütüphanesi temizliği: opsiyonel item grubu isimlerinin okunur karşılığı
// (bkz. DeviceDetail.tsx'teki aynı harita -- cihazın Şablonlar sekmesinde aç/kapa edilir).
const ITEM_GROUP_LABELS: Record<string, string> = {
  services: "Windows Servisleri"
};

export function TemplateDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { data: template, isLoading } = useAlertTemplate(id!);
  const cloneTemplate = useCloneTemplate();
  const [cloning, setCloning] = useState(false);
  const [cloneName, setCloneName] = useState("");

  function handleClone() {
    if (!id || !cloneName.trim()) return;
    cloneTemplate.mutate({ templateId: id, name: cloneName.trim() }, {
      onSuccess: (data) => navigate(`/templates/${data.id}`)
    });
  }
  const { data: items, isLoading: itemsLoading } = useTemplateItems(id!);
  const { data: devices } = useTemplateDevices(id!);

  const updateTemplate = useUpdateTemplate(id!);
  const addRule = useAddTemplateRule(id!);
  const updateRule = useUpdateTemplateRule(id!);
  const deleteRule = useDeleteTemplateRule(id!);
  const setEscalationPolicy = useSetTemplateRuleEscalationPolicy(id!);
  const { data: escalationPolicies } = useEscalationPolicies();
  const createItem = useCreateTemplateItem(id!);
  const deleteItem = useDeleteTemplateItem(id!);

  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState("");

  const [showRuleForm, setShowRuleForm] = useState(false);
  const [ruleMetric, setRuleMetric] = useState("");
  const [ruleCondition, setRuleCondition] = useState<"gt" | "lt" | "eq">("gt");
  const [ruleThreshold, setRuleThreshold] = useState(0);
  const [ruleDuration, setRuleDuration] = useState(60);
  const [ruleSeverity, setRuleSeverity] = useState("warning");
  const [ruleInstanceTagKey, setRuleInstanceTagKey] = useState<string>("");
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
  const [itemIsTable, setItemIsTable] = useState(false);
  const [itemTags, setItemTags] = useState("");
  const [itemValueMapId, setItemValueMapId] = useState("");
  const [itemDiscoveryFilter, setItemDiscoveryFilter] = useState("");
  const { data: valueMaps } = useValueMaps();

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
      { metric_name: ruleMetric, condition: ruleCondition, threshold: ruleThreshold, duration_seconds: ruleDuration, severity: ruleSeverity, instance_tag_key: (ruleInstanceTagKey || null) as any },
      { onSuccess: () => { setRuleMetric(""); setRuleThreshold(0); setRuleInstanceTagKey(""); setShowRuleForm(false); } }
    );
  }

  const [editDependsOn, setEditDependsOn] = useState<string>("");
  const [editRecoveryThreshold, setEditRecoveryThreshold] = useState<string>("");
  const [editInstanceTagKey, setEditInstanceTagKey] = useState<string>("");

  function startEditRule(ruleId: string, currentThreshold: number, currentDependsOn: string | null, currentRecoveryThreshold?: number | null, currentInstanceTagKey?: string | null) {
    setEditingRuleId(ruleId);
    setEditThreshold(Number(currentThreshold)); // backend NUMERIC tipini string olarak döndürebiliyor
    setEditDependsOn(currentDependsOn || "");
    setEditRecoveryThreshold(currentRecoveryThreshold != null ? String(currentRecoveryThreshold) : "");
    setEditInstanceTagKey(currentInstanceTagKey || "");
  }
  function saveEditRule(ruleId: string) {
    updateRule.mutate(
      {
        ruleId,
        input: {
          threshold: editThreshold,
          depends_on_template_rule_id: editDependsOn || null,
          recovery_threshold: editRecoveryThreshold ? Number(editRecoveryThreshold) : null,
          instance_tag_key: (editInstanceTagKey || null) as any
        }
      },
      { onSuccess: () => setEditingRuleId(null) }
    );
  }

  function handleCreateItem(e: React.FormEvent) {
    e.preventDefault();
    const tags = itemTags.split(",").map((t) => {
      const [tag, value] = t.split(":").map((s) => s.trim());
      return tag ? { tag, value: value || "" } : null;
    }).filter(Boolean) as Array<{ tag: string; value: string }>;

    createItem.mutate(
      {
        metric_name: itemMetric,
        oid: itemCollectorType === "snmp" ? itemOid : undefined,
        data_type: "gauge",
        polling_interval_seconds: 60,
        is_table: itemIsTable,
        collector_type: itemCollectorType,
        connection_config: itemConfig, // snmp+tablo item'larında label_oid burada taşınır
        tags,
        value_map_id: itemValueMapId || undefined,
        discovery_filter_regex: itemIsTable ? (itemDiscoveryFilter || undefined) : undefined
      },
      { onSuccess: () => { setItemMetric(""); setItemOid(""); setItemConfig({}); setItemIsTable(false); setItemTags(""); setItemValueMapId(""); setItemDiscoveryFilter(""); setShowItemForm(false); } }
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
          {!template.is_protected && (
            <button onClick={startEditName} className="text-text-muted hover:text-text-accent"><Pencil size={14} /></button>
          )}
          {template.is_protected && <Lock size={14} className="text-text-muted" />}
        </div>
      )}

      {/* Şablon kütüphanesi v2: korumalı (temel) şablonlarda item/kural
          düzenleme formları/butonları gizli -- backend zaten reddediyor,
          ama kullanıcının önce klonlaması gerektiğini burada net anlatıyoruz. */}
      {template.is_protected && (
        <div className="bg-surface-1 border border-border rounded-lg px-3 py-2.5 mb-3 flex items-center justify-between gap-3 flex-wrap">
          <p className="text-xs text-text-secondary flex items-center gap-1.5">
            <Lock size={12} className="shrink-0" />
            Bu temel (korumalı) bir şablon — değiştirmek için önce kopyalayın.
          </p>
          {!cloning ? (
            <button onClick={() => { setCloning(true); setCloneName(`${template.name} (kopya)`); }} className="flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-md border border-border-strong hover:bg-surface-2 shrink-0">
              <Copy size={12} />
              Kopyala
            </button>
          ) : (
            <div className="flex items-center gap-1.5 shrink-0">
              <input value={cloneName} onChange={(e) => setCloneName(e.target.value)} className="px-2 py-1 text-xs rounded-md border border-border bg-surface-2 w-52" autoFocus />
              <button onClick={handleClone} disabled={!cloneName.trim() || cloneTemplate.isPending} className="text-xs px-2 py-1 rounded-md bg-[var(--text-accent)] text-white disabled:opacity-50">Oluştur</button>
              <button onClick={() => setCloning(false)} className="text-text-muted"><X size={14} /></button>
            </div>
          )}
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
            {!template.is_protected && (
              <button onClick={() => setShowRuleForm((v) => !v)} className="text-xs text-text-accent flex items-center gap-1"><Plus size={13} />Ekle</button>
            )}
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
                <select value={ruleInstanceTagKey} onChange={(e) => setRuleInstanceTagKey(e.target.value)} className="px-2 py-1 text-xs rounded-md border border-border bg-surface-1" title="Instance-farkında gruplama">
                  <option value="">Cihaz-seviyesi (tek alarm)</option>
                  <option value="interface">Interface bazında ayrı</option>
                  <option value="instance_label">Instance bazında ayrı (VM/vb.)</option>
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
                    {!template.is_protected && (
                      <>
                        <button onClick={() => startEditRule(r.id, r.threshold, r.depends_on_template_rule_id, r.recovery_threshold, r.instance_tag_key)} className="text-text-muted hover:text-text-accent"><Pencil size={12} /></button>
                        <button onClick={() => deleteRule.mutate(r.id)} className="text-text-muted hover:text-[var(--text-danger)]"><Trash2 size={12} /></button>
                      </>
                    )}
                  </div>
                </div>
                {editingRuleId === r.id ? (
                  <div className="flex flex-col gap-1.5 mt-1">
                    <div className="flex items-center gap-1.5">
                      <input type="number" value={editThreshold} onChange={(e) => setEditThreshold(Number(e.target.value))} placeholder="eşik" className="w-20 px-1.5 py-0.5 text-xs rounded border border-border bg-surface-1" />
                      <input type="number" value={editRecoveryThreshold} onChange={(e) => setEditRecoveryThreshold(e.target.value)} placeholder="düzelme eşiği (opsiyonel)" className="w-32 px-1.5 py-0.5 text-xs rounded border border-border bg-surface-1" />
                      <select value={editDependsOn} onChange={(e) => setEditDependsOn(e.target.value)} className="text-xs px-1.5 py-0.5 rounded border border-border bg-surface-1 w-32">
                        <option value="">Bağımlı değil</option>
                        {template.rules.filter((other) => other.id !== r.id).map((other) => (
                          <option key={other.id} value={other.id}>↳ {other.metric_name}</option>
                        ))}
                      </select>
                      <select value={editInstanceTagKey} onChange={(e) => setEditInstanceTagKey(e.target.value)} className="text-xs px-1.5 py-0.5 rounded border border-border bg-surface-1 w-40" title="Instance-farkında gruplama">
                        <option value="">Cihaz-seviyesi (tek alarm)</option>
                        <option value="interface">Interface bazında ayrı</option>
                        <option value="instance_label">Instance bazında ayrı (VM/vb.)</option>
                      </select>
                      <button onClick={() => saveEditRule(r.id)} className="text-[var(--text-success)]"><Check size={14} /></button>
                      <button onClick={() => setEditingRuleId(null)} className="text-text-muted"><X size={14} /></button>
                    </div>
                  </div>
                ) : (
                  <p className="text-xs text-text-secondary">
                    {CONDITION_LABEL[r.condition]} {r.threshold} · {r.duration_seconds}s · {SEVERITY_LABEL[r.severity] ?? r.severity}
                    {r.instance_tag_key && (
                      <span className="ml-1.5 px-1.5 py-0.5 rounded-full bg-surface-1 border border-border text-[10px] text-text-accent">
                        {r.instance_tag_key === "interface" ? "Interface bazında" : "Instance bazında"}
                      </span>
                    )}
                  </p>
                )}
                {r.depends_on_metric_name && <p className="text-xs text-text-muted mt-1">↳ bağımlı: {r.depends_on_metric_name}</p>}
                <div className="flex items-center gap-1.5 mt-1.5">
                  <span className="text-[10px] text-text-muted">Eskalasyon:</span>
                  <select
                    value={r.escalation_policy_id || ""}
                    onChange={(e) => setEscalationPolicy.mutate({ ruleId: r.id, policyId: e.target.value || null })}
                    className="px-1.5 py-0.5 text-[11px] rounded border border-border bg-surface-1"
                  >
                    <option value="">Yok</option>
                    {escalationPolicies?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                </div>
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
            {!template.is_protected && (
              <button onClick={() => setShowItemForm((v) => !v)} className="text-xs text-text-accent flex items-center gap-1"><Plus size={13} />Ekle</button>
            )}
          </div>

          {showItemForm && (
            <form onSubmit={handleCreateItem} className="bg-surface-2 border border-border rounded-lg p-2.5 mb-2 flex flex-col gap-1.5">
              <input value={itemMetric} onChange={(e) => setItemMetric(e.target.value)} placeholder="metric_name" required className="px-2 py-1 text-xs rounded-md border border-border bg-surface-1" />

              <select value={itemCollectorType} onChange={(e) => { setItemCollectorType(e.target.value); setItemConfig({}); }} className="px-2 py-1 text-xs rounded-md border border-border bg-surface-1">
                {collectorTypes?.map((c) => <option key={c.key} value={c.key}>{c.display_name}</option>)}
              </select>

              {itemCollectorType === "snmp" && (
                <>
                  <input value={itemOid} onChange={(e) => setItemOid(e.target.value)} placeholder="OID" required className="px-2 py-1 text-xs rounded-md border border-border bg-surface-1 font-mono" />
                  <label className="flex items-center gap-1.5 text-xs">
                    <input type="checkbox" checked={itemIsTable} onChange={(e) => setItemIsTable(e.target.checked)} />
                    Tablo item'ı (walk) — birden fazla satır üretir (örn. tüm interface'ler)
                  </label>
                  {itemIsTable && (
                    <>
                      <input value={itemConfig.label_oid || ""} onChange={(e) => updateConfigField("label_oid", e.target.value)} placeholder="Etiket OID'i (opsiyonel, örn. ifDescr)" className="px-2 py-1 text-xs rounded-md border border-border bg-surface-1 font-mono" />
                      <input value={itemDiscoveryFilter} onChange={(e) => setItemDiscoveryFilter(e.target.value)} placeholder="Filtre regex (opsiyonel, örn. hariç tutmak için)" className="px-2 py-1 text-xs rounded-md border border-border bg-surface-1 font-mono" />
                    </>
                  )}
                </>
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

              {itemCollectorType === "cert_expiry" && (
                <>
                  <input type="number" value={itemConfig.port || ""} onChange={(e) => updateConfigField("port", e.target.value)} placeholder="Port (varsayılan 443)" className="px-2 py-1 text-xs rounded-md border border-border bg-surface-1" />
                  <input value={itemConfig.servername || ""} onChange={(e) => updateConfigField("servername", e.target.value)} placeholder="SNI hostname (opsiyonel, örn. example.com)" className="px-2 py-1 text-xs rounded-md border border-border bg-surface-1" />
                  <p className="text-[10px] text-text-muted">Hedef, bu şablonun uygulandığı cihazın IP'sidir. Metrik = sertifikanın kalan gün sayısı (bitmişse negatif). Ayrıca &lt;metrik&gt;_reachable (1/0) metriği de üretilir; TLS erişilemezse 0 olur.</p>
                </>
              )}

              {itemCollectorType === "dns" && (
                <>
                  <input value={itemConfig.query_name || ""} onChange={(e) => updateConfigField("query_name", e.target.value)} placeholder="Sorulacak ad (örn. example.com)" required className="px-2 py-1 text-xs rounded-md border border-border bg-surface-1" />
                  <select value={itemConfig.record_type || "A"} onChange={(e) => updateConfigField("record_type", e.target.value)} className="px-2 py-1 text-xs rounded-md border border-border bg-surface-1">
                    {["A", "AAAA", "CNAME", "MX", "TXT", "NS", "SOA", "SRV"].map((t) => <option key={t} value={t}>{t}</option>)}
                  </select>
                  <input type="number" value={itemConfig.port || ""} onChange={(e) => updateConfigField("port", e.target.value)} placeholder="Port (varsayılan 53)" className="px-2 py-1 text-xs rounded-md border border-border bg-surface-1" />
                  <input value={itemConfig.expected || ""} onChange={(e) => updateConfigField("expected", e.target.value)} placeholder="Beklenen yanıt (opsiyonel, alt-dize)" className="px-2 py-1 text-xs rounded-md border border-border bg-surface-1" />
                  <p className="text-[10px] text-text-muted">Hedef, bu şablonun uygulandığı cihazın IP'sidir (DNS sunucusu olarak sorgulanır). Metrik = çözünürlük süresi (ms). Ayrıca &lt;metrik&gt;_reachable (1/0) üretilir; sorgu başarısız ya da beklenen yanıt yoksa 0 olur.</p>
                </>
              )}

              {itemCollectorType === "mongodb" && (
                <>
                  <input value={itemConfig.field || ""} onChange={(e) => updateConfigField("field", e.target.value)} placeholder="Alan (örn. connections.current, repl_lag, reachable)" required className="px-2 py-1 text-xs rounded-md border border-border bg-surface-1" />
                  <p className="text-[10px] text-text-muted">serverStatus alan yolu ya da özel seçici (reachable / repl_lag / repl_state). Kimlik bilgileri cihaz makrolarından ({"{$MONGO_USER}"}/{"{$MONGO_PASSWORD}"}/{"{$MONGO_PORT}"}). Hazır "MongoDB (fan-out)" şablonunu seed script ile kurabilirsiniz; genelde elle item eklemeye gerek yoktur.</p>
                </>
              )}

              {itemCollectorType === "kafka" && (
                <>
                  <input value={itemConfig.field || ""} onChange={(e) => updateConfigField("field", e.target.value)} placeholder="Alan (örn. broker_count, offline_partitions, consumer_lag, reachable)" required className="px-2 py-1 text-xs rounded-md border border-border bg-surface-1" />
                  <input value={itemConfig.group || ""} onChange={(e) => updateConfigField("group", e.target.value)} placeholder="Consumer group (yalnızca consumer_lag için)" className="px-2 py-1 text-xs rounded-md border border-border bg-surface-1" />
                  <input value={itemConfig.topic || ""} onChange={(e) => updateConfigField("topic", e.target.value)} placeholder="Topic (opsiyonel, lag'i tek topic'e daralt)" className="px-2 py-1 text-xs rounded-md border border-border bg-surface-1" />
                  <p className="text-[10px] text-text-muted">Küresel metrikler için sadece "field". consumer_lag için field=consumer_lag + group (topic opsiyonel). Kimlik cihaz makrolarından ({"{$KAFKA_USER}"}/{"{$KAFKA_PASSWORD}"}/{"{$KAFKA_PORT}"}). Hazır "Kafka (fan-out)" şablonunu seed script ile kurabilirsiniz.</p>
                </>
              )}

              {itemCollectorType === "rabbitmq" && (
                <>
                  <input value={itemConfig.field || ""} onChange={(e) => updateConfigField("field", e.target.value)} placeholder="Alan (örn. messages_ready, disk_alarm, queue_messages, reachable)" required className="px-2 py-1 text-xs rounded-md border border-border bg-surface-1" />
                  <input value={itemConfig.queue || ""} onChange={(e) => updateConfigField("queue", e.target.value)} placeholder="Kuyruk adı (yalnızca queue_messages için)" className="px-2 py-1 text-xs rounded-md border border-border bg-surface-1" />
                  <input value={itemConfig.vhost || ""} onChange={(e) => updateConfigField("vhost", e.target.value)} placeholder="vhost (opsiyonel, varsayılan /)" className="px-2 py-1 text-xs rounded-md border border-border bg-surface-1" />
                  <p className="text-[10px] text-text-muted">Küresel metrikler için sadece "field". queue_messages için field=queue_messages + queue (vhost opsiyonel). Management HTTP API (port {"{$RABBITMQ_MGMT_PORT}"}|15672), basic auth {"{$RABBITMQ_USER}"}/{"{$RABBITMQ_PASSWORD}"}. Hazır "RabbitMQ (fan-out)" şablonunu seed script ile kurabilirsiniz.</p>
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

              {itemCollectorType === "agent" && (
                <>
                  <select
                    value={itemConfig.plugin || ""}
                    onChange={(e) => setItemConfig({ plugin: e.target.value })}
                    className="px-2 py-1 text-xs rounded-md border border-border bg-surface-1"
                  >
                    <option value="">Plugin yok (agent'ın temel metrikleri: cpu_util, memory_used_percent, system_uptime)</option>
                    <option value="docker">Docker</option>
                    <option value="postgres">PostgreSQL</option>
                    <option value="redis">Redis</option>
                    <option value="perfcounter">Windows Performance Counter</option>
                    <option value="wmi">WMI</option>
                  </select>

                  {itemConfig.plugin === "docker" && (
                    <>
                      <select value={itemConfig.action || ""} onChange={(e) => updateConfigField("action", e.target.value)} required className="px-2 py-1 text-xs rounded-md border border-border bg-surface-1">
                        <option value="">Action seç</option>
                        <option value="ping">ping</option>
                        <option value="container_count">container_count</option>
                        <option value="image_count">image_count</option>
                      </select>
                      {itemConfig.action === "container_count" && (
                        <select value={itemConfig.state || "running"} onChange={(e) => updateConfigField("state", e.target.value)} className="px-2 py-1 text-xs rounded-md border border-border bg-surface-1">
                          <option value="running">Sadece çalışanlar</option>
                          <option value="all">Tümü</option>
                        </select>
                      )}
                    </>
                  )}

                  {itemConfig.plugin === "postgres" && (
                    <select value={itemConfig.action || ""} onChange={(e) => updateConfigField("action", e.target.value)} required className="px-2 py-1 text-xs rounded-md border border-border bg-surface-1">
                      <option value="">Action seç</option>
                      <option value="ping">ping</option>
                      <option value="connections">connections</option>
                      <option value="uptime">uptime</option>
                      <option value="locks">locks</option>
                    </select>
                  )}

                  {itemConfig.plugin === "redis" && (
                    <select value={itemConfig.action || ""} onChange={(e) => updateConfigField("action", e.target.value)} required className="px-2 py-1 text-xs rounded-md border border-border bg-surface-1">
                      <option value="">Action seç</option>
                      <option value="ping">ping</option>
                      <option value="connected_clients">connected_clients</option>
                      <option value="used_memory">used_memory</option>
                      <option value="uptime_in_seconds">uptime_in_seconds</option>
                      <option value="slowlog_count">slowlog_count</option>
                    </select>
                  )}

                  {itemConfig.plugin === "perfcounter" && (
                    <input
                      value={itemConfig.path || ""}
                      onChange={(e) => updateConfigField("path", e.target.value)}
                      placeholder={String.raw`PDH counter path (örn. \Processor(_Total)\% Processor Time)`}
                      required
                      className="px-2 py-1 text-xs rounded-md border border-border bg-surface-1 font-mono"
                    />
                  )}

                  {itemConfig.plugin === "wmi" && !itemIsTable && (
                    <input
                      value={itemConfig.query || ""}
                      onChange={(e) => updateConfigField("query", e.target.value)}
                      placeholder='WQL sorgusu, sonuç "AS Value" ile adlandırılmalı'
                      required
                      className="px-2 py-1 text-xs rounded-md border border-border bg-surface-1 font-mono"
                    />
                  )}

                  {/* Şablon kütüphanesi v2: WMI tarafında da SNMP'deki gibi is_table
                      (çoklu-sonuç/keşif) desteği -- örn. "Windows by Zabbix agent"
                      şablonundaki windows_service_running item'ı burada yeniden
                      oluşturulabilir/kopyalanabilir hale geldi. */}
                  {itemConfig.plugin === "wmi" && (
                    <label className="flex items-center gap-1.5 text-xs">
                      <input type="checkbox" checked={itemIsTable} onChange={(e) => { setItemIsTable(e.target.checked); if (e.target.checked) updateConfigField("action", itemConfig.action || "service_state"); }} />
                      Çoklu-sonuç (keşif) — örn. tüm Windows servislerini keşfet
                    </label>
                  )}

                  {itemConfig.plugin === "wmi" && itemIsTable && (
                    <>
                      <select value={itemConfig.action || "service_state"} onChange={(e) => updateConfigField("action", e.target.value)} className="px-2 py-1 text-xs rounded-md border border-border bg-surface-1">
                        <option value="service_state">service_state — tüm Windows servisleri (Running=1/diğer=0)</option>
                      </select>
                      <input
                        value={itemConfig.name_pattern || ""}
                        onChange={(e) => updateConfigField("name_pattern", e.target.value)}
                        placeholder='WQL LIKE deseni (opsiyonel, örn. "MSSQL%") — boşsa TÜM servisler'
                        className="px-2 py-1 text-xs rounded-md border border-border bg-surface-1 font-mono"
                      />
                      <input
                        value={itemDiscoveryFilter}
                        onChange={(e) => setItemDiscoveryFilter(e.target.value)}
                        placeholder='Filtre regex (opsiyonel, hariç tutmak için örn. "^(?!Update).*$")'
                        className="px-2 py-1 text-xs rounded-md border border-border bg-surface-1 font-mono"
                      />
                    </>
                  )}

                  {!itemConfig.plugin && (
                    <p className="text-[10px] text-text-muted">
                      Docker/PostgreSQL/Redis'in bağlantı ayarları (endpoint/URI/adres), bu şablonun uygulandığı her cihazın kendi "Agent" sekmesinden yapılır.
                    </p>
                  )}
                </>
              )}

              {selectedCollector && (
                <p className="text-[10px] text-text-muted">{selectedCollector.handler_service} tarafından işlenir</p>
              )}

              <input value={itemTags} onChange={(e) => setItemTags(e.target.value)} placeholder="Etiketler (örn. component:network, scope:availability)" className="px-2 py-1 text-xs rounded-md border border-border bg-surface-1" />
              <select value={itemValueMapId} onChange={(e) => setItemValueMapId(e.target.value)} className="px-2 py-1 text-xs rounded-md border border-border bg-surface-1">
                <option value="">Value Map yok</option>
                {valueMaps?.map((vm) => <option key={vm.id} value={vm.id}>{vm.name}</option>)}
              </select>
              <button type="submit" className="px-2.5 py-1 text-xs rounded-md bg-[var(--text-accent)] text-white">Ekle</button>
            </form>
          )}

          {itemsLoading && <p className="text-sm text-text-secondary">Yükleniyor...</p>}

          <div className="border border-border rounded-xl overflow-hidden">
            {items?.map((item) => (
              <div key={item.id} className="flex items-center gap-3 px-4 py-2.5 border-b border-border last:border-0">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <p className="text-sm font-medium">{item.metric_name}</p>
                    {item.is_table && <span className="text-[10px] px-1.5 py-0.5 rounded bg-surface-2 text-text-muted">tablo</span>}
                    {item.value_map_name && <span className="text-[10px] px-1.5 py-0.5 rounded bg-surface-2 text-text-muted">🏷 {item.value_map_name}</span>}
                    {item.item_group && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--bg-accent)] text-[var(--text-accent)]" title="Bu item opsiyonel bir grubun parçası -- cihaz bazında aç/kapa edilir (bkz. cihazın Şablonlar sekmesi)">
                        ⚙ opsiyonel: {ITEM_GROUP_LABELS[item.item_group] ?? item.item_group}
                      </span>
                    )}
                    {(item.tags ?? []).map((t, i) => (
                      <span key={i} className="text-[10px] px-1.5 py-0.5 rounded bg-surface-2 text-text-muted">{t.tag}:{t.value}</span>
                    ))}
                  </div>
                  <p className="text-xs text-text-muted font-mono truncate">
                    {item.oid || (item.formula ? `formül: ${item.formula}` : JSON.stringify(item.connection_config))}
                  </p>
                </div>
                <span className="text-[11px] px-2 py-0.5 rounded-full bg-surface-1 border border-border text-text-secondary shrink-0">
                  {collectorTypes?.find((c) => c.key === item.collector_type)?.display_name ?? item.collector_type}
                </span>
                {!template.is_protected && (
                  <button onClick={() => deleteItem.mutate(item.id)} className="text-text-muted hover:text-[var(--text-danger)] shrink-0"><Trash2 size={13} /></button>
                )}
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
