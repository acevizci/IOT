import { useState } from "react";
import { X } from "lucide-react";
import { useChangeOwnPassword } from "./useUsers";

// GERÇEK EKSİKLİK DÜZELTMESİ (kullanıcı yönetimi denetiminde bulundu): hesabını
// oluşturduktan sonra bir kullanıcının kendi şifresini değiştirmesinin hiçbir
// yolu yoktu (admin şifre sıfırlaması PATCH /users/:id/password ile ayrı
// eklendi -- bu, kullanıcının KENDİSİ için, mevcut şifreyi doğrulayarak).
export function ChangePasswordModal({ onClose }: { onClose: () => void }) {
  const changePassword = useChangeOwnPassword();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [mismatchError, setMismatchError] = useState(false);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setMismatchError(false);
    if (newPassword !== confirmPassword) {
      setMismatchError(true);
      return;
    }
    changePassword.mutate(
      { currentPassword, newPassword },
      { onSuccess: onClose }
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <form onSubmit={handleSubmit} onClick={(e) => e.stopPropagation()} className="bg-surface-2 border border-border rounded-xl p-5 w-[380px]">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-base font-medium">Şifremi değiştir</h2>
          <button type="button" onClick={onClose} className="text-text-muted"><X size={18} /></button>
        </div>

        {changePassword.isError && <p className="text-sm text-[var(--text-danger)] mb-3">{(changePassword.error as Error).message}</p>}
        {mismatchError && <p className="text-sm text-[var(--text-danger)] mb-3">Yeni şifreler eşleşmiyor</p>}

        <div className="flex flex-col gap-3">
          <label className="text-xs text-text-secondary">
            Mevcut şifre
            <input
              type="password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              required
              className="mt-1 w-full px-2.5 py-1.5 text-sm rounded-md border border-border bg-surface-1"
            />
          </label>
          <label className="text-xs text-text-secondary">
            Yeni şifre
            <input
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              required
              minLength={8}
              className="mt-1 w-full px-2.5 py-1.5 text-sm rounded-md border border-border bg-surface-1"
            />
          </label>
          <label className="text-xs text-text-secondary">
            Yeni şifre (tekrar)
            <input
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              required
              minLength={8}
              className="mt-1 w-full px-2.5 py-1.5 text-sm rounded-md border border-border bg-surface-1"
            />
          </label>
        </div>

        <button type="submit" disabled={changePassword.isPending} className="w-full mt-4 py-2 text-sm rounded-md bg-[var(--text-accent)] text-white">
          {changePassword.isPending ? "Kaydediliyor..." : "Şifreyi değiştir"}
        </button>
      </form>
    </div>
  );
}
