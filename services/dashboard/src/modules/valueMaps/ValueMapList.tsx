import { useState } from "react";
import { Plus, Trash2, Tag } from "lucide-react";
import { useValueMaps, useCreateValueMap, useDeleteValueMap } from "./useValueMaps";

export function ValueMapList() {
  const { data: valueMaps, isLoading } = useValueMaps();
  const createValueMap = useCreateValueMap();
  const deleteValueMap = useDeleteValueMap();

  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState("");
  const [mappings, setMappings] = useState<Array<{ value: string; label: string }>>([{ value: "", label: "" }]);

  function addRow() {
    setMappings([...mappings, { value: "", label: "" }]);
  }
  function updateRow(i: number, field: "value" | "label", val: string) {
    setMappings(mappings.map((m, idx) => (idx === i ? { ...m, [field]: val } : m)));
  }
  function removeRow(i: number) {
    setMappings(mappings.filter((_, idx) => idx !== i));
  }

  function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    createValueMap.mutate(
      { name, mappings: mappings.filter((m) => m.value !== "" && m.label !== "") },
      { onSuccess: () => { setName(""); setMappings([{ value: "", label: "" }]); setShowForm(false); } }
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-lg font-medium">Value Maps</h1>
          <p className="text-sm text-text-secondary">Ham sayısal değerleri (0, 1, 2...) okunur etiketlere (up, down, warning...) çevirir</p>
        </div>
        <button onClick={() => setShowForm((v) => !v)} className="flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-md border border-border-strong hover:bg-surface-1">
          <Plus size={15} />
          Value Map oluştur
        </button>
      </div>

      {createValueMap.isError && <p className="text-sm text-[var(--text-danger)] mb-3">{(createValueMap.error as Error).message}</p>}

      {showForm && (
        <form onSubmit={handleCreate} className="bg-surface-2 border border-border rounded-xl p-4 mb-4">
          <div className="mb-3">
            <label className="text-xs text-text-secondary mb-1 block">Ad</label>
            <input value={name} onChange={(e) => setName(e.target.value)} required className="px-2.5 py-1.5 text-sm rounded-md border border-border bg-surface-1 w-64" placeholder="F5 Pool Status" />
          </div>
          <p className="text-xs text-text-secondary mb-2">Eşleşmeler</p>
          {mappings.map((m, i) => (
            <div key={i} className="flex items-center gap-2 mb-2">
              <input value={m.value} onChange={(e) => updateRow(i, "value", e.target.value)} placeholder="ham değer (örn. 1)" className="px-2 py-1.5 text-sm rounded-md border border-border bg-surface-1 w-32" />
              <span className="text-text-muted">→</span>
              <input value={m.label} onChange={(e) => updateRow(i, "label", e.target.value)} placeholder="etiket (örn. up)" className="px-2 py-1.5 text-sm rounded-md border border-border bg-surface-1 w-40" />
              {mappings.length > 1 && (
                <button type="button" onClick={() => removeRow(i)} className="text-text-muted hover:text-[var(--text-danger)]"><Trash2 size={14} /></button>
              )}
            </div>
          ))}
          <button type="button" onClick={addRow} className="text-xs text-text-accent mb-3">+ Eşleşme ekle</button>
          <button type="submit" disabled={createValueMap.isPending} className="block px-3 py-1.5 text-sm rounded-md bg-[var(--text-accent)] text-white">
            Kaydet
          </button>
        </form>
      )}

      {isLoading && <p className="text-sm text-text-secondary">Yükleniyor...</p>}

      <div className="border border-border rounded-xl overflow-hidden">
        {valueMaps?.map((vm) => (
          <div key={vm.id} className="px-4 py-2.5 border-b border-border last:border-0">
            <div className="flex items-center gap-3">
              <Tag size={15} className="text-text-secondary shrink-0" />
              <p className="text-sm font-medium flex-1">{vm.name}</p>
              <button onClick={() => deleteValueMap.mutate(vm.id)} className="text-text-muted hover:text-[var(--text-danger)]"><Trash2 size={14} /></button>
            </div>
            <div className="flex gap-2 flex-wrap mt-1.5 pl-7">
              {vm.mappings.map((m, i) => (
                <span key={i} className="text-[11px] px-2 py-0.5 rounded-full bg-surface-1 border border-border text-text-secondary">
                  {m.value} → {m.label}
                </span>
              ))}
            </div>
          </div>
        ))}
        {valueMaps?.length === 0 && <p className="text-sm text-text-muted p-4">Henüz value map oluşturulmadı.</p>}
      </div>
    </div>
  );
}
