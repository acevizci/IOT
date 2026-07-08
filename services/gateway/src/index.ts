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

app.addHook("onRequest", async (request, reply) => {
  if (request.method === "OPTIONS") return;
  if (PUBLIC_PATHS.includes(request.url)) return;

  const authHeader = request.headers["authorization"];
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return reply.status(401).send({ error: "Authorization header eksik" });
  }

  try {
    const token = authHeader.slice(7);
    const payload = verifyToken(token);

    request.headers["x-auth-user-id"] = payload.userId;
    request.headers["x-auth-tenant-id"] = payload.tenantId;
    request.headers["x-auth-role"] = payload.role;
    request.headers["x-auth-email"] = payload.email;
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
