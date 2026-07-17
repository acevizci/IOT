import { createContext, useContext, useState, useCallback, ReactNode } from "react";
import { setAuthToken } from "../api/client";

export type PermissionLevel = "none" | "read" | "read_write";
export type PermissionMap = Record<string, PermissionLevel>;

interface AuthState {
  isAuthenticated: boolean;
  permissions: PermissionMap;
  login: (token: string) => void;
  logout: () => void;
}

const AuthContext = createContext<AuthState | null>(null);

// JWT'nin payload kısmını (imza DOĞRULAMADAN) çözer -- bu SADECE dashboard'da
// hangi menü öğelerinin gösterileceğine karar vermek için bir UI kolaylığıdır.
// Gerçek yetkilendirme her zaman backend'de (hasPermission()) yapılır; burada
// yanlış/eksik bir sonuç en kötü ihtimalle bir menü öğesinin görünüp
// görünmemesini etkiler, hiçbir veriye erişimi değiştirmez.
function decodePermissionsFromToken(token: string): PermissionMap {
  try {
    const payloadB64 = token.split(".")[1];
    const normalized = payloadB64.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
    const payload = JSON.parse(atob(padded));
    return payload.permissions || {};
  } catch {
    return {};
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [permissions, setPermissions] = useState<PermissionMap>({});

  const login = useCallback((token: string) => {
    setAuthToken(token);
    setPermissions(decodePermissionsFromToken(token));
    setIsAuthenticated(true);
  }, []);

  const logout = useCallback(() => {
    setAuthToken(null);
    setPermissions({});
    setIsAuthenticated(false);
  }, []);

  return (
    <AuthContext.Provider value={{ isAuthenticated, permissions, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
