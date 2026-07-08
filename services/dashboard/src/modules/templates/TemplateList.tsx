import { useState } from "react";
import { Plus, Trash2, LayoutTemplate, X } from "lucide-react";
import { useAlertTemplates, useCreateAlertTemplate, useDeleteAlertTemplate, useApplyTemplate } from "./useAlertTemplates";
import { useDeviceGroups } from "../deviceGroups/useDeviceGroups";
import { SEVERITY_LEVELS, SEVERITY_LABEL } from "../shared/severity";
import type { TemplateRuleInput } from "../../api/alertTemplates";

export function TemplateList() {
  const { data: templates, isLoading } = useAlertTemplates();
  const { data: groups } = useDeviceGroups();
  const createTemplate = useCreateAlertTemplate();
  const deleteTemplate = useDeleteAlertTemplate();
  const applyTemplate = useApplyTemplate();

  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState("");
  const [rules, setRules] = useState<TemplateRuleInput[]>([
    { metric_name: "", condition: "gt", threshold: 0, duration_seconds: 60, severity: "warning" }
  ]);

  const [applyingTemplateId, setApplyingTemplateId] = useState<string | null>(null);
  const [selectedGroupId, setSelectedGroupId] = useState("");
  const [applyResult, setApplyResult] = useState<string | null>(null);

  function addRule() {
    setRules([...rules, { metric_name: "", condition: "gt", threshold: 0, duration_seconds: 60, severity: "warning" }]);
  }

  function updateRule(index: number, patch: Partial<TemplateRuleInput>) {
    setRules(rules.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  }

  function removeRule(index: number) {
    setRules(rules.filter((_, i) => i !== index));
  }

  function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    createTemplate.mutate(
      { name, rules },
      {
        onSuccess: () => {
          setName("");
          setRules([{ metric_name: "", condition: "gt", threshold: 0, duration_seconds: 60, severity: "warning" }]);
          setShowForm(false);
        }
      }
    );
  }

  function handleApply(templateId: string) {
    if (!selectedGroupId) return;
    applyTemplate.mutate(
      { templateId, deviceGroupId: selectedGroupId },
      {
        onSuccess: (data) => {
          setApplyResult(`${data.appliedToDevices} cihaza uygulandı, ${data.rulesCreated} kural oluşturuldu.`);
          setApplyingTemplateId(null);
          setSelectedGroupId("");
        }
      }
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-lg font-medium">Şablonlar</h1>
          <p className="text-sm text-text-secondary">Bir kural setini birden fazla cihaza toplu uygula</p>
        </div>
        <button onClick={() => setShowForm((v) => !v)} className="flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-md border border-border-strong hover:bg-surface-1">
          <Plus size={15} />
          Şablon oluştur
        </button>
      </div>

      {applyResult && (
        <div className="text-sm bg-[var(--bg-success)] text-[var(--text-success)] p-2.5 rounded-md mb-4 flex items-center justify-between">
          {applyResult}
          <button onClick={() => setApplyResult(null)}><X size={14} /></button>
        </div>
      )}

      {showForm && (
        <form onSubmit={handleCreate} className="bg-surface-2 border border-border rounded-xl p-4 mb-4">
          <div className="mb-3">
            <label className="text-xs text-text-secondary mb-1 block">Şablon adı</label>
            <input value={name} onChange={(e) => setName(e.target.value)} required className="px-2.5 py-1.5 text-sm rounded-md border border-border bg-surface-1 w-64" placeholder="Standard Server Template" />
          </div>

          <p className="text-xs text-text-secondary mb-2">Kurallar</p>
          {rules.map((rule, i) => (
            <div key={i} className="flex items-end gap-2 mb-2">
              <input value={rule.metric_name} onChange={(e) => updateRule(i, { metric_name: e.target.value })} placeholder="metric_name" className="px-2 py-1.5 text-sm rounded-md border border-border bg-surface-1 w-40" required />
              <select value={rule.condition} onChange={(e) => updateRule(i, { condition: e.target.value as "gt" | "lt" | "eq" })} className="px-2 py-1.5 text-sm rounded-md border border-border bg-surface-1">
                <option value="gt">&gt;</option>
                <option value="lt">&lt;</option>
                <option value="eq">=</option>
              </select>
              <input type="number" value={rule.threshold} onChange={(e) => updateRule(i, { threshold: Number(e.target.value) })} className="px-2 py-1.5 text-sm rounded-md border border-border bg-surface-1 w-20" />
              <input type="number" value={rule.duration_seconds} onChange={(e) => updateRule(i, { duration_seconds: Number(e.target.value) })} className="px-2 py-1.5 text-sm rounded-md border border-border bg-surface-1 w-20" title="süre (sn)" />
              <select value={rule.severity} onChange={(e) => updateRule(i, { severity: e.target.value })} className="px-2 py-1.5 text-sm rounded-md border border-border bg-surface-1">
                {SEVERITY_LEVELS.map((s) => <option key={s} value={s}>{SEVERITY_LABEL[s]}</option>)}
              </select>
              {rules.length > 1 && (
                <button type="button" onClick={() => removeRule(i)} className="text-text-muted hover:text-[var(--text-danger)]">
                  <Trash2 size={14} />
                </button>
              )}
            </div>
          ))}
          <button type="button" onClick={addRule} className="text-xs text-text-accent mb-3">+ Kural ekle</button>

          <button type="submit" disabled={createTemplate.isPending} className="block px-3 py-1.5 text-sm rounded-md bg-[var(--text-accent)] text-white">
            Şablonu kaydet
          </button>
        </form>
      )}

      {isLoading && <p className="text-sm text-text-secondary">Yükleniyor...</p>}

      <div className="border border-border rounded-xl overflow-hidden">
        {templates?.map((t) => (
          <div key={t.id} className="px-4 py-3 border-b border-border last:border-0">
            <div className="flex items-center gap-3">
              <LayoutTemplate size={16} className="text-text-secondary shrink-0" />
              <div className="flex-1">
                <p className="text-sm font-medium">{t.name}</p>
                <p className="text-xs text-text-muted">{t.rule_count} kural</p>
              </div>
              <button
                onClick={() => setApplyingTemplateId(applyingTemplateId === t.id ? null : t.id)}
                className="text-xs px-2.5 py-1.5 rounded-md border border-border-strong hover:bg-surface-1"
              >
                Gruba uygula
              </button>
              <button onClick={() => deleteTemplate.mutate(t.id)} className="text-text-muted hover:text-[var(--text-danger)]">
                <Trash2 size={14} />
              </button>
            </div>

            {applyingTemplateId === t.id && (
              <div className="flex items-center gap-2 mt-3 pl-7">
                <select value={selectedGroupId} onChange={(e) => setSelectedGroupId(e.target.value)} className="px-2.5 py-1.5 text-sm rounded-md border border-border bg-surface-1 w-56">
                  <option value="">Host grubu seç</option>
                  {groups?.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
                </select>
                <button onClick={() => handleApply(t.id)} disabled={!selectedGroupId || applyTemplate.isPending} className="text-xs px-3 py-1.5 rounded-md bg-[var(--text-accent)] text-white disabled:opacity-50">
                  Uygula
                </button>
              </div>
            )}
          </div>
        ))}
        {templates?.length === 0 && <p className="text-sm text-text-muted p-4">Henüz şablon oluşturulmadı.</p>}
      </div>
    </div>
  );
}
