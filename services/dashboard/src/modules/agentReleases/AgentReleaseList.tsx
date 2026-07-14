import { useState } from "react";
import { Plus, Download } from "lucide-react";
import { useAgentReleases, usePublishAgentRelease } from "./useAgentReleases";

const PLATFORM_OPTIONS = ["linux_amd64", "linux_arm64", "windows_amd64", "darwin_amd64", "darwin_arm64"];

// Agent'ın kendi kendini güncelleme mekanizması (selfupdate.go) için sürüm yayınlama
// ekranı. Sunucudaki bir dizine önceden yerleştirilmiş bir binary'nin YOLUNU verirsin
// (dosya yükleme değil) — MVP akışı, backend zaten checksum'ı kendisi hesaplıyor.
export function AgentReleaseList() {
  const { data: releases, isLoading } = useAgentReleases();
  const publish = usePublishAgentRelease();

  const [showForm, setShowForm] = useState(false);
  const [version, setVersion] = useState("");
  const [platform, setPlatform] = useState(PLATFORM_OPTIONS[0]);
  const [filePath, setFilePath] = useState("");
  const [error, setError] = useState<string | null>(null);

  function handlePublish(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    publish.mutate(
      { version, platform, file_path: filePath },
      {
        onSuccess: () => {
          setVersion("");
          setFilePath("");
          setShowForm(false);
        },
        onError: (err: any) => setError(err?.message || "Yayınlama başarısız")
      }
    );
  }

  return (
    <div className="p-6 max-w-3xl">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-lg font-semibold">Agent Sürümleri</h1>
          <p className="text-xs text-text-secondary mt-1">
            Agent'lar kendi kendini günceller (günde bir kez kontrol eder) — burada yayınlanan en yeni sürümü
            algılayıp otomatik indirir.
          </p>
        </div>
        <button
          onClick={() => setShowForm((v) => !v)}
          className="flex items-center gap-1.5 text-sm px-3.5 py-2 rounded-lg bg-[var(--text-accent)] text-white hover:opacity-90"
        >
          <Plus size={15} />
          Yeni Sürüm Yayınla
        </button>
      </div>

      {showForm && (
        <form onSubmit={handlePublish} className="bg-surface-2 border border-border rounded-2xl p-4 mb-4 flex flex-col gap-2.5">
          <div className="flex items-center gap-2">
            <span className="text-xs text-text-muted w-20 shrink-0">Sürüm</span>
            <input
              value={version}
              onChange={(e) => setVersion(e.target.value)}
              placeholder="örn. 0.2.0"
              required
              className="flex-1 px-2.5 py-1.5 text-sm rounded-md border border-border bg-surface-1"
            />
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-text-muted w-20 shrink-0">Platform</span>
            <select
              value={platform}
              onChange={(e) => setPlatform(e.target.value)}
              className="flex-1 px-2.5 py-1.5 text-sm rounded-md border border-border bg-surface-1"
            >
              {PLATFORM_OPTIONS.map((p) => (
                <option key={p} value={p}>{p}</option>
              ))}
            </select>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-text-muted w-20 shrink-0">Dosya yolu</span>
            <input
              value={filePath}
              onChange={(e) => setFilePath(e.target.value)}
              placeholder="/opt/agent-releases/iot-observability-agent-0.2.0-linux_amd64"
              required
              className="flex-1 px-2.5 py-1.5 text-sm rounded-md border border-border bg-surface-1 font-mono"
            />
          </div>
          <p className="text-[10px] text-text-muted">
            Binary'nin bu yolda sunucuda önceden yerleştirilmiş olması gerekir — burası bir dosya yükleme formu değil.
            Checksum (SHA-256) sunucu tarafında otomatik hesaplanır.
          </p>
          {error && <p className="text-xs text-[var(--text-danger)]">{error}</p>}
          <div className="flex items-center gap-2 justify-end mt-1">
            <button type="button" onClick={() => setShowForm(false)} className="px-3 py-1.5 text-sm rounded-md text-text-secondary hover:bg-surface-1">
              Vazgeç
            </button>
            <button type="submit" disabled={publish.isPending} className="px-3 py-1.5 text-sm rounded-md bg-[var(--text-accent)] text-white disabled:opacity-50">
              Yayınla
            </button>
          </div>
        </form>
      )}

      {isLoading ? (
        <p className="text-sm text-text-secondary">Yükleniyor...</p>
      ) : releases && releases.length > 0 ? (
        <div className="border border-border rounded-2xl overflow-hidden">
          <div className="flex items-center gap-2 text-[10px] text-text-muted uppercase tracking-wide px-3 py-2 border-b border-border bg-surface-1/60">
            <span className="w-20 shrink-0">Sürüm</span>
            <span className="w-32 shrink-0">Platform</span>
            <span className="flex-1">Checksum (SHA-256)</span>
            <span className="w-32 shrink-0 text-right">Yayın tarihi</span>
          </div>
          {releases.map((r) => (
            <div key={r.id} className="flex items-center gap-2 px-3 py-2.5 border-b border-border last:border-0 text-xs">
              <span className="w-20 shrink-0 font-medium">{r.version}</span>
              <span className="w-32 shrink-0 text-text-secondary">{r.platform}</span>
              <span className="flex-1 font-mono text-[10px] text-text-muted truncate">{r.sha256_checksum}</span>
              <span className="w-32 shrink-0 text-right text-text-muted">{new Date(r.released_at).toLocaleDateString("tr-TR")}</span>
            </div>
          ))}
        </div>
      ) : (
        <div className="flex flex-col items-center justify-center py-16 text-center border-2 border-dashed border-border rounded-2xl">
          <Download size={28} className="text-text-muted mb-3" />
          <p className="text-sm font-medium mb-1">Henüz bir agent sürümü yayınlanmadı</p>
        </div>
      )}
    </div>
  );
}
