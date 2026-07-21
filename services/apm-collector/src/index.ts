import Fastify from "fastify";
import { parseOtlpTracePayload } from "./otlpParser.js";
import { insertTraces } from "./clickhouse.js";
import { resolveTenantFromApiToken } from "./auth.js";

const app = Fastify({ logger: false, bodyLimit: 10 * 1024 * 1024 });

const HTTP_PORT = Number(process.env.HTTP_PORT) || 4318; // OTel'in standart OTLP/HTTP portu

app.get("/health", async () => ({ status: "ok", service: "apm-collector" }));

// OTLP/HTTP standart path'i: /v1/traces (bkz. OTel spec). Auth: Authorization:
// Bearer <api_token> -- mevcut API token altyapısı üzerinden tenant'a çözülür.
app.post("/v1/traces", async (request, reply) => {
  const authHeader = request.headers["authorization"] as string | undefined;
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : undefined;
  if (!token) return reply.status(401).send({ error: "Authorization: Bearer <api_token> gerekli" });

  const tenantId = await resolveTenantFromApiToken(token);
  if (!tenantId) return reply.status(403).send({ error: "Geçersiz API token" });

  try {
    const spans = parseOtlpTracePayload(request.body);
    await insertTraces(tenantId, spans);
    console.log(`[ApmCollector] Tenant ${tenantId}: ${spans.length} span alındı.`);
    // OTLP/HTTP spec'i boş bir ExportTraceServiceResponse bekler.
    return reply.status(200).send({});
  } catch (err) {
    console.error("[ApmCollector] Trace işleme hatası:", (err as Error).message);
    return reply.status(500).send({ error: "Trace işlenemedi" });
  }
});

app.listen({ port: HTTP_PORT, host: "0.0.0.0" }).then(() => {
  console.log(`[ApmCollector] OTLP/HTTP alıcı hazır: ${HTTP_PORT}`);
});

process.on("unhandledRejection", (reason) => {
  console.error("[ApmCollector] Yakalanmamış promise reddi (process ayakta tutuldu):", reason);
});
