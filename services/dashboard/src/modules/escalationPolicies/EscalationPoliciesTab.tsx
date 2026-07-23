import { useState } from "react";
import { Plus, Trash2, Zap, Bell, Terminal } from "lucide-react";
import {
  useEscalationPolicies, useCreateEscalationPolicy, useDeleteEscalationPolicy,
  useEscalationPolicySteps, useCreateEscalationPolicyStep, useDeleteEscalationPolicyStep
} from "./useEscalationPolicies";
import { useMediaTypes } from "../notifications/useNotifications";

function formatDelay(seconds: number): string {
  if (seconds === 0) return "hemen";
  if (seconds < 60) return `${seconds}sn sonra`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}dk sonra`;
  return `${Math.round(seconds / 3600)}sa sonra`;
}

// Bildirim sistemi tasarımı: Zabbix'in Actions/Operations'ı ya da PagerDuty/
// Opsgenie'nin Escalation Policy'si gibi -- burada BİR KEZ tanımlanan bir
// adım zinciri, DeviceDetail'in Kurallar bölümünde ya da şablon kural
// düzenleyicisinde istenildiği kadar kurala atanabilir (bkz. RulesSection,
// TemplateDetail).
export function EscalationPoliciesTab() {
  const { data: policies, isLoading } = useEscalationPolicies();
  const createPolicy = useCreateEscalationPolicy();
  const deletePolicy = useDeleteEscalationPolicy();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");

  function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    createPolicy.mutate(
      { name, description: description || undefined },
      { onSuccess: (created) => { setName(""); setDescription(""); setShowForm(false); setSelectedId(created.id); } }
    );
  }

  return (
    <div className="grid grid-cols-[1fr_1.4fr] gap-4">
      <div>
        <div className="flex items-center justify-between mb-3">
          <p className="text-sm font-medium">Politikalar</p>
          <button onClick={() => setShowForm((v) => !v)} className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md border border-border-strong hover:bg-surface-1">
            <Plus size={14} />
            Politika ekle
          </button>
        </div>

        {showForm && (
          <form onSubmit={handleCreate} className="bg-surface-2 border border-border rounded-xl p-3 mb-3 flex flex-col gap-2">
            <input value={name} onChange={(e) => setName(e.target.value)} required placeholder="Politika adı (örn. Kritik On-Call)" className="px-2.5 py-1.5 text-sm rounded-md border border-border bg-surface-1" />
            <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Açıklama (opsiyonel)" className="px-2.5 py-1.5 text-sm rounded-md border border-border bg-surface-1" />
            <button type="submit" disabled={createPolicy.isPending} className="self-start px-3 py-1.5 text-sm rounded-md bg-[var(--text-accent)] text-white">
              Oluştur
            </button>
          </form>
        )}

        {isLoading && <p className="text-sm text-text-secondary">Yükleniyor...</p>}

        <div className="border border-border rounded-xl overflow-hidden">
          {policies?.map((p) => (
            <div
              key={p.id}
              onClick={() => setSelectedId(p.id)}
              className={`flex items-center gap-2 px-4 py-2.5 border-b border-border last:border-0 cursor-pointer ${selectedId === p.id ? "bg-[var(--bg-accent)]" : "hover:bg-surface-1"}`}
            >
              <Zap size={14} className="text-[var(--text-warning)] shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium truncate">{p.name}</p>
                <p className="text-[11px] text-text-muted">{p.step_count} adım{p.description ? ` · ${p.description}` : ""}</p>
              </div>
              <button
                onClick={(e) => { e.stopPropagation(); deletePolicy.mutate(p.id); if (selectedId === p.id) setSelectedId(null); }}
                className="text-text-muted hover:text-[var(--text-danger)] shrink-0"
              >
                <Trash2 size={13} />
              </button>
            </div>
          ))}
          {policies?.length === 0 && <p className="text-sm text-text-muted p-4">Henüz politika tanımlanmadı.</p>}
        </div>
      </div>

      <div>
        {selectedId ? (
          <PolicyStepsEditor policyId={selectedId} />
        ) : (
          <p className="text-sm text-text-muted mt-8 text-center">Adımlarını görmek/düzenlemek için soldan bir politika seç.</p>
        )}
      </div>
    </div>
  );
}

function PolicyStepsEditor({ policyId }: { policyId: string }) {
  const { data: steps, isLoading } = useEscalationPolicySteps(policyId);
  const { data: mediaTypes } = useMediaTypes();
  const createStep = useCreateEscalationPolicyStep(policyId);
  const deleteStep = useDeleteEscalationPolicyStep(policyId);

  const [showForm, setShowForm] = useState(false);
  const [delayMinutes, setDelayMinutes] = useState(5);
  const [actionType, setActionType] = useState<"notify" | "remote_command">("notify");
  const [mediaTypeId, setMediaTypeId] = useState("");
  const [remoteCommand, setRemoteCommand] = useState("");

  function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    const nextOrder = (steps?.length ?? 0) + 1;
    createStep.mutate(
      {
        step_order: nextOrder,
        delay_seconds: delayMinutes * 60,
        action_type: actionType,
        media_type_id: actionType === "notify" ? mediaTypeId : undefined,
        remote_command: actionType === "remote_command" ? remoteCommand : undefined
      },
      { onSuccess: () => { setShowForm(false); setDelayMinutes(5); setMediaTypeId(""); setRemoteCommand(""); } }
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <p className="text-sm font-medium">Adımlar</p>
        <button onClick={() => setShowForm((v) => !v)} className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md border border-border-strong hover:bg-surface-1">
          <Plus size={14} />
          Adım ekle
        </button>
      </div>

      {showForm && (
        <form onSubmit={handleCreate} className="bg-surface-2 border border-border rounded-xl p-3 mb-3 flex items-end gap-2 flex-wrap">
          <div className="flex flex-col gap-1">
            <label className="text-xs text-text-secondary">Gecikme (dk)</label>
            <input type="number" min={0} value={delayMinutes} onChange={(e) => setDelayMinutes(Number(e.target.value))} className="px-2 py-1.5 text-sm rounded-md border border-border bg-surface-1 w-20" />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs text-text-secondary">Eylem</label>
            <select value={actionType} onChange={(e) => setActionType(e.target.value as "notify" | "remote_command")} className="px-2 py-1.5 text-sm rounded-md border border-border bg-surface-1">
              <option value="notify">Bildir</option>
              <option value="remote_command">Uzak komut çalıştır</option>
            </select>
          </div>
          {actionType === "notify" ? (
            <div className="flex flex-col gap-1">
              <label className="text-xs text-text-secondary">Kanal</label>
              <select value={mediaTypeId} onChange={(e) => setMediaTypeId(e.target.value)} required className="px-2 py-1.5 text-sm rounded-md border border-border bg-surface-1 w-40">
                <option value="">Seçin</option>
                {mediaTypes?.map((mt) => <option key={mt.id} value={mt.id}>{mt.name}</option>)}
              </select>
            </div>
          ) : (
            <div className="flex flex-col gap-1">
              <label className="text-xs text-text-secondary" title="Cihazın SSH bağlantı bilgileriyle Exec Collector üzerinden çalıştırılır">Komut</label>
              <input value={remoteCommand} onChange={(e) => setRemoteCommand(e.target.value)} required className="px-2 py-1.5 text-sm rounded-md border border-border bg-surface-1 w-48" placeholder="systemctl restart nginx" />
            </div>
          )}
          <button type="submit" disabled={createStep.isPending} className="px-3 py-1.5 text-sm rounded-md bg-[var(--text-accent)] text-white">
            Ekle
          </button>
        </form>
      )}

      {isLoading && <p className="text-sm text-text-secondary">Yükleniyor...</p>}

      <div className="border border-border rounded-xl overflow-hidden">
        {steps?.map((s) => (
          <div key={s.id} className="flex items-center gap-3 px-4 py-2.5 border-b border-border last:border-0">
            <span className="text-xs font-mono text-text-muted w-6 shrink-0">#{s.step_order}</span>
            <span className="text-xs text-text-secondary w-20 shrink-0">{formatDelay(s.delay_seconds)}</span>
            {s.action_type === "notify" ? (
              <span className="flex items-center gap-1.5 text-sm flex-1 min-w-0">
                <Bell size={13} className="text-text-muted shrink-0" />
                <span className="truncate">{s.media_type_name ?? "Kanal silinmiş"}</span>
              </span>
            ) : (
              <span className="flex items-center gap-1.5 text-sm flex-1 min-w-0 font-mono">
                <Terminal size={13} className="text-text-muted shrink-0" />
                <span className="truncate">{s.remote_command}</span>
              </span>
            )}
            <button onClick={() => deleteStep.mutate(s.id)} className="text-text-muted hover:text-[var(--text-danger)] shrink-0">
              <Trash2 size={13} />
            </button>
          </div>
        ))}
        {steps?.length === 0 && <p className="text-sm text-text-muted p-4">Henüz adım tanımlanmadı.</p>}
      </div>
    </div>
  );
}
