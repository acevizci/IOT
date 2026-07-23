import { useState, useRef } from "react";
import { Link } from "react-router-dom";
import { Plus, Trash2, Search, Lock, Copy, Download, Upload } from "lucide-react";
import {
  useAlertTemplates, useCreateAlertTemplate, useDeleteAlertTemplate, useApplyTemplate, useAlertTemplateTags,
  useCloneTemplate, useExportTemplate, useImportTemplate
} from "./useAlertTemplates";
import { useDeviceGroups } from "../deviceGroups/useDeviceGroups";
import { SEVERITY_LEVELS, SEVERITY_LABEL } from "../shared/severity";
import type { TemplateRuleInput } from "../../api/alertTemplates";
import { DeviceSectionTabs } from "../devices/DeviceSectionTabs";

export function TemplateList() {
  const [search, setSearch] = useState("");
  const [tagFilter, setTagFilter] = useState("");
  const { data: templates, isLoading } = useAlertTemplates({ search: search || undefined, tag: tagFilter || undefined });
  const { data: allTags } = useAlertTemplateTags();
  const { data: groups } = useDeviceGroups();
  const { data: allTemplatesForLinking } = useAlertTemplates();

  const createTemplate = useCreateAlertTemplate();
  const deleteTemplate = useDeleteAlertTemplate();
  const applyTemplate = useApplyTemplate();
  const cloneTemplate = useCloneTemplate();
  const exportTemplate = useExportTemplate();
  const importTemplate = useImportTemplate();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [importError, setImportError] = useState<string | null>(null);

  const [cloningTemplateId, setCloningTemplateId] = useState<string | null>(null);
  const [cloneName, setCloneName] = useState("");

  // Şablon kütüphanesi v2: dosya seçilince önce şablon adını sorup sonra import
  // ediyoruz -- aynı isimde bir şablon zaten varsa arka planda 409 yerine kullanıcı
  // farklı bir isim seçebilsin diye basit bir prompt() yeterli (ayrı bir modal'a gerek yok).
  function handleFileSelected(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setImportError(null);
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result as string);
        const defaultName = data.template?.name ? `${data.template.name} (içe aktarıldı)` : "İçe aktarılan şablon";
        const name = window.prompt("Yeni şablonun adı:", defaultName);
        if (!name) return;
        importTemplate.mutate({ name, data }, {
          onError: (err) => setImportError(err instanceof Error ? err.message : "İçe aktarma başarısız")
        });
      } catch {
        setImportError("Geçersiz JSON dosyası");
      }
    };
    reader.readAsText(file);
  }

  function startClone(t: { id: string; name: string }) {
    setCloningTemplateId(t.id);
    setCloneName(`${t.name} (kopya)`);
  }

  function handleClone() {
    if (!cloningTemplateId || !cloneName.trim()) return;
    cloneTemplate.mutate({ templateId: cloningTemplateId, name: cloneName.trim() }, { onSuccess: () => setCloningTemplateId(null) });
  }

  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState("");
  const [tagsInput, setTagsInput] = useState("");
  const [parentTemplateId, setParentTemplateId] = useState("");
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
    const tags = tagsInput.split(",").map((t) => t.trim()).filter(Boolean);
    createTemplate.mutate(
      { name, tags: tags.length ? tags : undefined, parent_template_id: parentTemplateId || null, rules },
      {
        onSuccess: () => {
          setName(""); setTagsInput(""); setParentTemplateId("");
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
      <DeviceSectionTabs />
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-lg font-medium">Şablonlar</h1>
          <p className="text-sm text-text-secondary">Bir kural ve metrik setini birden fazla cihaza toplu uygula</p>
        </div>
        <div className="flex items-center gap-2">
          <input ref={fileInputRef} type="file" accept="application/json" onChange={handleFileSelected} className="hidden" />
          <button onClick={() => fileInputRef.current?.click()} title="Bir JSON şablon dosyasını içe aktar" className="flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-md border border-border-strong hover:bg-surface-1">
            <Upload size={15} />
            İçe aktar
          </button>
          <button onClick={() => setShowForm((v) => !v)} className="flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-md border border-border-strong hover:bg-surface-1">
            <Plus size={15} />
            Şablon oluştur
          </button>
        </div>
      </div>

      {importError && (
        <div className="text-sm bg-[var(--bg-danger)] text-[var(--text-danger)] p-2.5 rounded-md mb-4">{importError}</div>
      )}

      <div className="flex items-center gap-2 mb-4">
        <div className="flex items-center gap-2 px-3 py-2 rounded-md border border-border max-w-xs w-full">
          <Search size={15} className="text-text-muted shrink-0" />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="İsimle ara..." className="text-sm bg-transparent outline-none w-full" />
        </div>
        {allTags && allTags.length > 0 && (
          <select value={tagFilter} onChange={(e) => setTagFilter(e.target.value)} className="text-sm px-3 py-2 rounded-md border border-border bg-surface-1">
            <option value="">Etiket: tümü</option>
            {allTags.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        )}
      </div>

      {applyResult && (
        <div className="text-sm bg-[var(--bg-success)] text-[var(--text-success)] p-2.5 rounded-md mb-4">{applyResult}</div>
      )}

      {showForm && (
        <form onSubmit={handleCreate} className="bg-surface-2 border border-border rounded-xl p-4 mb-4">
          <div className="flex items-end gap-3 mb-3 flex-wrap">
            <div>
              <label className="text-xs text-text-secondary mb-1 block">Şablon adı</label>
              <input value={name} onChange={(e) => setName(e.target.value)} required className="px-2.5 py-1.5 text-sm rounded-md border border-border bg-surface-1 w-56" placeholder="Standard Server Template" />
            </div>
            <div>
              <label className="text-xs text-text-secondary mb-1 block">Etiketler (virgülle ayır)</label>
              <input value={tagsInput} onChange={(e) => setTagsInput(e.target.value)} className="px-2.5 py-1.5 text-sm rounded-md border border-border bg-surface-1 w-56" placeholder="class:network, target:cisco" />
            </div>
            <div>
              <label className="text-xs text-text-secondary mb-1 block">Miras alınan şablon (opsiyonel)</label>
              <select value={parentTemplateId} onChange={(e) => setParentTemplateId(e.target.value)} className="px-2.5 py-1.5 text-sm rounded-md border border-border bg-surface-1 w-56">
                <option value="">Yok</option>
                {allTemplatesForLinking?.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </div>
          </div>

          <p className="text-xs text-text-secondary mb-2">Kurallar</p>
          {rules.map((rule, i) => (
            <div key={i} className="flex items-end gap-2 mb-2">
              <input value={rule.metric_name} onChange={(e) => updateRule(i, { metric_name: e.target.value })} placeholder="metric_name" className="px-2 py-1.5 text-sm rounded-md border border-border bg-surface-1 w-36" required />
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
              <select
                value={rule.depends_on_index ?? ""}
                onChange={(e) => updateRule(i, { depends_on_index: e.target.value === "" ? null : Number(e.target.value) })}
                className="px-2 py-1.5 text-sm rounded-md border border-border bg-surface-1 w-32"
                title="Bağımlı olduğu kural"
              >
                <option value="">Bağımlı değil</option>
                {rules.map((r, j) => j !== i && r.metric_name ? (
                  <option key={j} value={j}>↳ {r.metric_name}</option>
                ) : null)}
              </select>
              {rules.length > 1 && (
                <button type="button" onClick={() => removeRule(i)} className="text-text-muted hover:text-[var(--text-danger)]"><Trash2 size={14} /></button>
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
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-surface-1 text-text-secondary text-left">
              <th className="p-3 font-medium">Ad</th>
              <th className="p-3 font-medium text-center">Cihazlar</th>
              <th className="p-3 font-medium text-center">Items</th>
              <th className="p-3 font-medium text-center">Kurallar</th>
              <th className="p-3 font-medium text-center">Web Sen.</th>
              <th className="p-3 font-medium">Miras alınan</th>
              <th className="p-3 font-medium">Etiketler</th>
              <th className="p-3 font-medium w-32"></th>
            </tr>
          </thead>
          <tbody>
            {templates?.map((t) => (
              <tr key={t.id} className="border-t border-border">
                <td className="p-0">
                  <Link to={`/templates/${t.id}`} className="flex items-center gap-1.5 p-3 font-medium text-text-accent">
                    {t.is_protected && (
                      <span title="Temel (korumalı) şablon -- değiştirmek için önce kopyalayın">
                        <Lock size={11} className="text-text-muted shrink-0" />
                      </span>
                    )}
                    {t.name}
                  </Link>
                </td>
                <td className="p-3 text-center">
                  {(t.device_count ?? 0) > 0 ? (
                    <Link to={`/templates/${t.id}`} className="text-text-accent">{t.device_count}</Link>
                  ) : (
                    <span className="text-text-muted">0</span>
                  )}
                </td>
                <td className="p-3 text-center text-text-secondary">{t.item_count ?? 0}</td>
                <td className="p-3 text-center text-text-secondary">{t.rule_count ?? 0}</td>
                <td className="p-3 text-center text-text-secondary">{t.web_scenario_count ?? 0}</td>
                <td className="p-3">
                  {t.parent_template_name ? (
                    <Link to={`/templates/${t.parent_template_id}`} className="text-xs text-text-accent">{t.parent_template_name}</Link>
                  ) : (
                    <span className="text-xs text-text-muted">-</span>
                  )}
                </td>
                <td className="p-3">
                  <div className="flex gap-1 flex-wrap">
                    {(t.tags ?? []).map((tag) => (
                      <span key={tag} className="text-[11px] px-1.5 py-0.5 rounded bg-surface-2 text-text-secondary border border-border">{tag}</span>
                    ))}
                  </div>
                </td>
                <td className="p-3">
                  <div className="flex items-center gap-2 justify-end">
                    <button onClick={() => setApplyingTemplateId(applyingTemplateId === t.id ? null : t.id)} className="text-xs px-2 py-1 rounded-md border border-border-strong hover:bg-surface-1">
                      Uygula
                    </button>
                    <button onClick={() => startClone(t)} title="Kopyala" className="text-text-muted hover:text-text-accent"><Copy size={14} /></button>
                    <button onClick={() => exportTemplate.mutate(t.id)} title="JSON olarak dışa aktar" className="text-text-muted hover:text-text-accent"><Download size={14} /></button>
                    {t.is_protected ? (
                      <span title="Korumalı şablon silinemez -- önce kopyalayın"><Trash2 size={14} className="text-text-muted opacity-30" /></span>
                    ) : (
                      <button onClick={() => deleteTemplate.mutate(t.id)} className="text-text-muted hover:text-[var(--text-danger)]"><Trash2 size={14} /></button>
                    )}
                  </div>
                  {applyingTemplateId === t.id && (
                    <div className="flex items-center gap-1 mt-2">
                      <select value={selectedGroupId} onChange={(e) => setSelectedGroupId(e.target.value)} className="px-2 py-1 text-xs rounded-md border border-border bg-surface-1 w-32">
                        <option value="">Grup seç</option>
                        {groups?.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
                      </select>
                      <button onClick={() => handleApply(t.id)} disabled={!selectedGroupId} className="text-xs px-2 py-1 rounded-md bg-[var(--text-accent)] text-white disabled:opacity-50">
                        Onayla
                      </button>
                    </div>
                  )}
                  {cloningTemplateId === t.id && (
                    <div className="flex items-center gap-1 mt-2">
                      <input value={cloneName} onChange={(e) => setCloneName(e.target.value)} className="px-2 py-1 text-xs rounded-md border border-border bg-surface-1 w-40" />
                      <button onClick={handleClone} disabled={!cloneName.trim() || cloneTemplate.isPending} className="text-xs px-2 py-1 rounded-md bg-[var(--text-accent)] text-white disabled:opacity-50">
                        Kopyala
                      </button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {templates?.length === 0 && <p className="text-sm text-text-muted p-4">Şablon bulunamadı.</p>}
      </div>
    </div>
  );
}
