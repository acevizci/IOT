import { useState } from "react";
import { Plus, Trash2, ChevronDown, ChevronRight, Lock } from "lucide-react";
import { useMacros, useCreateMacro, useDeleteMacro, useMacroOverrides, useCreateMacroOverride, useDeleteMacroOverride } from "./useMacros";
import type { MacroValueType } from "../../api/macros";
import { useDevices } from "../devices/useDevices";
import { useDeviceGroups } from "../deviceGroups/useDeviceGroups";

const VALUE_TYPE_LABEL: Record<MacroValueType, string> = {
  numeric: "Sayısal",
  string: "Metin",
  secret: "Gizli (şifreli)"
};

export function MacroList() {
  const { data: macros, isLoading } = useMacros();
  const createMacro = useCreateMacro();
  const deleteMacro = useDeleteMacro();

  const [showForm, setShowForm] = useState(false);
  const [key, setKey] = useState("");
  const [valueType, setValueType] = useState<MacroValueType>("numeric");
  const [defaultValue, setDefaultValue] = useState("");
  const [description, setDescription] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);

  function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    createMacro.mutate(
      { key, value_type: valueType, default_value: defaultValue, description: description || undefined },
      { onSuccess: () => { setKey(""); setValueType("numeric"); setDefaultValue(""); setDescription(""); setShowForm(false); } }
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-lg font-medium">Makrolar</h1>
          <p className="text-sm text-text-secondary">
            Şablonlarda ve bağlantı bilgilerinde kullanılan {"{$DEĞİŞKEN}"}'ler — cihaz/grup bazlı özelleştirilebilir.
            "Gizli" tipi (parola, private key) şifreli saklanır ve arayüzde asla düz metin gösterilmez.
          </p>
        </div>
        <button onClick={() => setShowForm((v) => !v)} className="flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-md border border-border-strong hover:bg-surface-1 shrink-0">
          <Plus size={15} />
          Makro oluştur
        </button>
      </div>

      {showForm && (
        <form onSubmit={handleCreate} className="bg-surface-2 border border-border rounded-xl p-4 mb-4 flex items-end gap-3 flex-wrap">
          <div>
            <label className="text-xs text-text-secondary mb-1 block">Anahtar</label>
            <input value={key} onChange={(e) => setKey(e.target.value)} required className="px-2.5 py-1.5 text-sm rounded-md border border-border bg-surface-1 w-48 font-mono" placeholder="{$SSH_PASSWORD}" />
          </div>
          <div>
            <label className="text-xs text-text-secondary mb-1 block">Tip</label>
            <select value={valueType} onChange={(e) => setValueType(e.target.value as MacroValueType)} className="px-2.5 py-1.5 text-sm rounded-md border border-border bg-surface-1">
              <option value="numeric">Sayısal</option>
              <option value="string">Metin</option>
              <option value="secret">Gizli (şifreli)</option>
            </select>
          </div>
          <div>
            <label className="text-xs text-text-secondary mb-1 block">Varsayılan değer</label>
            <input
              type={valueType === "secret" ? "password" : "text"}
              value={defaultValue}
              onChange={(e) => setDefaultValue(e.target.value)}
              required
              className="px-2.5 py-1.5 text-sm rounded-md border border-border bg-surface-1 w-40"
              placeholder={valueType === "numeric" ? "90" : valueType === "secret" ? "••••••" : "root"}
            />
          </div>
          <div>
            <label className="text-xs text-text-secondary mb-1 block">Açıklama</label>
            <input value={description} onChange={(e) => setDescription(e.target.value)} className="px-2.5 py-1.5 text-sm rounded-md border border-border bg-surface-1 w-56" />
          </div>
          <button type="submit" disabled={createMacro.isPending} className="px-3 py-1.5 text-sm rounded-md bg-[var(--text-accent)] text-white">
            Oluştur
          </button>
        </form>
      )}

      {createMacro.isError && <p className="text-sm text-[var(--text-danger)] mb-3">{(createMacro.error as Error).message}</p>}
      {isLoading && <p className="text-sm text-text-secondary">Yükleniyor...</p>}

      <div className="border border-border rounded-xl overflow-hidden">
        {macros?.map((m) => (
          <div key={m.id} className="border-b border-border last:border-0">
            <div className="flex items-center gap-3 px-4 py-2.5">
              <button onClick={() => setExpandedId(expandedId === m.id ? null : m.id)} className="text-text-muted">
                {expandedId === m.id ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
              </button>
              <span className="font-mono text-sm font-medium">{m.key}</span>
              <span className="text-[11px] px-1.5 py-0.5 rounded bg-surface-2 border border-border text-text-secondary">{VALUE_TYPE_LABEL[m.value_type]}</span>
              <span className="text-xs text-text-secondary flex items-center gap-1">
                {m.value_type === "secret" && <Lock size={11} />}
                varsayılan: {m.default_value}
              </span>
              <span className="text-xs text-text-muted flex-1">{m.description}</span>
              <button onClick={() => deleteMacro.mutate(m.id)} className="text-text-muted hover:text-[var(--text-danger)]"><Trash2 size={14} /></button>
            </div>
            {expandedId === m.id && <MacroOverrides macroId={m.id} valueType={m.value_type} />}
          </div>
        ))}
        {macros?.length === 0 && <p className="text-sm text-text-muted p-4">Henüz makro tanımlanmadı.</p>}
      </div>
    </div>
  );
}

function MacroOverrides({ macroId, valueType }: { macroId: string; valueType: MacroValueType }) {
  const { data: overrides } = useMacroOverrides(macroId);
  const createOverride = useCreateMacroOverride(macroId);
  const deleteOverride = useDeleteMacroOverride(macroId);
  const { data: devicesData } = useDevices({ limit: 200 });
  const devices = devicesData?.items;
  const { data: groups } = useDeviceGroups();

  const [scopeType, setScopeType] = useState<"device" | "device_group">("device_group");
  const [scopeId, setScopeId] = useState("");
  const [value, setValue] = useState("");

  function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    if (!scopeId || !value) return;
    createOverride.mutate({ scope_type: scopeType, scope_id: scopeId, value }, { onSuccess: () => setValue("") });
  }

  return (
    <div className="bg-surface-1 px-4 py-3 pl-11">
      <p className="text-xs text-text-secondary mb-2">Cihaz/grup bazlı override'lar</p>
      {overrides?.map((o) => (
        <div key={o.id} className="flex items-center gap-2 text-xs py-1">
          <span className="px-1.5 py-0.5 rounded bg-surface-2 border border-border">{o.scope_type === "device" ? "cihaz" : "grup"}</span>
          <span className="flex-1">{o.scope_name}</span>
          <span className="font-medium flex items-center gap-1">
            {valueType === "secret" && <Lock size={10} />}
            {o.value}
          </span>
          <button onClick={() => deleteOverride.mutate(o.id)} className="text-text-muted hover:text-[var(--text-danger)]"><Trash2 size={12} /></button>
        </div>
      ))}
      <form onSubmit={handleAdd} className="flex items-end gap-2 mt-2">
        <select value={scopeType} onChange={(e) => setScopeType(e.target.value as "device" | "device_group")} className="px-2 py-1 text-xs rounded-md border border-border bg-surface-2">
          <option value="device_group">Host grubu</option>
          <option value="device">Cihaz</option>
        </select>
        <select value={scopeId} onChange={(e) => setScopeId(e.target.value)} className="px-2 py-1 text-xs rounded-md border border-border bg-surface-2 w-40">
          <option value="">Seç</option>
          {scopeType === "device"
            ? devices?.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)
            : groups?.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
        </select>
        <input
          type={valueType === "secret" ? "password" : "text"}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={valueType === "secret" ? "••••••" : "değer"}
          className="px-2 py-1 text-xs rounded-md border border-border bg-surface-2 w-32"
        />
        <button type="submit" className="px-2.5 py-1 text-xs rounded-md bg-[var(--text-accent)] text-white">Ekle</button>
      </form>
    </div>
  );
}
