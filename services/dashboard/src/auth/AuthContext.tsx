import { createContext, useContext, useState, useCallback, type ReactNode } from "react";
import { setAuthToken } from "../api/client";

export type PermissionLevel = "none" | "read" | "read_write";
export type PermissionMap = Record<string, PermissionLevel>;

interface AuthState {
  isAuthenticated: boolean;
  permissions: PermissionMap;
  // Platform superadmin: normal tenant-scoped permissions'dan AYRI -- sadece
  // Dashboard'un "Tenant'lar" sekmesini gösterip göstermeme kararı için (UI
  // kolaylığı, permissions'la AYNI gerekçe -- gerçek yetki her zaman backend'de).
  isSuperadmin: boolean;
  login: (token: string) => void;
  logout: () => void;
}

const AuthContext = createContext<AuthState | null>(null);

// JWT'nin payload kısmını (imza DOĞRULAMADAN) çözer -- bu SADECE dashboard'da
// hangi menü öğelerinin gösterileceğine karar vermek için bir UI kolaylığıdır.
// Gerçek yetkilendirme her zaman backend'de (hasPermission()) yapılır; burada
// yanlış/eksik bir sonuç en kötü ihtimalle bir menü öğesinin görünüp
// görünmemesini etkiler, hiçbir veriye erişimi değiştirmez.
function decodeTokenPayload(token: string): { permissions: PermissionMap; isSuperadmin: boolean } {
  try {
    const payloadB64 = token.split(".")[1];
    const normalized = payloadB64.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
    const payload = JSON.parse(atob(padded));
    return { permissions: payload.permissions || {}, isSuperadmin: payload.isSuperadmin === true };
  } catch {
    return { permissions: {}, isSuperadmin: false };
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [permissions, setPermissions] = useState<PermissionMap>({});
  const [isSuperadmin, setIsSuperadmin] = useState(false);

  const login = useCallback((token: string) => {
    setAuthToken(token);
    const decoded = decodeTokenPayload(token);
    setPermissions(decoded.permissions);
    setIsSuperadmin(decoded.isSuperadmin);
    setIsAuthenticated(true);
  }, []);

  const logout = useCallback(() => {
    setAuthToken(null);
    setPermissions({});
    setIsSuperadmin(false);
    setIsAuthenticated(false);
  }, []);

  return (
    <AuthContext.Provider value={{ isAuthenticated, permissions, isSuperadmin, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
