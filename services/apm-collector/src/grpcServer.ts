import path from "path";
import { fileURLToPath } from "url";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { insertTraces } from "./clickhouse.js";
import { resolveTenantFromApiToken } from "./auth.js";
import { syncServiceIfNeeded } from "./serviceSync.js";
import type { ParsedSpan } from "./otlpParser.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// GERÇEK HATA (canlı testte bulundu): OTLP/gRPC'de trace_id/span_id gerçek
// binary Buffer olarak gelir, OTLP/HTTP-JSON'da ise hex string olarak gelir
// (otlpParser.ts bunu OLDUĞU GİBİ saklıyor, hiç decode etmiyor). Eğer burada
// base64'e çevirseydik, AYNI trace_id iki protokolden geldiğinde FARKLI
// string'ler olarak saklanır, trace waterfall'ı ve korelasyon bölünürdü.
// Düzeltme: gRPC tarafında da hex'e çeviriyoruz -- iki protokol de HTTP/JSON
// tarafıyla aynı (hex) temsile yakınsıyor.
function bytesToId(b: Buffer | Uint8Array | undefined): string {
  if (!b || b.length === 0) return "";
  return Buffer.from(b).toString("hex");
}

function attrsToMap(attrs: any[] | undefined): Record<string, string> {
  const map: Record<string, string> = {};
  for (const a of attrs || []) {
    const v = a.value;
    let val = "";
    if (v?.stringValue !== undefined) val = v.stringValue;
    else if (v?.intValue !== undefined) val = String(v.intValue);
    else if (v?.doubleValue !== undefined) val = String(v.doubleValue);
    else if (v?.boolValue !== undefined) val = String(v.boolValue);
    map[a.key] = val;
  }
  return map;
}

function nanosToClickhouseDateTime(nanos: string | number): string {
  const ms = Math.floor(Number(nanos) / 1_000_000);
  return new Date(ms).toISOString().replace("T", " ").replace("Z", "");
}

function parseGrpcTraceRequest(call: any): ParsedSpan[] {
  const spans: ParsedSpan[] = [];
  const resourceSpans = call.request?.resourceSpans || [];

  for (const rs of resourceSpans) {
    const resourceAttrs = attrsToMap(rs?.resource?.attributes);
    const serviceName = resourceAttrs["service.name"] || "bilinmeyen-servis";
    const hostName = resourceAttrs["host.name"] || undefined;

    for (const ss of rs?.scopeSpans || []) {
      for (const span of ss?.spans || []) {
        const startNanos = span.startTimeUnixNano;
        const endNanos = span.endTimeUnixNano;
        const durationMs = (Number(endNanos) - Number(startNanos)) / 1_000_000;

        spans.push({
          timestamp: nanosToClickhouseDateTime(startNanos),
          trace_id: bytesToId(span.traceId),
          span_id: bytesToId(span.spanId),
          parent_span_id: bytesToId(span.parentSpanId),
          service_name: serviceName,
          host_name: hostName,
          operation_name: span.name || "bilinmeyen-işlem",
          duration_ms: durationMs,
          status_code: span.status?.code ?? 0,
          kind: span.kind ?? 0,
          attributes: attrsToMap(span.attributes)
        });
      }
    }
  }

  return spans;
}

export function startGrpcServer(port: number) {
  const protoPath = path.join(__dirname, "../proto/opentelemetry/proto/collector/trace/v1/trace_service.proto");
  const packageDefinition = protoLoader.loadSync(protoPath, {
    keepCase: false, // camelCase alan adları (traceId, spanId vb.) -- otlpParser.ts ile tutarlı
    longs: String,
    enums: Number,
    defaults: true,
    oneofs: true,
    includeDirs: [path.join(__dirname, "../proto")]
  });
  const proto = grpc.loadPackageDefinition(packageDefinition) as any;
  const TraceServiceProto = proto.opentelemetry.proto.collector.trace.v1.TraceService;

  const server = new grpc.Server();
  server.addService(TraceServiceProto.service, {
    Export: async (call: any, callback: any) => {
      const metadata = call.metadata.get("authorization");
      const authHeader = Array.isArray(metadata) ? metadata[0] : metadata;
      const token = typeof authHeader === "string" && authHeader.startsWith("Bearer ") ? authHeader.slice(7) : undefined;

      if (!token) {
        return callback({ code: grpc.status.UNAUTHENTICATED, message: "authorization: Bearer <api_token> gerekli" });
      }

      const tenantId = await resolveTenantFromApiToken(token);
      if (!tenantId) {
        return callback({ code: grpc.status.PERMISSION_DENIED, message: "Geçersiz API token" });
      }

      try {
        const spans = parseGrpcTraceRequest(call);
        await insertTraces(tenantId, spans);
        console.log(`[ApmCollector] (gRPC) Tenant ${tenantId}: ${spans.length} span alındı.`);

        const seen = new Set<string>();
        for (const span of spans) {
          const key = `${span.service_name}:${span.host_name || ""}`;
          if (seen.has(key)) continue;
          seen.add(key);
          syncServiceIfNeeded(tenantId, span.service_name, span.host_name).catch((err) => {
            console.error("[ApmCollector] (gRPC) syncServiceIfNeeded hatası (yok sayıldı):", (err as Error).message);
          });
        }

        callback(null, { partialSuccess: { rejectedSpans: 0, errorMessage: "" } });
      } catch (err) {
        console.error("[ApmCollector] (gRPC) Trace işleme hatası:", (err as Error).message);
        callback({ code: grpc.status.INTERNAL, message: "Trace işlenemedi" });
      }
    }
  });

  server.bindAsync(`0.0.0.0:${port}`, grpc.ServerCredentials.createInsecure(), (err, boundPort) => {
    if (err) {
      console.error("[ApmCollector] gRPC server başlatma hatası:", err.message);
      return;
    }
    console.log(`[ApmCollector] OTLP/gRPC alıcı hazır: ${boundPort}`);
  });
}
