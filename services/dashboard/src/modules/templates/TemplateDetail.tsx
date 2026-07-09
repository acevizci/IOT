import { useState } from "react";
import { useParams, Link } from "react-router-dom";
import { ArrowLeft, Plus, Trash2, Pencil, Check, X } from "lucide-react";
import {
  useAlertTemplate, useTemplateDevices, useUpdateTemplate,
  useAddTemplateRule, useUpdateTemplateRule, useDeleteTemplateRule
} from "./useAlertTemplates";
import { useTemplateItems, useCreateTemplateItem, useDeleteTemplateItem, useUpdateTemplateItem } from "./useTemplateItems";
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

  const [showItemForm, setShowItemForm] = useState(false);
  const [itemMetric, setItemMetric] = useState("");
  const [itemOid, setItemOid] = useState("");

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

  function startEditRule(ruleId: string, currentThreshold: number) {
    setEditingRuleId(ruleId);
    setEditThreshold(currentThreshold);
  }
  function saveEditRule(ruleId: string) {
    updateRule.mutate({ ruleId, input: { threshold: editThreshold } }, { onSuccess: () => setEditingRuleId(null) });
  }

  function handleCreateItem(e: React.FormEvent) {
    e.preventDefault();
    createItem.mutate(
      { metric_name: itemMetric, oid: itemOid, data_type: "gauge", polling_interval_seconds: 60, is_table: false },
      { onSuccess: () => { setItemMetric(""); setItemOid(""); setShowItemForm(false); } }
    );
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

      <div className="grid grid-cols-2 gap-4 mb-4">
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
                    <button onClick={() => startEditRule(r.id, r.threshold)} className="text-text-muted hover:text-text-accent"><Pencil size={12} /></button>
                    <button onClick={() => deleteRule.mutate(r.id)} className="text-text-muted hover:text-[var(--text-danger)]"><Trash2 size={12} /></button>
                  </div>
                </div>
                {editingRuleId === r.id ? (
                  <div className="flex items-center gap-1.5 mt-1">
                    <input type="number" value={editThreshold} onChange={(e) => setEditThreshold(Number(e.target.value))} className="w-20 px-1.5 py-0.5 text-xs rounded border border-border bg-surface-1" />
                    <button onClick={() => saveEditRule(r.id)} className="text-[var(--text-success)]"><Check size={14} /></button>
                    <button onClick={() => setEditingRuleId(null)} className="text-text-muted"><X size={14} /></button>
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

        <div>
          <div className="flex items-center justify-between mb-2">
            <p className="text-sm font-medium">Metrik tanımları (Items)</p>
            <button onClick={() => setShowItemForm((v) => !v)} className="text-xs text-text-accent flex items-center gap-1"><Plus size={13} />Ekle</button>
          </div>

          {showItemForm && (
            <form onSubmit={handleCreateItem} className="bg-surface-2 border border-border rounded-lg p-2.5 mb-2 flex flex-col gap-1.5">
              <input value={itemMetric} onChange={(e) => setItemMetric(e.target.value)} placeholder="metric_name" required className="px-2 py-1 text-xs rounded-md border border-border bg-surface-1" />
              <input value={itemOid} onChange={(e) => setItemOid(e.target.value)} placeholder="OID" required className="px-2 py-1 text-xs rounded-md border border-border bg-surface-1 font-mono" />
              <button type="submit" className="px-2.5 py-1 text-xs rounded-md bg-[var(--text-accent)] text-white">Ekle</button>
            </form>
          )}

          {itemsLoading && <p className="text-sm text-text-secondary">Yükleniyor...</p>}

          <div className="border border-border rounded-xl overflow-hidden">
            {items?.map((item) => (
              <div key={item.id} className="flex items-center gap-3 px-4 py-2.5 border-b border-border last:border-0">
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium">{item.metric_name}</p>
                  <p className="text-xs text-text-muted font-mono truncate">{item.oid || `formül: ${item.formula}`}</p>
                </div>
                <span className="text-xs text-text-secondary shrink-0">{item.data_type}</span>
                <button onClick={() => deleteItem.mutate(item.id)} className="text-text-muted hover:text-[var(--text-danger)] shrink-0"><Trash2 size={13} /></button>
              </div>
            ))}
            {items?.length === 0 && <p className="text-sm text-text-muted p-4">Henüz özel metrik tanımlanmadı.</p>}
          </div>
        </div>
      </div>

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
