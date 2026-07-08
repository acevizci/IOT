import { useState } from "react";
import { useParams, Link } from "react-router-dom";
import { ArrowLeft, Plus, Trash2 } from "lucide-react";
import { useAlertTemplate, useTemplateDevices } from "./useAlertTemplates";
import { useTemplateItems, useCreateTemplateItem, useDeleteTemplateItem } from "./useTemplateItems";
import { SEVERITY_LABEL } from "../shared/severity";

const CONDITION_LABEL: Record<string, string> = { gt: "büyükse", lt: "küçükse", eq: "eşitse" };

export function TemplateDetail() {
  const { id } = useParams<{ id: string }>();
  const { data: template, isLoading } = useAlertTemplate(id!);
  const { data: items, isLoading: itemsLoading } = useTemplateItems(id!);
  const { data: devices } = useTemplateDevices(id!);
  const createItem = useCreateTemplateItem(id!);
  const deleteItem = useDeleteTemplateItem(id!);

  const [showItemForm, setShowItemForm] = useState(false);
  const [metricName, setMetricName] = useState("");
  const [oid, setOid] = useState("");
  const [dataType, setDataType] = useState<"gauge" | "counter" | "string">("gauge");
  const [unit, setUnit] = useState("");
  const [interval, setInterval2] = useState(60);

  function handleCreateItem(e: React.FormEvent) {
    e.preventDefault();
    createItem.mutate(
      { metric_name: metricName, oid, data_type: dataType, unit: unit || undefined, polling_interval_seconds: interval, is_table: false },
      { onSuccess: () => { setMetricName(""); setOid(""); setUnit(""); setShowItemForm(false); } }
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

      <h1 className="text-lg font-medium mb-1">{template.name}</h1>
      <div className="flex items-center gap-2 mb-3 flex-wrap">
        <p className="text-sm text-text-secondary">{template.device_type ?? "Tüm cihaz tipleri"}</p>
        {(template.tags ?? []).map((tag) => (
          <span key={tag} className="text-[11px] px-2 py-0.5 rounded-full bg-surface-2 border border-border text-text-secondary">{tag}</span>
        ))}
      </div>

      {(template.parent_template_name || template.children.length > 0) && (
        <div className="bg-surface-1 rounded-xl p-3.5 mb-5 flex gap-8">
          <div>
            <p className="text-xs text-text-secondary mb-1">Miras alınan şablon</p>
            {template.parent_template_name ? (
              <Link to={`/templates/${template.parent_template_id}`} className="text-sm text-text-accent">{template.parent_template_name}</Link>
            ) : (
              <p className="text-sm text-text-muted">Yok</p>
            )}
          </div>
          <div>
            <p className="text-xs text-text-secondary mb-1">Bu şablonu miras alanlar</p>
            {template.children.length > 0 ? (
              <div className="flex gap-2 flex-wrap">
                {template.children.map((c) => (
                  <Link key={c.id} to={`/templates/${c.id}`} className="text-sm text-text-accent">{c.name}</Link>
                ))}
              </div>
            ) : (
              <p className="text-sm text-text-muted">Yok</p>
            )}
          </div>
        </div>
      )}

      <div className="grid grid-cols-2 gap-4">
        <div>
          <p className="text-sm font-medium mb-2">Alarm kuralları</p>
          <div className="border border-border rounded-xl overflow-hidden">
            {template.rules.map((r) => (
              <div key={r.id} className="px-4 py-2.5 border-b border-border last:border-0 text-sm">
                <p className="font-medium">{r.metric_name}</p>
                <p className="text-xs text-text-secondary">
                  {CONDITION_LABEL[r.condition]} {r.threshold} · {r.duration_seconds}s · {SEVERITY_LABEL[r.severity] ?? r.severity}
                </p>
                {r.depends_on_metric_name && (
                  <p className="text-xs text-text-muted mt-1">↳ bağımlı: {r.depends_on_metric_name}</p>
                )}
              </div>
            ))}
            {template.rules.length === 0 && <p className="text-sm text-text-muted p-4">Kural yok.</p>}
          </div>
        </div>

        <div>
          <div className="flex items-center justify-between mb-2">
            <p className="text-sm font-medium">
              Metrik tanımları (Items)
              <span className="text-xs text-text-muted font-normal"> — hangi SNMP OID'lerinin toplanacağı</span>
            </p>
            <button onClick={() => setShowItemForm((v) => !v)} className="flex items-center gap-1 text-xs px-2.5 py-1.5 rounded-md border border-border-strong hover:bg-surface-1">
              <Plus size={13} />
              Item ekle
            </button>
          </div>

          {showItemForm && (
            <form onSubmit={handleCreateItem} className="bg-surface-2 border border-border rounded-xl p-3 mb-3 flex flex-col gap-2">
              <div className="flex gap-2">
                <input value={metricName} onChange={(e) => setMetricName(e.target.value)} placeholder="metric_name (örn. cisco_cpu_util)" required className="flex-1 px-2 py-1.5 text-sm rounded-md border border-border bg-surface-1" />
                <select value={dataType} onChange={(e) => setDataType(e.target.value as any)} className="px-2 py-1.5 text-sm rounded-md border border-border bg-surface-1">
                  <option value="gauge">gauge</option>
                  <option value="counter">counter</option>
                  <option value="string">string</option>
                </select>
              </div>
              <input value={oid} onChange={(e) => setOid(e.target.value)} placeholder="OID (örn. 1.3.6.1.4.1.9.9.109.1.1.1.1.5.1)" required className="px-2 py-1.5 text-sm rounded-md border border-border bg-surface-1 font-mono" />
              <div className="flex gap-2">
                <input value={unit} onChange={(e) => setUnit(e.target.value)} placeholder="birim (opsiyonel)" className="flex-1 px-2 py-1.5 text-sm rounded-md border border-border bg-surface-1" />
                <input type="number" value={interval} onChange={(e) => setInterval2(Number(e.target.value))} placeholder="aralık (sn)" className="w-28 px-2 py-1.5 text-sm rounded-md border border-border bg-surface-1" />
              </div>
              <button type="submit" disabled={createItem.isPending} className="px-3 py-1.5 text-sm rounded-md bg-[var(--text-accent)] text-white">
                Item ekle
              </button>
            </form>
          )}

          {itemsLoading && <p className="text-sm text-text-secondary">Yükleniyor...</p>}

          <div className="border border-border rounded-xl overflow-hidden">
            {items?.map((item) => (
              <div key={item.id} className="flex items-center gap-3 px-4 py-2.5 border-b border-border last:border-0">
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium">{item.metric_name}</p>
                  <p className="text-xs text-text-muted font-mono truncate">{item.oid}</p>
                </div>
                <span className="text-xs text-text-secondary shrink-0">{item.data_type}</span>
                <button onClick={() => deleteItem.mutate(item.id)} className="text-text-muted hover:text-[var(--text-danger)] shrink-0">
                  <Trash2 size={13} />
                </button>
              </div>
            ))}
            {items?.length === 0 && <p className="text-sm text-text-muted p-4">Henüz özel metrik tanımlanmadı.</p>}
          </div>
        </div>
      </div>

      <div className="mt-4">
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
