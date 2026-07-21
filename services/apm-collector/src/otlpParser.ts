// OTLP/HTTP JSON gövdesini (ExportTraceServiceRequest) düz span satırlarına
// çevirir. OTel'in resmi protobuf şemasını elle re-implement etmiyoruz --
// sadece JSON kodlamasını (OTLP spec'in "JSON Protobuf Encoding" bölümü)
// gerekli alanlarla parse ediyoruz.

export interface ParsedSpan {
  timestamp: string; // ClickHouse DateTime64 formatı
  trace_id: string;
  span_id: string;
  parent_span_id: string;
  service_name: string;
  operation_name: string;
  duration_ms: number;
  status_code: number;
  kind: number;
  attributes: Record<string, string>;
}

interface OtlpAnyValue {
  stringValue?: string;
  intValue?: string | number;
  doubleValue?: number;
  boolValue?: boolean;
}

interface OtlpKeyValue {
  key: string;
  value: OtlpAnyValue;
}

function attrValueToString(v: OtlpAnyValue | undefined): string {
  if (!v) return "";
  if (v.stringValue !== undefined) return v.stringValue;
  if (v.intValue !== undefined) return String(v.intValue);
  if (v.doubleValue !== undefined) return String(v.doubleValue);
  if (v.boolValue !== undefined) return String(v.boolValue);
  return "";
}

function attrsToMap(attrs: OtlpKeyValue[] | undefined): Record<string, string> {
  const map: Record<string, string> = {};
  for (const a of attrs || []) {
    map[a.key] = attrValueToString(a.value);
  }
  return map;
}

// OTel nanosecond epoch string'ini ClickHouse DateTime64(3) uyumlu bir
// "YYYY-MM-DD HH:MM:SS.mmm" string'ine çevirir.
function nanosToClickhouseDateTime(nanos: string | number): string {
  const ms = Math.floor(Number(nanos) / 1_000_000);
  return new Date(ms).toISOString().replace("T", " ").replace("Z", "");
}

export function parseOtlpTracePayload(body: any): ParsedSpan[] {
  const spans: ParsedSpan[] = [];
  const resourceSpans = body?.resourceSpans || [];

  for (const rs of resourceSpans) {
    const resourceAttrs = attrsToMap(rs?.resource?.attributes);
    const serviceName = resourceAttrs["service.name"] || "bilinmeyen-servis";

    for (const ss of rs?.scopeSpans || []) {
      for (const span of ss?.spans || []) {
        const startNanos = span.startTimeUnixNano;
        const endNanos = span.endTimeUnixNano;
        const durationMs = (Number(endNanos) - Number(startNanos)) / 1_000_000;

        spans.push({
          timestamp: nanosToClickhouseDateTime(startNanos),
          trace_id: span.traceId,
          span_id: span.spanId,
          parent_span_id: span.parentSpanId || "",
          service_name: serviceName,
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
