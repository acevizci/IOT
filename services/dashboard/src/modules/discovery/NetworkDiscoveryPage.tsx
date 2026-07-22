import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Radar, Plus, Pencil, Trash2, CheckCheck, X } from "lucide-react";
import {
  useDiscoveryRules, useCreateDiscoveryRule, useUpdateDiscoveryRule, useDeleteDiscoveryRule, useRunDiscoveryRule,
  useDiscoveryCandidates, useDismissDiscoveryCandidate, useBulkAddDiscoveryCandidates
} from "./useDiscovery";
import { fetchScanJob } from "../../api/discoveryRules";
import type { DiscoveryRule, DiscoveryRuleInput, ScanJob, SnmpV3Level, SnmpAuthProtocol, SnmpPrivProtocol } from "../../api/discoveryRules";

const DEVICE_TYPES = ["switch", "firewall", "server", "load_balancer", "router", "other"];
const V3_LEVELS: { value: SnmpV3Level; label: string }[] = [
  { value: "noAuthNoPriv", label: "Kimlik doğrulama yok" },
  { value: "authNoPriv", label: "Sadece kimlik doğrulama" },
  { value: "authPriv", label: "Kimlik doğrulama + şifreleme" }
];
const AUTH_PROTOCOLS: SnmpAuthProtocol[] = ["md5", "sha", "sha224", "sha256", "sha384", "sha512"];
const PRIV_PROTOCOLS: SnmpPrivProtocol[] = ["des", "aes", "aes256b", "aes256r"];

function timeSince(dateStr: string | null): string {
  if (!dateStr) return "Hiç çalışmadı";
  const seconds = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (seconds < 60) return `${seconds}sn önce`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}dk önce`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}s önce`;
  return `${Math.floor(seconds / 86400)}g önce`;
}

export function NetworkDiscoveryPage() {
  const qc = useQueryClient();
  const { data: rules, isLoading: rulesLoading } = useDiscoveryRules();
  const { data: candidates, isLoading: candidatesLoading } = useDiscoveryCandidates();
  const createRule = useCreateDiscoveryRule();
  const updateRule = useUpdateDiscoveryRule();
  const deleteRule = useDeleteDiscoveryRule();
  const runRule = useRunDiscoveryRule();
  const dismissCandidate = useDismissDiscoveryCandidate();
  const bulkAdd = useBulkAddDiscoveryCandidates();

  const [showForm, setShowForm] = useState(false);
  const [editingRule, setEditingRule] = useState<DiscoveryRule | null>(null);
  const [runningJobs, setRunningJobs] = useState<Record<string, ScanJob>>({});
  // GERÇEK HATA (canlı testte bulundu): "Şimdi çalıştır" başarısız olursa
  // (örn. npm-service'e ulaşılamadı) önceden HİÇBİR geri bildirim yoktu --
  // buton döner durumundan çıkar ama kullanıcı ne olduğunu asla öğrenemezdi.
  const [runErrors, setRunErrors] = useState<Record<string, string>>({});
  const pollRefs = useRef<Record<string, ReturnType<typeof setInterval>>>({});

  useEffect(() => {
    return () => {
      Object.values(pollRefs.current).forEach(clearInterval);
    };
  }, []);

  function handleRun(ruleId: string) {
    setRunErrors((prev) => ({ ...prev, [ruleId]: "" }));
    runRule.mutate(ruleId, {
      onError: (err) => setRunErrors((prev) => ({ ...prev, [ruleId]: (err as Error).message })),
      onSuccess: ({ jobId }) => {
        pollRefs.current[ruleId] = setInterval(async () => {
          const job = await fetchScanJob(jobId);
          setRunningJobs((prev) => ({ ...prev, [ruleId]: job }));
          if (job.status !== "running") {
            clearInterval(pollRefs.current[ruleId]);
            delete pollRefs.current[ruleId];
            if (job.status === "failed" && job.error) {
              setRunErrors((prev) => ({ ...prev, [ruleId]: job.error! }));
            }
            // Tarama bitince yeni adaylar discovery_candidates'a işlenmiş olur
            // (npm-service'in core'a callback'i) -- listeyi hemen tazeleyelim
            // (aksi halde useDiscoveryCandidates'ın 15sn'lik refetchInterval'ı
            // dolana kadar kullanıcı yeni bulunanları görmez).
            qc.invalidateQueries({ queryKey: ["discovery-candidates"] });
            qc.invalidateQueries({ queryKey: ["discovery-rules"] });
          }
        }, 1500);
      }
    });
  }

  const [selectedCandidateIds, setSelectedCandidateIds] = useState<Set<string>>(new Set());
  const [bulkDeviceType, setBulkDeviceType] = useState("server");
  function toggleCandidate(id: string) {
    setSelectedCandidateIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }
  function toggleSelectAllCandidates() {
    if (candidates && selectedCandidateIds.size === candidates.length) setSelectedCandidateIds(new Set());
    else setSelectedCandidateIds(new Set(candidates?.map((c) => c.id) ?? []));
  }
  function handleBulkAdd() {
    bulkAdd.mutate(
      { ids: Array.from(selectedCandidateIds), deviceType: bulkDeviceType },
      { onSuccess: () => setSelectedCandidateIds(new Set()) }
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-lg font-medium">Ağ Keşfi</h1>
          <p className="text-sm text-text-secondary mt-0.5">
            Kural-bazlı, zamanlanabilir alt ağ taraması -- önce hızlı bir ICMP sweep'iyle canlı host'lar bulunur,
            sadece onlarda SNMP denenir (büyük aralıklarda dakikalar süren eski davranış yerine).
          </p>
        </div>
        <button
          onClick={() => { setEditingRule(null); setShowForm(true); }}
          className="flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-md bg-[var(--text-accent)] text-white shrink-0"
        >
          <Plus size={15} />
          Yeni kural
        </button>
      </div>

      <div className="border border-border rounded-xl overflow-hidden bg-surface-2 mb-6">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-surface-1 text-text-secondary text-left">
              <th className="p-3 font-medium">Kural</th>
              <th className="p-3 font-medium">CIDR aralıkları</th>
              <th className="p-3 font-medium">SNMP</th>
              <th className="p-3 font-medium">Zamanlama</th>
              <th className="p-3 font-medium">Son çalışma</th>
              <th className="p-3 font-medium w-64"></th>
              <th className="p-3 font-medium w-16"></th>
            </tr>
          </thead>
          <tbody>
            {rules?.map((rule) => (
              <tr key={rule.id} className="border-t border-border">
                <td className="p-3 align-top">
                  <p className="font-medium">{rule.name}</p>
                  {!rule.active && <span className="text-[10px] px-1.5 py-0.5 rounded bg-surface-1 text-text-muted">pasif</span>}
                </td>
                <td className="p-3 align-top font-mono text-xs text-text-secondary">
                  {rule.cidr_ranges.join(", ")}
                </td>
                <td className="p-3 align-top">
                  <span className="text-xs px-1.5 py-0.5 rounded bg-surface-1 text-text-secondary">
                    {rule.snmp_version === "v3" ? `v3 (${rule.snmp_v3_level})` : "v2c"}
                  </span>
                </td>
                <td className="p-3 align-top text-text-secondary">
                  {rule.schedule_interval_hours ? `Her ${rule.schedule_interval_hours} saatte` : "Manuel"}
                </td>
                <td className="p-3 align-top text-text-muted text-xs">{timeSince(rule.last_run_at)}</td>
                <td className="p-3 align-top">
                  <RuleProgress job={runningJobs[rule.id]} onRun={() => handleRun(rule.id)} isStarting={runRule.isPending} error={runErrors[rule.id]} />
                </td>
                <td className="p-3 align-top">
                  <div className="flex items-center gap-1">
                    <button onClick={() => { setEditingRule(rule); setShowForm(true); }} className="text-text-muted hover:text-text-accent p-1">
                      <Pencil size={14} />
                    </button>
                    <button
                      onClick={() => { if (confirm(`"${rule.name}" kuralını silmek istediğinize emin misiniz?`)) deleteRule.mutate(rule.id); }}
                      className="text-text-muted hover:text-[var(--text-danger)] p-1"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!rulesLoading && rules?.length === 0 && (
          <p className="text-sm text-text-muted p-4">Henüz keşif kuralı tanımlanmadı.</p>
        )}
      </div>

      <div className="flex items-center justify-between mb-3">
        <h2 className="text-base font-medium">Bulunan cihazlar</h2>
        {candidates && candidates.length > 0 && (
          <div className="flex items-center gap-2">
            <select value={bulkDeviceType} onChange={(e) => setBulkDeviceType(e.target.value)} className="text-xs px-2 py-1.5 rounded-md border border-border bg-surface-1">
              {DEVICE_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
            <button
              onClick={handleBulkAdd}
              disabled={selectedCandidateIds.size === 0 || bulkAdd.isPending}
              className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md bg-[var(--text-accent)] text-white disabled:opacity-50"
            >
              <CheckCheck size={13} />
              {bulkAdd.isPending ? "Ekleniyor..." : `${selectedCandidateIds.size} cihazı ekle`}
            </button>
          </div>
        )}
      </div>

      {bulkAdd.data && bulkAdd.data.failed.length > 0 && (
        <div className="mb-3 text-xs bg-[var(--bg-warning)] text-[var(--text-warning)] p-2.5 rounded-md">
          {bulkAdd.data.failed.map((f, i) => <p key={i}>{f.ip_address}: {f.error}</p>)}
        </div>
      )}

      <div className="border border-border rounded-xl overflow-hidden bg-surface-2">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-surface-1 text-text-secondary text-left">
              <th className="p-2.5 w-8">
                <input type="checkbox" checked={!!candidates && candidates.length > 0 && selectedCandidateIds.size === candidates.length} onChange={toggleSelectAllCandidates} />
              </th>
              <th className="p-2.5 font-medium">IP</th>
              <th className="p-2.5 font-medium">sysDescr</th>
              <th className="p-2.5 font-medium">Interface</th>
              <th className="p-2.5 font-medium">Kural</th>
              <th className="p-2.5 font-medium">İlk / son görülme</th>
              <th className="p-2.5 font-medium w-10"></th>
            </tr>
          </thead>
          <tbody>
            {candidates?.map((c) => (
              <tr key={c.id} className="border-b border-border last:border-0 hover:bg-surface-1">
                <td className="p-2.5"><input type="checkbox" checked={selectedCandidateIds.has(c.id)} onChange={() => toggleCandidate(c.id)} /></td>
                <td className="p-2.5 font-mono">{c.ip_address}</td>
                <td className="p-2.5 text-text-secondary truncate max-w-xs">{c.sys_descr || "—"}</td>
                <td className="p-2.5 text-text-secondary">{c.interface_count ?? "—"}</td>
                <td className="p-2.5 text-text-secondary">{c.rule_name || "—"}</td>
                <td className="p-2.5 text-text-muted text-xs">{timeSince(c.first_seen_at)} / {timeSince(c.last_seen_at)}</td>
                <td className="p-2.5">
                  <button onClick={() => dismissCandidate.mutate(c.id)} title="Yoksay" className="text-text-muted hover:text-[var(--text-danger)]">
                    <X size={14} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!candidatesLoading && candidates?.length === 0 && (
          <p className="text-sm text-text-muted p-4">Henüz bulunan/eklenmeyi bekleyen cihaz yok.</p>
        )}
      </div>

      {showForm && (
        <RuleFormModal
          rule={editingRule}
          onClose={() => setShowForm(false)}
          onSubmit={(input) => {
            if (editingRule) {
              updateRule.mutate({ id: editingRule.id, input }, { onSuccess: () => setShowForm(false) });
            } else {
              createRule.mutate(input, { onSuccess: () => setShowForm(false) });
            }
          }}
          isPending={createRule.isPending || updateRule.isPending}
          error={(createRule.error || updateRule.error) as Error | null}
        />
      )}
    </div>
  );
}

function RuleProgress({ job, onRun, isStarting, error }: { job?: ScanJob; onRun: () => void; isStarting: boolean; error?: string }) {
  if (!job || job.status !== "running") {
    return (
      <div>
        <button
          onClick={onRun}
          disabled={isStarting}
          className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md border border-border-strong hover:bg-surface-1 disabled:opacity-50"
        >
          <Radar size={13} className={isStarting ? "animate-spin" : ""} />
          Şimdi çalıştır
        </button>
        {error && <p className="text-[11px] text-[var(--text-danger)] mt-1 max-w-56">{error}</p>}
      </div>
    );
  }

  const isPing = job.phase === "ping";
  const total = isPing ? job.pingTotal : job.snmpTotal;
  const scanned = isPing ? job.pingScanned : job.snmpScanned;
  const percent = total > 0 ? Math.round((scanned / total) * 100) : 0;

  return (
    <div className="w-56">
      <div className="flex items-center justify-between text-[11px] text-text-secondary mb-1">
        <span>{isPing ? "Ping taraması..." : "SNMP keşfi..."}</span>
        <span>{scanned} / {total}</span>
      </div>
      <div className="h-1.5 bg-surface-0 rounded-full overflow-hidden">
        <div className="h-full bg-[var(--text-accent)] transition-all" style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}

function RuleFormModal({
  rule, onClose, onSubmit, isPending, error
}: {
  rule: DiscoveryRule | null;
  onClose: () => void;
  onSubmit: (input: DiscoveryRuleInput) => void;
  isPending: boolean;
  error: Error | null;
}) {
  const [name, setName] = useState(rule?.name ?? "");
  const [cidrText, setCidrText] = useState(rule?.cidr_ranges.join("\n") ?? "172.28.0.0/24");
  const [snmpVersion, setSnmpVersion] = useState<"v2c" | "v3">(rule?.snmp_version ?? "v2c");
  const [community, setCommunity] = useState(rule?.snmp_community ?? "public");
  const [v3Username, setV3Username] = useState(rule?.snmp_v3_username ?? "");
  const [v3Level, setV3Level] = useState<SnmpV3Level>(rule?.snmp_v3_level ?? "authPriv");
  const [v3AuthProtocol, setV3AuthProtocol] = useState<SnmpAuthProtocol>(rule?.snmp_v3_auth_protocol ?? "sha");
  const [v3AuthKey, setV3AuthKey] = useState("");
  const [v3PrivProtocol, setV3PrivProtocol] = useState<SnmpPrivProtocol>(rule?.snmp_v3_priv_protocol ?? "aes");
  const [v3PrivKey, setV3PrivKey] = useState("");
  const [scheduled, setScheduled] = useState(rule ? rule.schedule_interval_hours !== null : false);
  const [scheduleHours, setScheduleHours] = useState(rule?.schedule_interval_hours ?? 24);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const cidr_ranges = cidrText.split(/[\n,]/).map((s) => s.trim()).filter(Boolean);

    const input: DiscoveryRuleInput = {
      name,
      cidr_ranges,
      snmp_version: snmpVersion,
      schedule_interval_hours: scheduled ? scheduleHours : null
    };
    if (snmpVersion === "v2c") {
      input.snmp_community = community;
    } else {
      input.snmp_v3 = {
        username: v3Username,
        level: v3Level,
        authProtocol: v3Level !== "noAuthNoPriv" ? v3AuthProtocol : undefined,
        authKey: v3AuthKey || undefined,
        privProtocol: v3Level === "authPriv" ? v3PrivProtocol : undefined,
        privKey: v3PrivKey || undefined
      };
    }
    onSubmit(input);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <form onSubmit={handleSubmit} onClick={(e) => e.stopPropagation()} className="bg-surface-2 border border-border rounded-xl p-5 w-[520px] max-h-[85vh] overflow-y-auto flex flex-col gap-3">
        <div className="flex items-center justify-between mb-1">
          <h2 className="text-base font-medium">{rule ? "Kuralı düzenle" : "Yeni keşif kuralı"}</h2>
          <button type="button" onClick={onClose} className="text-text-muted"><X size={18} /></button>
        </div>

        <label className="text-xs text-text-secondary">
          Kural adı
          <input value={name} onChange={(e) => setName(e.target.value)} required className="mt-1 w-full px-2.5 py-1.5 text-sm rounded-md border border-border bg-surface-1" />
        </label>

        <label className="text-xs text-text-secondary">
          CIDR aralıkları (her satıra bir tane)
          <textarea
            value={cidrText}
            onChange={(e) => setCidrText(e.target.value)}
            required
            rows={3}
            placeholder={"172.28.0.0/24\n10.0.5.0/22"}
            className="mt-1 w-full px-2.5 py-1.5 text-sm font-mono rounded-md border border-border bg-surface-1"
          />
        </label>

        <div className="flex gap-1 bg-surface-1 rounded-md p-1 border border-border w-fit">
          <button type="button" onClick={() => setSnmpVersion("v2c")} className={`text-xs px-3 py-1.5 rounded ${snmpVersion === "v2c" ? "bg-[var(--bg-accent)] text-[var(--text-accent)] font-medium" : "text-text-secondary"}`}>
            SNMP v2c
          </button>
          <button type="button" onClick={() => setSnmpVersion("v3")} className={`text-xs px-3 py-1.5 rounded ${snmpVersion === "v3" ? "bg-[var(--bg-accent)] text-[var(--text-accent)] font-medium" : "text-text-secondary"}`}>
            SNMP v3
          </button>
        </div>

        {snmpVersion === "v2c" ? (
          <label className="text-xs text-text-secondary">
            Community
            <input value={community} onChange={(e) => setCommunity(e.target.value)} className="mt-1 w-full px-2.5 py-1.5 text-sm rounded-md border border-border bg-surface-1" />
          </label>
        ) : (
          <div className="flex flex-col gap-2 bg-surface-1 border border-border rounded-lg p-3">
            <label className="text-xs text-text-secondary">
              Kullanıcı adı
              <input value={v3Username} onChange={(e) => setV3Username(e.target.value)} required className="mt-1 w-full px-2.5 py-1.5 text-sm rounded-md border border-border bg-surface-2" />
            </label>
            <label className="text-xs text-text-secondary">
              Güvenlik seviyesi
              <select value={v3Level} onChange={(e) => setV3Level(e.target.value as SnmpV3Level)} className="mt-1 w-full px-2.5 py-1.5 text-sm rounded-md border border-border bg-surface-2">
                {V3_LEVELS.map((l) => <option key={l.value} value={l.value}>{l.label}</option>)}
              </select>
            </label>
            {v3Level !== "noAuthNoPriv" && (
              <div className="flex gap-2">
                <label className="text-xs text-text-secondary flex-1">
                  Auth protokolü
                  <select value={v3AuthProtocol} onChange={(e) => setV3AuthProtocol(e.target.value as SnmpAuthProtocol)} className="mt-1 w-full px-2.5 py-1.5 text-sm rounded-md border border-border bg-surface-2">
                    {AUTH_PROTOCOLS.map((p) => <option key={p} value={p}>{p}</option>)}
                  </select>
                </label>
                <label className="text-xs text-text-secondary flex-1">
                  Auth anahtarı
                  <input type="password" value={v3AuthKey} onChange={(e) => setV3AuthKey(e.target.value)} placeholder={rule ? "değiştirmek için doldurun" : ""} className="mt-1 w-full px-2.5 py-1.5 text-sm rounded-md border border-border bg-surface-2" />
                </label>
              </div>
            )}
            {v3Level === "authPriv" && (
              <div className="flex gap-2">
                <label className="text-xs text-text-secondary flex-1">
                  Priv protokolü
                  <select value={v3PrivProtocol} onChange={(e) => setV3PrivProtocol(e.target.value as SnmpPrivProtocol)} className="mt-1 w-full px-2.5 py-1.5 text-sm rounded-md border border-border bg-surface-2">
                    {PRIV_PROTOCOLS.map((p) => <option key={p} value={p}>{p}</option>)}
                  </select>
                </label>
                <label className="text-xs text-text-secondary flex-1">
                  Priv anahtarı
                  <input type="password" value={v3PrivKey} onChange={(e) => setV3PrivKey(e.target.value)} placeholder={rule ? "değiştirmek için doldurun" : ""} className="mt-1 w-full px-2.5 py-1.5 text-sm rounded-md border border-border bg-surface-2" />
                </label>
              </div>
            )}
            <p className="text-[11px] text-text-muted">
              Bilinen sınırlama: platform şu an sürekli SNMP izleme için sadece v2c community destekliyor.
              v3 ile bulunan bir cihazı eklerken sürekli izleme için ayrıca bir v2c community girmeniz gerekebilir.
            </p>
          </div>
        )}

        <label className="flex items-center gap-2 text-xs text-text-secondary cursor-pointer">
          <input type="checkbox" checked={scheduled} onChange={(e) => setScheduled(e.target.checked)} />
          Otomatik/periyodik tarama
        </label>
        {scheduled && (
          <label className="text-xs text-text-secondary flex items-center gap-2">
            Her
            <input type="number" min={1} max={8760} value={scheduleHours} onChange={(e) => setScheduleHours(Number(e.target.value))} className="w-20 px-2 py-1 text-sm rounded-md border border-border bg-surface-1" />
            saatte bir çalıştır
          </label>
        )}

        {error && <p className="text-sm text-[var(--text-danger)]">{error.message}</p>}

        <button type="submit" disabled={isPending} className="mt-2 py-2 text-sm rounded-md bg-[var(--text-accent)] text-white disabled:opacity-50">
          {isPending ? "Kaydediliyor..." : rule ? "Kaydet" : "Kuralı oluştur"}
        </button>
      </form>
    </div>
  );
}
