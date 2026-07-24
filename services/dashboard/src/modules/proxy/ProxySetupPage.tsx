import { useState } from "react";
import { Copy, Check, Plus, Ban } from "lucide-react";
import {
  useProxyRegistrationTokens,
  useCreateProxyRegistrationToken,
  useDeleteProxyRegistrationToken
} from "./useProxies";

// Monitoring Proxy kurulum sayfası -- AgentRegistrationPage'in proxy karşılığı, aynı
// desen: tek kullanımlık bir token üret, kurulum komutunu kopyala, uzak/segmentli
// sitedeki sunucuda çalıştır. Agent'ın aksine token BİR SİTEYE özeldir (1 proxy = 1 site,
// kullanıcıyla konuşulup kararlaştırılan tasarım) -- bu yüzden site adı hem token'ın
// adı hem de kurulum komutundaki --name parametresi olarak kullanılır.
export function ProxySetupPage() {
  const { data: tokens, isLoading } = useProxyRegistrationTokens();
  const createToken = useCreateProxyRegistrationToken();
  const deleteToken = useDeleteProxyRegistrationToken();

  const [siteName, setSiteName] = useState("");
  const [generatedToken, setGeneratedToken] = useState<string | null>(null);
  const [generatedSiteName, setGeneratedSiteName] = useState("");
  const [copied, setCopied] = useState(false);

  function handleCreateToken(e: React.FormEvent) {
    e.preventDefault();
    createToken.mutate(siteName, {
      onSuccess: (result) => {
        setGeneratedToken(result.token);
        setGeneratedSiteName(siteName);
        setSiteName("");
      }
    });
  }

  const coreUrl = `${window.location.protocol}//${window.location.hostname}:8080`;
  const installCommand = generatedToken
    ? `curl -fsSL ${coreUrl}/install-proxy.sh | bash -s -- --token=${generatedToken} --core-url=${coreUrl} --name="${generatedSiteName}"`
    : "";

  function copyInstallCommand() {
    navigator.clipboard.writeText(installCommand);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="p-6 max-w-3xl">
      <div className="mb-4">
        <h1 className="text-lg font-semibold">Proxy Kurulumu</h1>
        <p className="text-xs text-text-secondary mt-1">
          Uzak/segmentli bir sitede bir izleme proxy'si kuracaksan, önce o site için tek kullanımlık bir
          token oluştur, sonra üretilen komutu o siteki sunucuda çalıştır. Proxy kendi kendine kaydolur,
          bir daha bu token'a ihtiyaç duymaz. 1 proxy = 1 site (aynı token birden fazla proxy için
          kullanılamaz).
        </p>
      </div>

      <form onSubmit={handleCreateToken} className="bg-surface-2 border border-border rounded-2xl p-4 mb-4 flex items-center gap-2">
        <input
          value={siteName}
          onChange={(e) => setSiteName(e.target.value)}
          placeholder="Site adı (örn. Ankara-DC2, İstanbul-Şube)"
          required
          className="flex-1 px-2.5 py-1.5 text-sm rounded-md border border-border bg-surface-1"
        />
        <button type="submit" className="flex items-center gap-1.5 px-3.5 py-2 text-sm rounded-lg bg-[var(--text-accent)] text-white hover:opacity-90">
          <Plus size={15} />
          Token Oluştur
        </button>
      </form>

      {generatedToken && (
        <div className="bg-surface-2 border border-border rounded-2xl p-3 mb-4">
          <p className="text-xs text-text-muted mb-1.5">Kurulum komutu (bu token bir daha gösterilmeyecek):</p>
          <div className="flex items-start gap-2">
            <pre className="flex-1 text-[11px] bg-surface-0 p-2 rounded overflow-x-auto whitespace-pre-wrap">{installCommand}</pre>
            <button onClick={copyInstallCommand} className="shrink-0 text-text-muted hover:text-text-accent">
              {copied ? <Check size={15} /> : <Copy size={15} />}
            </button>
          </div>
          <p className="text-[10px] text-text-muted mt-2">
            Bu komut, sitedeki sunucuda (Docker yoksa otomatik kurar) proxy + kendi yerel Postgres'ini
            içeren bir stack başlatır. Kurulum bittikten sonra proxy aşağıdaki listede "aktif" olarak görünür.
          </p>
        </div>
      )}

      {isLoading ? (
        <p className="text-sm text-text-secondary">Yükleniyor...</p>
      ) : tokens && tokens.length > 0 ? (
        <div className="border border-border rounded-2xl overflow-hidden">
          <div className="flex items-center gap-2 text-[10px] text-text-muted uppercase tracking-wide px-3 py-2 border-b border-border bg-surface-1/60">
            <span className="flex-1">Site</span>
            <span className="w-24 shrink-0">Durum</span>
            <span className="w-8 shrink-0" />
          </div>
          {tokens.map((t) => (
            <div key={t.id} className="flex items-center gap-2 px-3 py-2.5 border-b border-border last:border-0 text-xs">
              <span className="flex-1">{t.name}</span>
              <span
                className={`w-24 shrink-0 ${
                  t.revoked_at ? "text-[var(--text-danger)]" : t.used_at ? "text-[var(--text-success)]" : "text-text-secondary"
                }`}
              >
                {t.revoked_at ? "İptal edildi" : t.used_at ? "Kullanıldı" : "Bekliyor"}
              </span>
              <span className="w-8 shrink-0 flex justify-end">
                {!t.revoked_at && !t.used_at && (
                  <button onClick={() => deleteToken.mutate(t.id)} className="text-text-muted hover:text-[var(--text-danger)]" title="İptal et">
                    <Ban size={13} />
                  </button>
                )}
              </span>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-sm text-text-muted">Henüz bir proxy kayıt token'ı oluşturulmadı.</p>
      )}
    </div>
  );
}
