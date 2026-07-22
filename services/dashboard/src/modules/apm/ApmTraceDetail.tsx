import { useParams, Link } from "react-router-dom";
import { ArrowLeft, GitBranch } from "lucide-react";
import { useApmTraceDetail } from "./useApm";
import type { ApmSpan } from "../../api/apm";

interface SpanNode extends ApmSpan {
  children: SpanNode[];
  offsetMs: number; // trace başlangıcına göre bu span'in başladığı an
}

// Düz span listesini parent_span_id ile hiyerarşik bir ağaca çevirir. Kök
// span'ler (parent_span_id boş VEYA trace içinde eşleşen bir parent'ı
// olmayanlar -- örn. farklı bir servisten kesik gelen span) en üst seviyede.
function buildTree(spans: ApmSpan[]): { roots: SpanNode[]; traceStartMs: number; traceDurationMs: number } {
  const traceStartMs = Math.min(...spans.map((s) => new Date(s.timestamp.replace(" ", "T") + "Z").getTime()));
  const traceEndMs = Math.max(...spans.map((s) => new Date(s.timestamp.replace(" ", "T") + "Z").getTime() + s.duration_ms));
  const traceDurationMs = Math.max(traceEndMs - traceStartMs, 1);

  const nodeById = new Map<string, SpanNode>();
  for (const s of spans) {
    const startMs = new Date(s.timestamp.replace(" ", "T") + "Z").getTime();
    nodeById.set(s.span_id, { ...s, children: [], offsetMs: startMs - traceStartMs });
  }

  const roots: SpanNode[] = [];
  for (const node of nodeById.values()) {
    if (node.parent_span_id && nodeById.has(node.parent_span_id)) {
      nodeById.get(node.parent_span_id)!.children.push(node);
    } else {
      roots.push(node);
    }
  }
  for (const node of nodeById.values()) {
    node.children.sort((a, b) => a.offsetMs - b.offsetMs);
  }
  roots.sort((a, b) => a.offsetMs - b.offsetMs);

  return { roots, traceStartMs, traceDurationMs };
}

function SpanRow({ node, depth, traceDurationMs }: { node: SpanNode; depth: number; traceDurationMs: number }) {
  const leftPct = (node.offsetMs / traceDurationMs) * 100;
  const widthPct = Math.max((node.duration_ms / traceDurationMs) * 100, 0.5);
  const isError = node.status_code === 2;

  return (
    <>
      <div className="flex items-center gap-2 py-1.5 border-b border-border last:border-0 text-xs">
        <div className="w-64 shrink-0 truncate" style={{ paddingLeft: `${depth * 16}px` }}>
          <span className="text-text-muted">{node.service_name}</span>{" "}
          <span className="font-medium">{node.operation_name}</span>
        </div>
        <div className="flex-1 relative h-4 bg-surface-1 rounded">
          <div
            className={`absolute top-0 h-full rounded ${isError ? "bg-[var(--text-danger)]" : "bg-[var(--text-accent)]"}`}
            style={{ left: `${leftPct}%`, width: `${widthPct}%` }}
            title={`${Math.round(node.duration_ms)} ms`}
          />
        </div>
        <div className="w-16 shrink-0 text-right text-text-secondary">{Math.round(node.duration_ms)} ms</div>
      </div>
      {node.children.map((child) => (
        <SpanRow key={child.span_id} node={child} depth={depth + 1} traceDurationMs={traceDurationMs} />
      ))}
    </>
  );
}

export function ApmTraceDetail() {
  const { traceId } = useParams<{ traceId: string }>();
  const { data, isLoading, error } = useApmTraceDetail(traceId!);

  if (isLoading) return <p className="text-sm text-text-secondary">Yükleniyor...</p>;
  if (error) return <p className="text-sm text-[var(--text-danger)]">Hata: {(error as Error).message}</p>;
  if (!data) return null;

  const { roots, traceDurationMs } = buildTree(data.spans);
  const rootSpan = data.spans.find((s) => !s.parent_span_id) || data.spans[0];

  return (
    <div>
      <Link to="/apm/traces" className="flex items-center gap-1.5 text-sm text-text-secondary hover:text-text-accent mb-3">
        <ArrowLeft size={15} />
        Trace Arama
      </Link>

      <div className="mb-4">
        <h1 className="text-lg font-medium flex items-center gap-1.5">
          <GitBranch size={18} />
          {rootSpan?.operation_name ?? "Trace"}
        </h1>
        <p className="text-sm text-text-secondary font-mono">{data.trace_id}</p>
        <p className="text-sm text-text-secondary mt-1">
          Toplam süre: <span className="font-medium">{Math.round(traceDurationMs)} ms</span> · {data.spans.length} span
        </p>
      </div>

      <div className="bg-surface-2 border border-border rounded-xl p-4">
        {roots.map((root) => (
          <SpanRow key={root.span_id} node={root} depth={0} traceDurationMs={traceDurationMs} />
        ))}
      </div>

      <div className="bg-surface-2 border border-border rounded-xl p-4 mt-4">
        <p className="text-sm font-medium mb-3">Span detayları (attributes)</p>
        <div className="flex flex-col gap-3">
          {data.spans.map((s) => (
            <div key={s.span_id} className="text-xs">
              <p className="font-medium">{s.service_name} — {s.operation_name}</p>
              <div className="flex gap-3 flex-wrap mt-1 text-text-secondary">
                {Object.entries(s.attributes).map(([k, v]) => (
                  <span key={k} className="px-1.5 py-0.5 rounded bg-surface-0 border border-border">{k}: {v}</span>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
