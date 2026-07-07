import { createContext, useContext, useState, useCallback, ReactNode } from "react";
import { setAuthToken } from "../api/client";

interface AuthState {
  isAuthenticated: boolean;
  login: (token: string) => void;
  logout: () => void;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [isAuthenticated, setIsAuthenticated] = useState(false);

  const login = useCallback((token: string) => {
    setAuthToken(token);
    setIsAuthenticated(true);
  }, []);

  const logout = useCallback(() => {
    setAuthToken(null);
    setIsAuthenticated(false);
  }, []);

  return (
    <AuthContext.Provider value={{ isAuthenticated, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
