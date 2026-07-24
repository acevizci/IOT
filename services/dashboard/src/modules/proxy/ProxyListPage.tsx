import { useState } from "react";
import { Settings2, Wifi, Loader2, Trash2 } from "lucide-react";
import { useProxies, useUpdateProxy, useDeleteProxy, useTestProxyConnection } from "./useProxies";
import type { Proxy } from "../../api/proxies";

function timeSince(dateStr: string | null): string {
  if (!dateStr) return "hiç";
  const seconds = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (seconds < 60) return `${seconds}sn önce`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}dk önce`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}s önce`;
  return `${Math.floor(seconds / 86400)}g önce`;
}

const STATUS_LABEL: Record<Proxy["status"], string> = { active: "Aktif", down: "Erişilemez", pending: "Kayıt bekleniyor" };
const STATUS_STYLE: Record<Proxy["status"], string> = {
  active: "text-[var(--text-success)]",
  down: "text-[var(--text-danger)]",
  pending: "text-text-muted"
};

// Proxy listesi + durum + ayar paneli -- kullanıcıyla konuşulup kararlaştırılan
// tasarımın Dashboard tarafı: her proxy'nin sağlığı (heartbeat/kuyruk derinliği),
// bağlantı testi ve site-özel ince ayarları (flush/heartbeat aralığı, kuyruk limiti,
// kayıtlı adres) burada yönetilir.
export function ProxyListPage() {
  const { data: proxies, isLoading } = useProxies();
  const [editingId, setEditingId] = useState<string | null>(null);

  return (
    <div className="p-6 max-w-4xl">
      <div className="mb-4">
        <h1 className="text-lg font-semibold">Proxy'ler</h1>
        <p className="text-xs text-text-secondary mt-1">
          Uzak/segmentli sitelerde çalışan izleme proxy'lerinin durumu, bağlı cihaz sayısı ve merkeze
          senkronizasyon durumu. Kuyruk derinliği sürekli büyüyorsa (heartbeat gelmeye devam etse bile)
          proxy merkeze senkronize olamıyor demektir.
        </p>
      </div>

      {isLoading ? (
        <p className="text-sm text-text-secondary">Yükleniyor...</p>
      ) : proxies && proxies.length > 0 ? (
        <div className="space-y-3">
          {proxies.map((p) =>
            editingId === p.id ? (
              <ProxyEditCard key={p.id} proxy={p} onClose={() => setEditingId(null)} />
            ) : (
              <ProxyCard key={p.id} proxy={p} onEdit={() => setEditingId(p.id)} />
            )
          )}
        </div>
      ) : (
        <p className="text-sm text-text-muted">Henüz bir proxy kaydı yok — "Proxy Kurulumu" sayfasından bir tane kur.</p>
      )}
    </div>
  );
}

function ProxyCard({ proxy, onEdit }: { proxy: Proxy; onEdit: () => void }) {
  const testConnection = useTestProxyConnection();
  const deleteProxy = useDeleteProxy();

  function handleDelete() {
    if (!confirm(`${proxy.name} silinsin mi? Bu proxy'ye atanmış cihazlar doğrudan bağlanmaya döner.`)) return;
    deleteProxy.mutate(proxy.id);
  }

  return (
    <div className="bg-surface-2 border border-border rounded-2xl p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium">{proxy.name}</span>
            <span className={`text-xs ${STATUS_STYLE[proxy.status]}`}>{STATUS_LABEL[proxy.status]}</span>
          </div>
          <p className="text-xs text-text-muted mt-0.5">{proxy.address || "Adres henüz tanımlanmamış"}</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => testConnection.mutate(proxy.id)}
            disabled={testConnection.isPending || !proxy.address}
            className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded-md border border-border hover:bg-surface-1 disabled:opacity-50"
            title="Bağlantıyı Test Et"
          >
            {testConnection.isPending ? <Loader2 size={13} className="animate-spin" /> : <Wifi size={13} />}
            Bağlantıyı Test Et
          </button>
          <button onClick={onEdit} className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded-md border border-border hover:bg-surface-1">
            <Settings2 size={13} />
            Ayarlar
          </button>
          <button
            onClick={handleDelete}
            disabled={deleteProxy.isPending}
            className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded-md border border-border text-[var(--text-danger)] hover:bg-surface-1 disabled:opacity-50"
            title="Sil"
          >
            <Trash2 size={13} />
          </button>
        </div>
      </div>

      {testConnection.isSuccess && (
        <p className={`text-xs mt-2 ${testConnection.data.ok ? "text-[var(--text-success)]" : "text-[var(--text-danger)]"}`}>
          {testConnection.data.ok ? "Bağlantı başarılı." : `Bağlantı başarısız: ${testConnection.data.error || "bilinmeyen hata"}`}
        </p>
      )}

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-3 text-xs">
        <Stat label="Bağlı cihaz" value={String(proxy.connected_device_count)} />
        <Stat label="Bekleyen kuyruk" value={String(proxy.pending_queue_size)} warn={proxy.pending_queue_size > 0 && proxy.status === "active"} />
        <Stat label="Son heartbeat" value={timeSince(proxy.last_heartbeat_at)} />
        <Stat label="Son senkron" value={timeSince(proxy.last_successful_sync_at)} />
      </div>
    </div>
  );
}

function Stat({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div>
      <p className="text-text-muted">{label}</p>
      <p className={warn ? "text-[var(--text-warning)]" : ""}>{value}</p>
    </div>
  );
}

function ProxyEditCard({ proxy, onClose }: { proxy: Proxy; onClose: () => void }) {
  const updateProxy = useUpdateProxy();
  const [address, setAddress] = useState(proxy.address ?? "");
  const [heartbeatSeconds, setHeartbeatSeconds] = useState(String(proxy.heartbeat_seconds));
  const [metricsFlushSeconds, setMetricsFlushSeconds] = useState(String(proxy.metrics_flush_seconds));
  const [queueRetentionLimit, setQueueRetentionLimit] = useState(String(proxy.queue_retention_limit));

  const addressChanged = address !== (proxy.address ?? "");

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    updateProxy.mutate(
      {
        id: proxy.id,
        input: {
          address: address || undefined,
          heartbeat_seconds: Number(heartbeatSeconds),
          metrics_flush_seconds: Number(metricsFlushSeconds),
          queue_retention_limit: Number(queueRetentionLimit)
        }
      },
      { onSuccess: onClose }
    );
  }

  return (
    <form onSubmit={handleSubmit} className="bg-surface-2 border border-border rounded-2xl p-4">
      <p className="text-sm font-medium mb-3">{proxy.name} — Ayarlar</p>

      <FormField label="Adres (host:port)">
        <input value={address} onChange={(e) => setAddress(e.target.value)} placeholder="10.0.0.5:8090" className="w-full px-2.5 py-1.5 text-sm rounded-md border border-border bg-surface-1" />
      </FormField>
      {addressChanged && (
        <p className="text-[11px] text-[var(--text-warning)] mt-1.5">
          Adres değişikliği burada sadece kayıt olarak güncellenir — sitedeki sunucuda gerçek portu
          değiştirmek için <code>.env</code> dosyasını güncelleyip <code>docker compose up -d</code> çalıştırman gerekir.
        </p>
      )}

      <div className="grid grid-cols-3 gap-3 mt-3">
        <FormField label="Heartbeat aralığı (sn)">
          <input type="number" min={1} value={heartbeatSeconds} onChange={(e) => setHeartbeatSeconds(e.target.value)} className="w-full px-2.5 py-1.5 text-sm rounded-md border border-border bg-surface-1" />
        </FormField>
        <FormField label="Metrik flush aralığı (sn)">
          <input type="number" min={1} value={metricsFlushSeconds} onChange={(e) => setMetricsFlushSeconds(e.target.value)} className="w-full px-2.5 py-1.5 text-sm rounded-md border border-border bg-surface-1" />
        </FormField>
        <FormField label="Kuyruk limiti">
          <input type="number" min={1} value={queueRetentionLimit} onChange={(e) => setQueueRetentionLimit(e.target.value)} className="w-full px-2.5 py-1.5 text-sm rounded-md border border-border bg-surface-1" />
        </FormField>
      </div>

      {updateProxy.isError && <p className="text-sm text-[var(--text-danger)] mt-3">{(updateProxy.error as Error).message}</p>}

      <div className="flex items-center gap-2 mt-4">
        <button type="submit" disabled={updateProxy.isPending} className="px-3.5 py-1.5 text-sm rounded-lg bg-[var(--text-accent)] text-white hover:opacity-90 disabled:opacity-50">
          {updateProxy.isPending ? "Kaydediliyor..." : "Kaydet"}
        </button>
        <button type="button" onClick={onClose} className="px-3.5 py-1.5 text-sm rounded-lg border border-border hover:bg-surface-1">
          Vazgeç
        </button>
      </div>
    </form>
  );
}

function FormField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="text-xs text-text-secondary mb-1 block">{label}</label>
      {children}
    </div>
  );
}
