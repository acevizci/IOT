import Fastify from "fastify";
import { parseOtlpTracePayload } from "./otlpParser.js";
import { insertTraces } from "./clickhouse.js";
import { resolveTenantFromApiToken } from "./auth.js";
import { startGrpcServer } from "./grpcServer.js";
import { syncServiceIfNeeded } from "./serviceSync.js";

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

    // APM Adım 6: servis<->host senkronizasyonu -- fire-and-forget (yanıtı
    // geciktirmemesi için await EDİLMİYOR, hata olsa bile trace alımını
    // etkilemez). Aynı (servis,host) çifti için TTL'li throttle var (bkz.
    // serviceSync.ts), her span'de core-service'e gitmiyor.
    const seen = new Set<string>();
    for (const span of spans) {
      const key = `${span.service_name}:${span.host_name || ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      syncServiceIfNeeded(tenantId, span.service_name, span.host_name).catch((err) => {
        console.error("[ApmCollector] syncServiceIfNeeded hatası (yok sayıldı):", (err as Error).message);
      });
    }

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

const GRPC_PORT = Number(process.env.GRPC_PORT) || 4317; // OTel'in standart OTLP/gRPC portu
startGrpcServer(GRPC_PORT);

process.on("unhandledRejection", (reason) => {
  console.error("[ApmCollector] Yakalanmamış promise reddi (process ayakta tutuldu):", reason);
});
