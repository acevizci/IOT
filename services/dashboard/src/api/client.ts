const GATEWAY_URL = import.meta.env.VITE_GATEWAY_URL || "http://localhost:8080";

let inMemoryToken: string | null = null;

export function setAuthToken(token: string | null) {
  inMemoryToken = token;
}

export function getAuthToken() {
  return inMemoryToken;
}

export async function apiFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(options.headers as Record<string, string> | undefined)
  };

  if (inMemoryToken) {
    headers["Authorization"] = `Bearer ${inMemoryToken}`;
  }

  const response = await fetch(`${GATEWAY_URL}${path}`, { ...options, headers });

  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error ? JSON.stringify(body.error) : `İstek başarısız: ${response.status}`);
  }

  return response.json();
}
