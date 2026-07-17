import { useState } from "react";
import { ChevronDown, ChevronRight, Server, PlugZap } from "lucide-react";
import { useLdapConfig, useUpsertLdapConfig, useTestLdapConfig } from "./useLdapConfig";

export function LdapSettingsPanel() {
  const { data: config } = useLdapConfig();
  const upsert = useUpsertLdapConfig();
  const test = useTestLdapConfig();

  const [expanded, setExpanded] = useState(false);
  const [host, setHost] = useState(config?.host ?? "");
  const [port, setPort] = useState(config?.port ?? 389);
  const [bindDn, setBindDn] = useState(config?.bind_dn ?? "");
  const [bindPassword, setBindPassword] = useState("");
  const [baseDn, setBaseDn] = useState(config?.base_dn ?? "");
  const [userSearchFilter, setUserSearchFilter] = useState(config?.user_search_filter ?? "(uid=%s)");
  const [useTls, setUseTls] = useState(config?.use_tls ?? true);
  const [enabled, setEnabled] = useState(config?.enabled ?? true);

  function handleExpand() {
    if (!expanded && config) {
      setHost(config.host);
      setPort(config.port);
      setBindDn(config.bind_dn);
      setBaseDn(config.base_dn);
      setUserSearchFilter(config.user_search_filter);
      setUseTls(config.use_tls);
      setEnabled(config.enabled);
    }
    setExpanded((v) => !v);
  }

  function handleSave(e: React.FormEvent) {
    e.preventDefault();
    upsert.mutate({
      host, port, bind_dn: bindDn, bind_password: bindPassword,
      base_dn: baseDn, user_search_filter: userSearchFilter, use_tls: useTls, enabled
    }, { onSuccess: () => setBindPassword("") });
  }

  return (
    <div className="border border-border rounded-xl mb-6 overflow-hidden">
      <button onClick={handleExpand} className="w-full flex items-center gap-2 px-4 py-3 text-left hover:bg-surface-1">
        {expanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
        <Server size={15} className="text-text-secondary" />
        <span className="text-sm font-medium flex-1">LDAP ayarları</span>
        {config && (
          <span className={`text-xs px-2 py-0.5 rounded-full border ${config.enabled ? "bg-[var(--bg-success)] text-[var(--text-success)] border-transparent" : "bg-surface-1 text-text-muted border-border"}`}>
            {config.enabled ? "aktif" : "devre dışı"}
          </span>
        )}
        {!config && <span className="text-xs text-text-muted">yapılandırılmadı</span>}
      </button>

      {expanded && (
        <form onSubmit={handleSave} className="p-4 border-t border-border">
          <p className="text-xs text-text-muted mb-3">
            Burada tanımlanan sunucu, "Kullanıcı grupları" listesinde giriş yöntemi "LDAP" seçilen gruplara
            üye kullanıcıların kimlik doğrulamasında kullanılır. Şifreler bizim tarafımızda hiç saklanmaz,
            sadece LDAP sunucusuna iletilir.
          </p>
          <div className="grid grid-cols-2 gap-3 mb-3">
            <div className="flex flex-col gap-1">
              <label className="text-xs text-text-secondary">Sunucu (host)</label>
              <input value={host} onChange={(e) => setHost(e.target.value)} required className="px-2.5 py-1.5 text-sm rounded-md border border-border bg-surface-1" placeholder="ldap.sirket.local" />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs text-text-secondary">Port</label>
              <input type="number" value={port} onChange={(e) => setPort(Number(e.target.value))} required className="px-2.5 py-1.5 text-sm rounded-md border border-border bg-surface-1" />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs text-text-secondary">Servis hesabı DN (bind_dn)</label>
              <input value={bindDn} onChange={(e) => setBindDn(e.target.value)} required className="px-2.5 py-1.5 text-sm rounded-md border border-border bg-surface-1" placeholder="cn=svc-ldap,dc=sirket,dc=local" />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs text-text-secondary">Servis hesabı şifresi</label>
              <input type="password" value={bindPassword} onChange={(e) => setBindPassword(e.target.value)} placeholder={config ? "(değiştirmemek için boş bırakın)" : ""} required={!config} className="px-2.5 py-1.5 text-sm rounded-md border border-border bg-surface-1" />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs text-text-secondary">Base DN</label>
              <input value={baseDn} onChange={(e) => setBaseDn(e.target.value)} required className="px-2.5 py-1.5 text-sm rounded-md border border-border bg-surface-1" placeholder="dc=sirket,dc=local" />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs text-text-secondary">Kullanıcı arama filtresi</label>
              <input value={userSearchFilter} onChange={(e) => setUserSearchFilter(e.target.value)} required className="px-2.5 py-1.5 text-sm rounded-md border border-border bg-surface-1 font-mono" placeholder="(uid=%s)" />
            </div>
          </div>
          <div className="flex items-center gap-4 mb-4">
            <label className="flex items-center gap-1.5 text-sm"><input type="checkbox" checked={useTls} onChange={(e) => setUseTls(e.target.checked)} />TLS (ldaps://) kullan</label>
            <label className="flex items-center gap-1.5 text-sm"><input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />Aktif</label>
          </div>

          {upsert.isError && <p className="text-sm text-[var(--text-danger)] mb-3">{(upsert.error as Error).message}</p>}
          {test.data && (
            <p className={`text-sm mb-3 ${test.data.ok ? "text-[var(--text-success)]" : "text-[var(--text-danger)]"}`}>
              {test.data.ok ? test.data.message : test.data.error}
            </p>
          )}

          <div className="flex items-center gap-2">
            <button type="submit" disabled={upsert.isPending} className="px-3 py-1.5 text-sm rounded-md bg-[var(--text-accent)] text-white">
              Kaydet
            </button>
            {config && (
              <button type="button" onClick={() => test.mutate()} disabled={test.isPending} className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-md border border-border-strong hover:bg-surface-1">
                <PlugZap size={14} />
                Bağlantıyı test et
              </button>
            )}
          </div>
        </form>
      )}
    </div>
  );
}
