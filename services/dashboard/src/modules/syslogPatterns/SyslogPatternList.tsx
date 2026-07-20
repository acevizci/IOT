import { useState } from "react";
import { Plus, Trash2, Pencil, ScrollText, Power } from "lucide-react";
import {
  useSyslogPatterns,
  useCreateSyslogPattern,
  useUpdateSyslogPattern,
  useDeleteSyslogPattern
} from "./useSyslogPatterns";
import type { SyslogPattern, SyslogPatternInput } from "../../api/syslogPatterns";

// min_severity: desen SADECE severity <= bu değer olan (en az bu kadar ciddi) mesajlarda
// denenir. 7 (debug) = filtre yok. Alarm motoru bu isim için ayrı bir kural gerektirir --
// desen sadece metriği ÜRETİR, kuralı kullanıcı Şablonlar/Alarmlar arayüzünde tanımlar.
const SEVERITY_OPTIONS = [
  { value: 7, label: "Tümü (filtre yok)" },
  { value: 6, label: "info ve üstü" },
  { value: 5, label: "notice ve üstü" },
  { value: 4, label: "warning ve üstü" },
  { value: 3, label: "err ve üstü" },
  { value: 2, label: "crit ve üstü" },
  { value: 1, label: "alert ve üstü" },
  { value: 0, label: "sadece emerg" }
];

const EMPTY: SyslogPatternInput = { name: "", regex: "", metric_name: "", min_severity: 7, enabled: true };

export function SyslogPatternList() {
  const { data: patterns, isLoading } = useSyslogPatterns();
  const createPattern = useCreateSyslogPattern();
  const updatePattern = useUpdateSyslogPattern();
  const deletePattern = useDeleteSyslogPattern();

  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<SyslogPatternInput>(EMPTY);

  const activeMutation = editingId ? updatePattern : createPattern;

  function set<K extends keyof SyslogPatternInput>(field: K, value: SyslogPatternInput[K]) {
    setDraft((d) => ({ ...d, [field]: value }));
  }

  function startCreate() {
    setEditingId(null);
    setDraft(EMPTY);
    setShowForm(true);
  }

  function startEdit(p: SyslogPattern) {
    setEditingId(p.id);
    setDraft({ name: p.name, regex: p.regex, metric_name: p.metric_name, min_severity: p.min_severity, enabled: p.enabled });
    setShowForm(true);
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const onSuccess = () => { setShowForm(false); setEditingId(null); setDraft(EMPTY); };
    if (editingId) updatePattern.mutate({ id: editingId, input: draft }, { onSuccess });
    else createPattern.mutate(draft, { onSuccess });
  }

  function toggleEnabled(p: SyslogPattern) {
    updatePattern.mutate({ id: p.id, input: { name: p.name, regex: p.regex, metric_name: p.metric_name, min_severity: p.min_severity, enabled: !p.enabled } });
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-lg font-medium">Syslog Desenleri</h1>
          <p className="text-sm text-text-secondary">Gelen syslog mesajlarını regex ile eşleştirip metrik üretir — bu metrik adı üzerinden Şablonlar/Alarmlar'da kural tanımlarsınız</p>
        </div>
        <button onClick={startCreate} className="flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-md border border-border-strong hover:bg-surface-1">
          <Plus size={15} />
          Desen oluştur
        </button>
      </div>

      {activeMutation.isError && <p className="text-sm text-[var(--text-danger)] mb-3">{(activeMutation.error as Error).message}</p>}

      {showForm && (
        <form onSubmit={handleSubmit} className="bg-surface-2 border border-border rounded-xl p-4 mb-4 flex flex-col gap-3">
          <div className="flex flex-wrap gap-3">
            <div className="flex flex-col gap-1">
              <label className="text-xs text-text-secondary">Ad</label>
              <input value={draft.name} onChange={(e) => set("name", e.target.value)} required className="px-2.5 py-1.5 text-sm rounded-md border border-border bg-surface-1 w-56" placeholder="Disk arızası" />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs text-text-secondary">Metrik adı (alarm kuralı bununla eşleşir)</label>
              <input value={draft.metric_name} onChange={(e) => set("metric_name", e.target.value)} required className="px-2.5 py-1.5 text-sm rounded-md border border-border bg-surface-1 w-56 font-mono" placeholder="syslog_disk_failure" />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs text-text-secondary">Ciddiyet eşiği</label>
              <select value={draft.min_severity} onChange={(e) => set("min_severity", Number(e.target.value))} className="px-2.5 py-1.5 text-sm rounded-md border border-border bg-surface-1 w-48">
                {SEVERITY_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs text-text-secondary">Regex (mesaj gövdesinde aranır, büyük/küçük harf duyarsız)</label>
            <input value={draft.regex} onChange={(e) => set("regex", e.target.value)} required className="px-2.5 py-1.5 text-sm rounded-md border border-border bg-surface-1 w-full font-mono" placeholder="(disk|drive).*(fail|error|offline)" />
          </div>
          <label className="flex items-center gap-2 text-sm text-text-secondary">
            <input type="checkbox" checked={draft.enabled} onChange={(e) => set("enabled", e.target.checked)} />
            Etkin
          </label>
          <div className="flex items-center gap-2">
            <button type="submit" disabled={activeMutation.isPending} className="px-3 py-1.5 text-sm rounded-md bg-[var(--text-accent)] text-white">
              {editingId ? "Güncelle" : "Kaydet"}
            </button>
            <button type="button" onClick={() => { setShowForm(false); setEditingId(null); setDraft(EMPTY); }} className="px-3 py-1.5 text-sm rounded-md border border-border hover:bg-surface-1">
              Vazgeç
            </button>
          </div>
        </form>
      )}

      {isLoading && <p className="text-sm text-text-secondary">Yükleniyor...</p>}

      <div className="border border-border rounded-xl overflow-hidden">
        {patterns?.map((p) => (
          <div key={p.id} className="px-4 py-2.5 border-b border-border last:border-0">
            <div className="flex items-center gap-3">
              <ScrollText size={15} className={`shrink-0 ${p.enabled ? "text-text-secondary" : "text-text-muted"}`} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <p className="text-sm font-medium">{p.name}</p>
                  {!p.enabled && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-surface-1 border border-border text-text-muted">pasif</span>}
                </div>
                <p className="text-[11px] text-text-muted font-mono truncate">/{p.regex}/i → {p.metric_name}</p>
              </div>
              <span className="text-[11px] text-text-secondary shrink-0">{SEVERITY_OPTIONS.find((o) => o.value === p.min_severity)?.label ?? p.min_severity}</span>
              <button onClick={() => toggleEnabled(p)} title={p.enabled ? "Devre dışı bırak" : "Etkinleştir"} className="text-text-muted hover:text-text-primary"><Power size={14} /></button>
              <button onClick={() => startEdit(p)} className="text-text-muted hover:text-text-primary"><Pencil size={14} /></button>
              <button onClick={() => deletePattern.mutate(p.id)} className="text-text-muted hover:text-[var(--text-danger)]"><Trash2 size={14} /></button>
            </div>
          </div>
        ))}
        {patterns?.length === 0 && <p className="text-sm text-text-muted p-4">Henüz syslog deseni oluşturulmadı.</p>}
      </div>
    </div>
  );
}
