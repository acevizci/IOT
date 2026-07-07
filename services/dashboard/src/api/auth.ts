import { apiFetch } from "./client";

export interface AuthResponse {
  token: string;
  tenantId: string;
  user: { id: string; email: string; role: string };
}

export function login(email: string, password: string) {
  return apiFetch<{ token: string }>("/api/v1/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password })
  });
}

export function register(tenantName: string, email: string, password: string) {
  return apiFetch<AuthResponse>("/api/v1/auth/register", {
    method: "POST",
    body: JSON.stringify({ tenantName, email, password })
  });
}
