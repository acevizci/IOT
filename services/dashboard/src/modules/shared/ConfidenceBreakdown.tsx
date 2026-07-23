import { Link } from "react-router-dom";
import type { ConfidenceBreakdown } from "../../api/incidents";

// RCA incelemesi -- rootCause.ts'in confidence = relationship_weight ×
// temporal_score × hierarchy_weight × hop_decay formülünü hesapladığı halde
// eskiden sadece nihai sayı gösteriliyordu. Bu bileşen IncidentDetail,
// IncidentList (tooltip) ve DeviceDetail'in RCA panelinde AYNI dökümü gösterir.

export function relationshipLabel(weight: number): string {
  if (weight >= 0.95) return "Fiziksel bağlantı (LLDP/CDP)";
  if (weight >= 0.9) return "VMware hiyerarşisi";
  if (weight >= 0.85) return "Servis-host ilişkisi (APM)";
  if (weight >= 0.7) return "Manuel bağlantı";
  return "Trafik ilişkisi (NetFlow)";
}

export function hasBreakdown(b: ConfidenceBreakdown): boolean {
  return b.relationship_weight != null && b.temporal_score != null && b.hierarchy_weight != null && b.hop_decay != null;
}

// Kompakt listelerde (IncidentList tablosu) tam paneli sığdırmak yerine
// native title tooltip'i için kısa özet metni.
export function breakdownTooltip(b: ConfidenceBreakdown, confidence: number): string {
  if (!hasBreakdown(b)) return `confidence: ${confidence}`;
  return (
    `${relationshipLabel(b.relationship_weight!)} (${b.relationship_weight!.toFixed(2)}) × ` +
    `zamansal ${b.temporal_score!.toFixed(1)} × hiyerarşi ${b.hierarchy_weight!.toFixed(2)} × ` +
    `mesafe cezası ${b.hop_decay!.toFixed(2)}${b.hop_distance != null ? ` (${b.hop_distance} adım)` : ""} ≈ ${confidence}`
  );
}

export function ConfidenceBreakdownPanel({ breakdown, confidence }: { breakdown: ConfidenceBreakdown; confidence: number }) {
  const { relationship_weight, temporal_score, hierarchy_weight, hop_decay, hop_distance } = breakdown;
  if (!hasBreakdown(breakdown)) {
    return <p className="text-xs text-text-muted">Bu değerlendirme eski bir sürümde yapıldığı için detaylı döküm mevcut değil.</p>;
  }
  const rows = [
    { label: "Bağlantı tipi", value: relationship_weight!.toFixed(2), hint: relationshipLabel(relationship_weight!) },
    { label: "Zamansal yakınlık", value: temporal_score!.toFixed(1), hint: "komşudaki alarm ne kadar erken başladı (100 = eş zamanlı)" },
    { label: "Hiyerarşi merkeziyeti", value: hierarchy_weight!.toFixed(2), hint: "komşunun bağlantı sayısı / cihazınızın bağlantı sayısı" },
    {
      label: "Mesafe cezası",
      value: hop_decay!.toFixed(2),
      hint: hop_distance != null ? `${hop_distance} adım uzaklık` : undefined
    }
  ];
  return (
    <div>
      <div className="grid grid-cols-2 gap-2">
        {rows.map((r) => (
          <div key={r.label} className="bg-surface-1 rounded-md px-2 py-1.5">
            <p className="text-[11px] text-text-secondary">{r.label}</p>
            {r.hint && <p className="text-[10px] text-text-muted mt-0.5">{r.hint}</p>}
            <p className="font-mono font-medium text-sm mt-0.5">{r.value}</p>
          </div>
        ))}
      </div>
      <p className="text-[11px] text-text-muted mt-2 font-mono">
        {relationship_weight!.toFixed(2)} × {temporal_score!.toFixed(1)} × {hierarchy_weight!.toFixed(2)} × {hop_decay!.toFixed(2)} ≈ confidence {confidence}
      </p>
    </div>
  );
}

export interface PathStep {
  id: string;
  name: string;
}

export function PathChain({ steps }: { steps: PathStep[] }) {
  if (steps.length < 2) return null;
  return (
    <div className="flex items-center flex-wrap gap-1">
      {steps.map((s, i) => (
        <span key={`${s.id}-${i}`} className="flex items-center gap-1">
          <Link
            to={`/devices/${s.id}`}
            className={`px-1.5 py-0.5 rounded border text-[11px] hover:text-text-accent ${
              i === steps.length - 1 ? "border-[var(--text-accent)] font-medium" : "border-border bg-surface-1"
            }`}
          >
            {s.name}
          </Link>
          {i < steps.length - 1 && <span className="text-text-muted text-[11px]">→</span>}
        </span>
      ))}
    </div>
  );
}
