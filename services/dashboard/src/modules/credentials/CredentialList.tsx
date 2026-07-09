import { useState } from "react";
import { Link } from "react-router-dom";
import { Plus, Trash2, KeyRound } from "lucide-react";
import { useCredentials, useCreateCredential, useDeleteCredential } from "./useCredentials";

export function CredentialList() {
  const { data: credentials, isLoading } = useCredentials();
  const createCredential = useCreateCredential();
  const deleteCredential = useDeleteCredential();

  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState("");
  const [credentialType, setCredentialType] = useState<"ssh_password" | "ssh_key">("ssh_password");
  const [username, setUsername] = useState("");
  const [secret, setSecret] = useState("");

  function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    createCredential.mutate(
      { name, credential_type: credentialType, username, secret },
      { onSuccess: () => { setName(""); setUsername(""); setSecret(""); setShowForm(false); } }
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-lg font-medium">Kimlik bilgileri</h1>
          <p className="text-sm text-text-secondary">SSH/WinRM erişimi için şifreli saklanan kimlik bilgileri — şifreler asla düz metin olarak görüntülenmez</p>
        </div>
        <button onClick={() => setShowForm((v) => !v)} className="flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-md border border-border-strong hover:bg-surface-1">
          <Plus size={15} />
          Kimlik bilgisi ekle
        </button>
      </div>

      {createCredential.isError && <p className="text-sm text-[var(--text-danger)] mb-3">{(createCredential.error as Error).message}</p>}

      {showForm && (
        <form onSubmit={handleCreate} className="bg-surface-2 border border-border rounded-xl p-4 mb-4 flex items-end gap-3 flex-wrap">
          <div>
            <label className="text-xs text-text-secondary mb-1 block">Ad</label>
            <input value={name} onChange={(e) => setName(e.target.value)} required className="px-2.5 py-1.5 text-sm rounded-md border border-border bg-surface-1 w-48" placeholder="Prod Linux SSH" />
          </div>
          <div>
            <label className="text-xs text-text-secondary mb-1 block">Tip</label>
            <select value={credentialType} onChange={(e) => setCredentialType(e.target.value as any)} className="px-2.5 py-1.5 text-sm rounded-md border border-border bg-surface-1">
              <option value="ssh_password">SSH Şifre</option>
              <option value="ssh_key">SSH Anahtarı</option>
            </select>
          </div>
          <div>
            <label className="text-xs text-text-secondary mb-1 block">Kullanıcı adı</label>
            <input value={username} onChange={(e) => setUsername(e.target.value)} required className="px-2.5 py-1.5 text-sm rounded-md border border-border bg-surface-1 w-32" placeholder="root" />
          </div>
          <div>
            <label className="text-xs text-text-secondary mb-1 block">{credentialType === "ssh_password" ? "Şifre" : "Private Key (metin)"}</label>
            {credentialType === "ssh_password" ? (
              <input type="password" value={secret} onChange={(e) => setSecret(e.target.value)} required className="px-2.5 py-1.5 text-sm rounded-md border border-border bg-surface-1 w-48" />
            ) : (
              <textarea value={secret} onChange={(e) => setSecret(e.target.value)} required className="px-2.5 py-1.5 text-sm rounded-md border border-border bg-surface-1 w-64 h-20 font-mono" placeholder="-----BEGIN OPENSSH PRIVATE KEY-----" />
            )}
          </div>
          <button type="submit" disabled={createCredential.isPending} className="px-3 py-1.5 text-sm rounded-md bg-[var(--text-accent)] text-white">
            Ekle
          </button>
        </form>
      )}

      {isLoading && <p className="text-sm text-text-secondary">Yükleniyor...</p>}

      <div className="border border-border rounded-xl overflow-hidden">
        {credentials?.map((c) => (
          <div key={c.id} className="flex items-center gap-3 px-4 py-2.5 border-b border-border last:border-0">
            <KeyRound size={15} className="text-text-secondary shrink-0" />
            <Link to={`/credentials/${c.id}`} className="text-sm font-medium flex-1 hover:text-text-accent">{c.name}</Link>
            <span className="text-xs text-text-secondary">{c.username}</span>
            <span className="text-[11px] px-2 py-0.5 rounded-full bg-surface-1 border border-border text-text-secondary">
              {c.credential_type === "ssh_password" ? "şifre" : "SSH anahtarı"}
            </span>
            <button onClick={() => deleteCredential.mutate(c.id)} className="text-text-muted hover:text-[var(--text-danger)]"><Trash2 size={14} /></button>
          </div>
        ))}
        {credentials?.length === 0 && <p className="text-sm text-text-muted p-4">Henüz kimlik bilgisi eklenmedi.</p>}
      </div>
    </div>
  );
}
