// nflow-generator'ın NetFlow için yaptığı role benzer: gerçek bir müşteri
// uygulamasını simüle eden, periyodik olarak apm-collector'a OTLP/HTTP trace
// gönderen mock veri üreticisi. Adım 5 (RED metrikleri, trace arama) ve
// gelecekteki anomali tespiti için gerçekçi veri sağlar.

const APM_COLLECTOR_URL = process.env.APM_COLLECTOR_URL || "http://apm-collector:4318";
const API_TOKEN = process.env.APM_GEN_API_TOKEN || "";
const INTERVAL_MS = Number(process.env.GEN_INTERVAL_MS) || 5000;

function randomHex(bytes: number): string {
  const arr = new Uint8Array(bytes);
  for (let i = 0; i < bytes; i++) arr[i] = Math.floor(Math.random() * 256);
  return Buffer.from(arr).toString("hex");
}

interface SpanSpec {
  name: string;
  serviceName: string;
  kind: number;
  durationMs: number;
  isError: boolean;
  attributes: Record<string, string>;
  children?: SpanSpec[];
}

// Gerçekçi bir servis zinciri: checkout-service (HTTP) -> payment-service
// (dahili çağrı) -> orders-db (SQL sorgusu). %8 ihtimalle payment-service
// yavaşlar (p99 senaryosu), %5 ihtimalle orders-db hata döner -- ileride
// anomali tespiti/RCA testleri için gerçekçi "kötü" örnekler sağlar.
function buildTraceSpec(): SpanSpec {
  const isSlow = Math.random() < 0.08;
  const isError = Math.random() < 0.05;

  return {
    name: "POST /checkout",
    serviceName: "checkout-service",
    kind: 2, // SERVER
    durationMs: isSlow ? 1200 + Math.random() * 800 : 80 + Math.random() * 60,
    isError: false,
    attributes: { "http.method": "POST", "http.route": "/checkout" },
    children: [
      {
        name: "ProcessPayment",
        serviceName: "payment-service",
        kind: 3, // CLIENT
        durationMs: isSlow ? 900 + Math.random() * 500 : 40 + Math.random() * 40,
        isError,
        attributes: { "payment.provider": "stripe-mock" },
        children: [
          {
            name: "SELECT orders",
            serviceName: "orders-db",
            kind: 3,
            durationMs: 10 + Math.random() * 30,
            isError: isError && Math.random() < 0.6,
            attributes: { "db.system": "postgresql", "db.statement": "SELECT * FROM orders WHERE id = ?" }
          }
        ]
      }
    ]
  };
}

// Recursive span ağacını, hepsi AYNI trace_id'yi paylaşan, doğru parent_span_id
// zincirine sahip düz bir OTLP resourceSpans listesine çevirir. Her servis
// KENDİ resource.attributes'ında service.name taşır (gerçek OTel SDK'ların
// her servisin kendi süreci/resource'u olması davranışını simüle eder).
function flattenToResourceSpans(root: SpanSpec, traceId: string, startNanos: bigint): any[] {
  const byService = new Map<string, any[]>();

  function walk(spec: SpanSpec, parentSpanId: string, startOffset: number): number {
    const spanId = randomHex(8);
    const endOffset = startOffset + spec.durationMs;

    const span = {
      traceId,
      spanId,
      parentSpanId,
      name: spec.name,
      kind: spec.kind,
      startTimeUnixNano: (startNanos + BigInt(Math.round(startOffset * 1_000_000))).toString(),
      endTimeUnixNano: (startNanos + BigInt(Math.round(endOffset * 1_000_000))).toString(),
      status: { code: spec.isError ? 2 : 1 },
      attributes: Object.entries(spec.attributes).map(([key, value]) => ({ key, value: { stringValue: value } }))
    };

    if (!byService.has(spec.serviceName)) byService.set(spec.serviceName, []);
    byService.get(spec.serviceName)!.push(span);

    let childOffset = startOffset + 2; // çocuk span'ler, parent başladıktan kısa süre sonra başlar
    for (const child of spec.children || []) {
      childOffset = walk(child, spanId, childOffset);
    }
    return endOffset;
  }

  walk(root, "", 0);

  // APM Adım 6: host.name -- checkout-service/payment-service AYNI host'ta
  // (NetFlow-Exporter-01), orders-db farklı bir host'ta (SNMP-Sim-01) çalışıyor
  // gibi simüle ediyoruz (gerçekçi mikroservis mimarisi: DB genelde ayrı bir
  // sunucuda). apm-collector bunu okuyup service_host device_links bağlantısı
  // kuracak, RCA motoru bunu otomatik olarak adjacency'ye dahil edecek.
  const HOST_BY_SERVICE: Record<string, string> = {
    "checkout-service": "NetFlow-Exporter-01",
    "payment-service": "NetFlow-Exporter-01",
    "orders-db": "SNMP-Sim-01"
  };

  return Array.from(byService.entries()).map(([serviceName, spans]) => ({
    resource: {
      attributes: [
        { key: "service.name", value: { stringValue: serviceName } },
        { key: "host.name", value: { stringValue: HOST_BY_SERVICE[serviceName] || "bilinmeyen-host" } }
      ]
    },
    scopeSpans: [{ spans }]
  }));
}

async function sendTrace(): Promise<void> {
  const traceId = randomHex(16);
  const startNanos = BigInt(Date.now()) * 1_000_000n;
  const spec = buildTraceSpec();
  const resourceSpans = flattenToResourceSpans(spec, traceId, startNanos);

  const response = await fetch(`${APM_COLLECTOR_URL}/v1/traces`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_TOKEN}` },
    body: JSON.stringify({ resourceSpans })
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`apm-collector reddetti: ${response.status} ${text}`);
  }
}

async function main() {
  if (!API_TOKEN) {
    console.error("[ApmTraceGenerator] APM_GEN_API_TOKEN tanımlı değil, durduruluyor.");
    process.exit(1);
  }
  console.log(`[ApmTraceGenerator] Başlıyor, her ${INTERVAL_MS}ms'de bir trace gönderilecek.`);

  setInterval(() => {
    sendTrace()
      .then(() => console.log("[ApmTraceGenerator] Trace gönderildi."))
      .catch((err) => console.error("[ApmTraceGenerator] Hata (bir sonraki tur devam edecek):", err.message));
  }, INTERVAL_MS);
}

main();

process.on("unhandledRejection", (reason) => {
  console.error("[ApmTraceGenerator] Yakalanmamış promise reddi (process ayakta tutuldu):", reason);
});
