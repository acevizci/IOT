import { useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import { register } from "../../api/auth";
import { useAuth } from "../../auth/AuthContext";

export function RegisterPage() {
  const [tenantName, setTenantName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const { login: setLoggedIn } = useAuth();
  const navigate = useNavigate();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const res = await register(tenantName, email, password);
      setLoggedIn(res.token);
      navigate("/dashboard");
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center">
      <form onSubmit={handleSubmit} className="bg-surface-1 border border-border rounded-xl p-6 w-80">
        <h1 className="text-lg font-medium mb-4">Hesap oluştur</h1>
        {error && <p className="text-sm text-[var(--text-danger)] mb-3">{error}</p>}
        <input
          type="text" placeholder="Şirket adı" value={tenantName} onChange={(e) => setTenantName(e.target.value)}
          className="w-full mb-3 px-3 py-2 text-sm rounded-md border border-border bg-surface-2" required
        />
        <input
          type="email" placeholder="E-posta" value={email} onChange={(e) => setEmail(e.target.value)}
          className="w-full mb-3 px-3 py-2 text-sm rounded-md border border-border bg-surface-2" required
        />
        <input
          type="password" placeholder="Şifre (en az 8 karakter)" value={password} onChange={(e) => setPassword(e.target.value)}
          className="w-full mb-4 px-3 py-2 text-sm rounded-md border border-border bg-surface-2" required minLength={8}
        />
        <button type="submit" className="w-full py-2 text-sm rounded-md bg-brand text-brand-contrast">
          Hesap oluştur
        </button>
        <p className="text-xs text-text-secondary text-center mt-3">
          Zaten hesabın var mı? <Link to="/login" className="text-[var(--text-accent)]">Giriş yap</Link>
        </p>
      </form>
    </div>
  );
}
