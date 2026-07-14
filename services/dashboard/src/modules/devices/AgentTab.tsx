import { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import { CircleCheck, CircleX, Circle, ArrowRight } from "lucide-react";
import { useDeviceAgentStatus, useAgentPluginConfig, useUpdateAgentPluginConfig } from "./useDevices";
import type { AgentPluginConfig } from "../../api/devices";

function timeSince(dateStr: string | null): string {
  if (!dateStr) return "hiç";
  const seconds = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (seconds < 60) return `${seconds} saniye önce`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} dakika önce`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} saat önce`;
  return `${Math.floor(seconds / 86400)} gün önce`;
}

// Bu sekme SADECE bu cihazın kendi agent durumunu + plugin ayarlarını gösterir.
// Yeni bir agent KURMAK (token oluşturmak) artık cihazdan bağımsız, merkezi bir
// sayfada ("Agent Kaydı") -- token hiçbir cihaza özel olmadığı için bunu rastgele
// bir cihazın sekmesinden yapmak kafa karıştırıcıydı (bkz. bu UX'i düzeltme kararı).
export function AgentTab({ deviceId }: { deviceId: string }) {
  const { data: agentStatus, isLoading } = useDeviceAgentStatus(deviceId);

  const { data: pluginConfig } = useAgentPluginConfig(deviceId);
  const updatePluginConfig = useUpdateAgentPluginConfig(deviceId);
  const [dockerEndpoint, setDockerEndpoint] = useState("");
  const [postgresUri, setPostgresUri] = useState("");
  const [redisAddress, setRedisAddress] = useState("");
  const [pluginSaved, setPluginSaved] = useState(false);

  useEffect(() => {
    if (pluginConfig) {
      setDockerEndpoint(pluginConfig.docker?.endpoint || "");
      setPostgresUri(pluginConfig.postgres?.uri || "");
      setRedisAddress(pluginConfig.redis?.address || "");
    }
  }, [pluginConfig]);

  function handleSavePluginConfig(e: React.FormEvent) {
    e.preventDefault();
    const config: AgentPluginConfig = {};
    if (dockerEndpoint) config.docker = { endpoint: dockerEndpoint };
    if (postgresUri) config.postgres = { uri: postgresUri };
    if (redisAddress) config.redis = { address: redisAddress };
    updatePluginConfig.mutate(config, {
      onSuccess: () => {
        setPluginSaved(true);
        setTimeout(() => setPluginSaved(false), 2000);
      }
    });
  }

  // Heartbeat'ten 30 saniyeden daha uzun süre geçtiyse "erişilemiyor" say (agent'ın
  // varsayılan heartbeat aralığı 10sn — bunun 3 katı makul bir eşik).
  const isHeartbeatStale = agentStatus?.last_heartbeat_at
    ? Date.now() - new Date(agentStatus.last_heartbeat_at).getTime() > 30000
    : true;

  return (
    <div className="flex flex-col gap-5">
      <div>
        <p className="text-sm font-medium mb-2">Agent Durumu</p>
        {isLoading ? (
          <p className="text-xs text-text-muted">Yükleniyor...</p>
        ) : !agentStatus?.is_agent_registered ? (
          <div className="flex flex-col items-start gap-2">
            <div className="flex items-center gap-2 text-sm text-text-muted">
              <Circle size={14} />
              Bu cihaza henüz bir agent kurulmamış.
            </div>
            <Link to="/agent-registration" className="flex items-center gap-1 text-xs text-text-accent hover:underline">
              Agent Kaydı sayfasından bir kurulum token'ı oluştur
              <ArrowRight size={12} />
            </Link>
          </div>
        ) : (
          <div className="bg-surface-1 border border-border rounded-xl p-4 flex flex-col gap-2">
            <div className="flex items-center gap-2">
              {isHeartbeatStale ? (
                <CircleX size={15} className="text-[var(--text-danger)]" />
              ) : (
                <CircleCheck size={15} className="text-[var(--text-success)]" />
              )}
              <span className="text-sm font-medium">{isHeartbeatStale ? "Erişilemiyor" : "Aktif"}</span>
            </div>
            <div className="grid grid-cols-2 gap-2 text-xs text-text-secondary">
              <div>
                <p className="text-text-muted">Son heartbeat</p>
                <p>{timeSince(agentStatus.last_heartbeat_at)}</p>
              </div>
              <div>
                <p className="text-text-muted">Son metrik gönderimi</p>
                <p>{timeSince(agentStatus.last_agent_checkin)}</p>
              </div>
              <div>
                <p className="text-text-muted">Agent sürümü</p>
                <p>{agentStatus.agent_version || "-"}</p>
              </div>
            </div>
          </div>
        )}
      </div>

      {agentStatus?.is_agent_registered && (
        <div>
          <p className="text-sm font-medium mb-1">Plugin Bağlantıları</p>
          <p className="text-xs text-text-secondary mb-3">
            Docker/PostgreSQL/Redis'e izleme için nasıl bağlanılacağı. Buradaki bir değişiklik,
            agent'ın bir sonraki senkronizasyon turunda otomatik uygulanır, agent'ı yeniden
            başlatmaya gerek yok.
          </p>
          <form onSubmit={handleSavePluginConfig} className="flex flex-col gap-2.5">
            <div className="flex items-center gap-2">
              <span className="text-xs text-text-muted w-24 shrink-0">Docker socket</span>
              <input
                value={dockerEndpoint}
                onChange={(e) => setDockerEndpoint(e.target.value)}
                placeholder="unix:///var/run/docker.sock"
                className="flex-1 px-2.5 py-1.5 text-sm rounded-md border border-border bg-surface-1"
              />
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-text-muted w-24 shrink-0">PostgreSQL URI</span>
              <input
                value={postgresUri}
                onChange={(e) => setPostgresUri(e.target.value)}
                placeholder="postgres://kullanici:sifre@host:5432/db"
                type={postgresUri === "••••••••" ? "password" : "text"}
                className="flex-1 px-2.5 py-1.5 text-sm rounded-md border border-border bg-surface-1"
              />
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-text-muted w-24 shrink-0">Redis adresi</span>
              <input
                value={redisAddress}
                onChange={(e) => setRedisAddress(e.target.value)}
                placeholder="localhost:6379"
                className="flex-1 px-2.5 py-1.5 text-sm rounded-md border border-border bg-surface-1"
              />
            </div>
            <div className="flex items-center gap-2 justify-end mt-1">
              {pluginSaved && <span className="text-xs text-[var(--text-success)]">Kaydedildi</span>}
              <button type="submit" disabled={updatePluginConfig.isPending} className="px-3 py-1.5 text-sm rounded-md bg-[var(--text-accent)] text-white disabled:opacity-50">
                Kaydet
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
