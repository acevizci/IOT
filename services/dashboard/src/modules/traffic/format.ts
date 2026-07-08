export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export const PROTOCOL_NAMES: Record<number, string> = {
  1: "ICMP",
  6: "TCP",
  17: "UDP"
};

export function protocolName(protocol: number): string {
  return PROTOCOL_NAMES[protocol] ?? `Protokol ${protocol}`;
}
