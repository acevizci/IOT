import { useState } from "react";
import { Copy, Check, Plus, Ban } from "lucide-react";
import { useAgentRegistrationTokens, useCreateAgentRegistrationToken, useDeleteAgentRegistrationToken } from "../devices/useDevices";
import { useProxies } from "../proxy/useProxies";

// Agent kayıt token'ları HİÇBİR cihaza özel değil — bir token oluşturup HANGİ
// makinede kullanırsan, o makine KENDİ ADIYLA otomatik yeni bir cihaz olarak
// kaydolur. Önceden bunun (kafa karıştırıcı biçimde) rastgele bir cihazın "Agent"
// sekmesinden yapılması gerekiyordu; artık bağımsız, cihazdan bağımsız bir sayfa.
export function AgentRegistrationPage() {
  const { data: tokens, isLoading } = useAgentRegistrationTokens();
  const { data: proxies } = useProxies();
  const createToken = useCreateAgentRegistrationToken();
  const deleteToken = useDeleteAgentRegistrationToken();

  const [newTokenName, setNewTokenName] = useState("");
  const [generatedToken, setGeneratedToken] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  // Monitoring Proxy: bu site'daki cihazlar bir proxy üzerinden rapor verecekse,
  // kurulum komutundaki server_url doğrudan core yerine seçilen proxy'nin adresini
  // gösterir -- agent kodunda hiçbir değişiklik gerekmez, sadece bu tek alan.
  const [selectedProxyId, setSelectedProxyId] = useState("");
  const selectedProxy = proxies?.find((p) => p.id === selectedProxyId);
  const serverUrl = selectedProxy?.address ? `http://${selectedProxy.address}` : `${window.location.protocol}//${window.location.hostname}:8080`;

  function handleCreateToken(e: React.FormEvent) {
    e.preventDefault();
    createToken.mutate(newTokenName, {
      onSuccess: (result) => {
        setGeneratedToken(result.token);
        setNewTokenName("");
      }
    });
  }

  function copyInstallCommand() {
    const command = `echo '{"server_url":"${serverUrl}","registration_token":"${generatedToken}","hostname":"'$(hostname)'"}' > agent_config.json\n./observability-agent`;
    navigator.clipboard.writeText(command);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="p-6 max-w-3xl">
      <div className="mb-4">
        <h1 className="text-lg font-semibold">Agent Kaydı</h1>
        <p className="text-xs text-text-secondary mt-1">
          Bir token oluştur, agent'ı bir makinede bu token'la kurulum komutuyla çalıştır — makine kendi
          adıyla otomatik olarak yeni bir cihaz olarak kaydolur. Token hiçbir cihaza özel değildir, aynı
          token'ı birden fazla makinede kullanabilirsin.
        </p>
      </div>

      <form onSubmit={handleCreateToken} className="bg-surface-2 border border-border rounded-2xl p-4 mb-4 flex items-center gap-2">
        <input
          value={newTokenName}
          onChange={(e) => setNewTokenName(e.target.value)}
          placeholder="Token adı (örn. Prod Sunucuları, Windows Test)"
          required
          className="flex-1 px-2.5 py-1.5 text-sm rounded-md border border-border bg-surface-1"
        />
        <button type="submit" className="flex items-center gap-1.5 px-3.5 py-2 text-sm rounded-lg bg-[var(--text-accent)] text-white hover:opacity-90">
          <Plus size={15} />
          Token Oluştur
        </button>
      </form>

      {proxies && proxies.length > 0 && (
        <div className="mb-4">
          <label className="text-xs text-text-secondary mb-1 block">
            Bu cihazlar bir proxy üzerinden mi rapor verecek? (opsiyonel)
          </label>
          <select
            value={selectedProxyId}
            onChange={(e) => setSelectedProxyId(e.target.value)}
            className="w-full px-2.5 py-1.5 text-sm rounded-md border border-border bg-surface-1"
          >
            <option value="">Doğrudan (proxy yok)</option>
            {proxies.map((p) => (
              <option key={p.id} value={p.id} disabled={!p.address}>
                {p.name}{!p.address ? " (adres tanımlı değil)" : ""}
              </option>
            ))}
          </select>
        </div>
      )}

      {generatedToken && (
        <div className="bg-surface-2 border border-border rounded-2xl p-3 mb-4">
          <p className="text-xs text-text-muted mb-1.5">Kurulum komutu (bu token bir daha gösterilmeyecek):</p>
          <div className="flex items-start gap-2">
            <pre className="flex-1 text-[11px] bg-surface-0 p-2 rounded overflow-x-auto whitespace-pre-wrap">
              {`echo '{"server_url":"${serverUrl}","registration_token":"${generatedToken}","hostname":"'$(hostname)'"}' > agent_config.json\n./observability-agent`}
            </pre>
            <button onClick={copyInstallCommand} className="shrink-0 text-text-muted hover:text-text-accent">
              {copied ? <Check size={15} /> : <Copy size={15} />}
            </button>
          </div>
          <p className="text-[10px] text-text-muted mt-2">
            Windows'ta çalıştırmak için: aynı JSON'u <code>agent_config.json</code> olarak kaydet
            (PowerShell'in <code>Out-File</code>'ı yerine BOM eklemeyen bir yöntem kullan), sonra
            <code> .\iot-observability-agent.exe</code> ile çalıştır.
          </p>
        </div>
      )}

      {isLoading ? (
        <p className="text-sm text-text-secondary">Yükleniyor...</p>
      ) : tokens && tokens.length > 0 ? (
        <div className="border border-border rounded-2xl overflow-hidden">
          <div className="flex items-center gap-2 text-[10px] text-text-muted uppercase tracking-wide px-3 py-2 border-b border-border bg-surface-1/60">
            <span className="flex-1">Ad</span>
            <span className="w-24 shrink-0">Durum</span>
            <span className="w-8 shrink-0" />
          </div>
          {tokens.map((t) => (
            <div key={t.id} className="flex items-center gap-2 px-3 py-2.5 border-b border-border last:border-0 text-xs">
              <span className="flex-1">{t.name}</span>
              <span className={`w-24 shrink-0 ${t.revoked_at ? "text-[var(--text-danger)]" : "text-[var(--text-success)]"}`}>
                {t.revoked_at ? "İptal edildi" : "Aktif"}
              </span>
              <span className="w-8 shrink-0 flex justify-end">
                {!t.revoked_at && (
                  <button onClick={() => deleteToken.mutate(t.id)} className="text-text-muted hover:text-[var(--text-danger)]" title="İptal et">
                    <Ban size={13} />
                  </button>
                )}
              </span>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-sm text-text-muted">Henüz bir kayıt token'ı oluşturulmadı.</p>
      )}
    </div>
  );
}
