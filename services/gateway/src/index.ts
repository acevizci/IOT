import Fastify from "fastify";
import httpProxy from "@fastify/http-proxy";
import { verifyToken } from "./auth.js";

const app = Fastify({ logger: true });

const CORE_SERVICE_URL = process.env.CORE_SERVICE_URL || "http://core-service:3000";
const NPM_SERVICE_URL = process.env.NPM_SERVICE_URL || "http://npm-service:3100";

function applyCorsHeaders(request: any, reply: any) {
  const origin = request.headers.origin;
  if (origin) {
    reply.header("Access-Control-Allow-Origin", origin);
  }
  reply.header("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
  reply.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

app.addHook("onRequest", async (request, reply) => {
  if (request.method === "OPTIONS") {
    applyCorsHeaders(request, reply);
    reply.status(204).send();
    return reply;
  }
});

app.addHook("onSend", async (request, reply, payload) => {
  applyCorsHeaders(request, reply);
  return payload;
});

const PUBLIC_PATHS = ["/health", "/api/v1/auth/register", "/api/v1/auth/login"];
const PUBLIC_PATH_PREFIXES = ["/api/v1/agent/"];

app.addHook("onRequest", async (request, reply) => {
  if (request.method === "OPTIONS") return;
  if (PUBLIC_PATHS.includes(request.url)) return;
  const pathname = request.url.split("?")[0];
  if (PUBLIC_PATH_PREFIXES.some((p) => pathname.startsWith(p))) return;

  const authHeader = request.headers["authorization"];
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return reply.status(401).send({ error: "Authorization header eksik" });
  }

  const token = authHeader.slice(7);

  // API Token (obs_ ile başlar) — Core Service'e sorup doğrulanır (uzun ömürlü, programatik erişim).
  // JWT (normal login) — yerel olarak imza doğrulaması yapılır (kısa ömürlü, kullanıcı oturumu).
  if (token.startsWith("obs_")) {
    try {
      const response = await fetch(`${CORE_SERVICE_URL}/api/v1/internal/verify-api-token`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-internal-secret": process.env.INTERNAL_SERVICE_SECRET || "" },
        body: JSON.stringify({ token })
      });
      if (!response.ok) return reply.status(401).send({ error: "Geçersiz API token" });
      const payload: any = await response.json();
      request.headers["x-auth-user-id"] = payload.userId;
      request.headers["x-auth-tenant-id"] = payload.tenantId;
      request.headers["x-auth-role"] = payload.role;
    request.headers["x-auth-role-id"] = payload.roleId || "";
      request.headers["x-auth-email"] = payload.email;
      request.headers["x-auth-can-edit-devices"] = String(payload.canEditDevices ?? false);
      request.headers["x-auth-can-edit-alert-rules"] = String(payload.canEditAlertRules ?? false);
      request.headers["x-auth-can-manage-users"] = String(payload.canManageUsers ?? false);
    } catch {
      return reply.status(401).send({ error: "API token doğrulanamadı" });
    }
    return;
  }

  try {
    const payload = verifyToken(token);
    request.headers["x-auth-user-id"] = payload.userId;
    request.headers["x-auth-tenant-id"] = payload.tenantId;
    request.headers["x-auth-role"] = payload.role;
    request.headers["x-auth-role-id"] = payload.roleId || "";
    request.headers["x-auth-email"] = payload.email;
    request.headers["x-auth-can-edit-devices"] = String(payload.canEditDevices ?? false);
    request.headers["x-auth-can-edit-alert-rules"] = String(payload.canEditAlertRules ?? false);
    request.headers["x-auth-can-manage-users"] = String(payload.canManageUsers ?? false);
  } catch {
    return reply.status(401).send({ error: "Geçersiz veya süresi dolmuş token" });
  }
});

// Modül bazlı yönlendirme: önce daha spesifik path'ler (discovery -> NPM Service),
// sonra genel fallback (her şey Core Service'e).
app.register(httpProxy, {
  upstream: NPM_SERVICE_URL,
  prefix: "/api/v1/discovery",
  rewritePrefix: "/api/v1/discovery"
});

app.register(httpProxy, {
  upstream: CORE_SERVICE_URL,
  prefix: "/",
  rewritePrefix: "/"
});

const port = Number(process.env.PORT) || 8080;
app.listen({ port, host: "0.0.0.0" }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
