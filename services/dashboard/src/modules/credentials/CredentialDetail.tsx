import { useState } from "react";
import { useParams, Link } from "react-router-dom";
import { ArrowLeft, Pencil, Check, X, LayoutTemplate } from "lucide-react";
import { useCredentials, useUpdateCredential, useCredentialUsage } from "./useCredentials";

export function CredentialDetail() {
  const { id } = useParams<{ id: string }>();
  const { data: credentials } = useCredentials();
  const { data: usage, isLoading: usageLoading } = useCredentialUsage(id!);
  const updateCredential = useUpdateCredential();

  const credential = credentials?.find((c) => c.id === id);

  const [editing, setEditing] = useState(false);
  const [name, setName] = useState("");
  const [username, setUsername] = useState("");
  const [secret, setSecret] = useState("");

  function startEdit() {
    if (!credential) return;
    setName(credential.name);
    setUsername(credential.username);
    setSecret("");
    setEditing(true);
  }

  function saveEdit() {
    const input: any = { name, username };
    if (secret) input.secret = secret; // boşsa mevcut secret korunur
    updateCredential.mutate({ id: id!, input }, { onSuccess: () => setEditing(false) });
  }

  if (!credential) return <p className="text-sm text-text-secondary">Yükleniyor...</p>;

  return (
    <div>
      <Link to="/credentials" className="flex items-center gap-1.5 text-sm text-text-secondary mb-3 w-fit">
        <ArrowLeft size={15} />
        Kimlik bilgilerine dön
      </Link>

      {editing ? (
        <div className="bg-surface-2 border border-border rounded-xl p-4 mb-5 flex items-end gap-3 flex-wrap">
          <div>
            <label className="text-xs text-text-secondary mb-1 block">Ad</label>
            <input value={name} onChange={(e) => setName(e.target.value)} className="px-2.5 py-1.5 text-sm rounded-md border border-border bg-surface-1 w-40" />
          </div>
          <div>
            <label className="text-xs text-text-secondary mb-1 block">Kullanıcı adı</label>
            <input value={username} onChange={(e) => setUsername(e.target.value)} className="px-2.5 py-1.5 text-sm rounded-md border border-border bg-surface-1 w-32" />
          </div>
          <div>
            <label className="text-xs text-text-secondary mb-1 block">Yeni şifre (boş bırakılırsa değişmez)</label>
            <input type="password" value={secret} onChange={(e) => setSecret(e.target.value)} className="px-2.5 py-1.5 text-sm rounded-md border border-border bg-surface-1 w-40" />
          </div>
          <button onClick={saveEdit} className="text-[var(--text-success)]"><Check size={20} /></button>
          <button onClick={() => setEditing(false)} className="text-text-muted"><X size={20} /></button>
        </div>
      ) : (
        <div className="flex items-center gap-2 mb-1">
          <h1 className="text-lg font-medium">{credential.name}</h1>
          <button onClick={startEdit} className="text-text-muted hover:text-text-accent"><Pencil size={14} /></button>
        </div>
      )}

      {!editing && (
        <p className="text-sm text-text-secondary mb-5">
          {credential.username} · {credential.credential_type === "ssh_password" ? "şifre" : "SSH anahtarı"}
        </p>
      )}

      <div>
        <div className="flex items-center gap-1.5 mb-2">
          <LayoutTemplate size={15} className="text-text-secondary" />
          <p className="text-sm font-medium">Bu kimlik bilgisini kullanan metrikler ({usage?.length ?? 0})</p>
        </div>
        {usageLoading && <p className="text-sm text-text-secondary">Yükleniyor...</p>}
        <div className="border border-border rounded-xl overflow-hidden">
          {usage?.map((u) => (
            <Link key={u.item_id} to={`/templates/${u.template_id}`} className="flex items-center gap-3 px-4 py-2.5 border-b border-border last:border-0 hover:bg-surface-1 text-sm">
              <span className="font-medium">{u.metric_name}</span>
              <span className="text-xs text-text-muted">şablon: {u.template_name}</span>
            </Link>
          ))}
          {usage?.length === 0 && <p className="text-sm text-text-muted p-4">Bu kimlik bilgisi henüz hiçbir metrikte kullanılmıyor.</p>}
        </div>
      </div>
    </div>
  );
}
