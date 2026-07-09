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
    ...(options.headers as Record<string, string> | undefined)
  };

  // Content-Type: application/json'ı SADECE gerçek bir body varken ekliyoruz.
  // Fastify, bu header body boşken gönderilirse "FST_ERR_CTP_EMPTY_JSON_BODY"
  // hatasıyla 400 döndürüyor (örn. acknowledge gibi body'siz POST/DELETE istekleri).
  if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  if (inMemoryToken) {
    headers["Authorization"] = `Bearer ${inMemoryToken}`;
  }

  const response = await fetch(`${GATEWAY_URL}${path}`, { ...options, headers });

  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error ? JSON.stringify(body.error) : `İstek başarısız: ${response.status}`);
  }

  if (response.status === 204) return undefined as T;
  return response.json();
}
