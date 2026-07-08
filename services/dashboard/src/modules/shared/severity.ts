export const SEVERITY_LEVELS = ["info", "warning", "average", "high", "disaster"] as const;
export type Severity = (typeof SEVERITY_LEVELS)[number];

export const SEVERITY_LABEL: Record<string, string> = {
  info: "Bilgi",
  warning: "Uyarı",
  average: "Orta",
  high: "Yüksek",
  disaster: "Felaket",
  critical: "Kritik"
};

// Zabbix'in renk mantığına yakın: info gri, warning sarı, average turuncu, high/disaster kırmızı tonları
export const SEVERITY_STYLES: Record<string, string> = {
  info: "bg-surface-1 text-text-secondary",
  warning: "bg-[var(--bg-warning)] text-[var(--text-warning)]",
  average: "bg-[var(--bg-warning)] text-[var(--text-warning)]",
  high: "bg-[var(--bg-danger)] text-[var(--text-danger)]",
  disaster: "bg-[var(--bg-danger)] text-[var(--text-danger)]",
  critical: "bg-[var(--bg-danger)] text-[var(--text-danger)]"
};

export const SEVERITY_DOT: Record<string, string> = {
  info: "bg-text-muted",
  warning: "bg-[var(--text-warning)]",
  average: "bg-[var(--text-warning)]",
  high: "bg-[var(--text-danger)]",
  disaster: "bg-[var(--text-danger)]",
  critical: "bg-[var(--text-danger)]"
};
