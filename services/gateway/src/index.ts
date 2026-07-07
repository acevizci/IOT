import Fastify from "fastify";
import httpProxy from "@fastify/http-proxy";
import { verifyToken } from "./auth.js";

const app = Fastify({ logger: true });

const CORE_SERVICE_URL = process.env.CORE_SERVICE_URL || "http://core-service:3000";

// Auth doğrulaması GEREKMEYEN yollar (kayıt, giriş, health check)
const PUBLIC_PATHS = ["/health", "/api/v1/auth/register", "/api/v1/auth/login"];

app.addHook("onRequest", async (request, reply) => {
  if (PUBLIC_PATHS.includes(request.url)) return;

  const authHeader = request.headers["authorization"];
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return reply.status(401).send({ error: "Authorization header eksik" });
  }

  try {
    const token = authHeader.slice(7);
    const payload = verifyToken(token);

    // Doğrulanmış bilgiyi güvenilir header'lar olarak Core'a iletiyoruz.
    // Core Service bu header'lara SADECE Gateway'den geldiği için güvenir
    // (Core dışarıya kapalı, sadece Docker network içinden erişilebilir).
    request.headers["x-auth-user-id"] = payload.userId;
    request.headers["x-auth-tenant-id"] = payload.tenantId;
    request.headers["x-auth-role"] = payload.role;
    request.headers["x-auth-email"] = payload.email;
  } catch {
    return reply.status(401).send({ error: "Geçersiz veya süresi dolmuş token" });
  }
});

// Tüm istekleri Core Service'e ilet
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
