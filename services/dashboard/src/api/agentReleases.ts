import { apiFetch } from "./client";

export interface AgentRelease {
  id: string;
  version: string;
  platform: string;
  sha256_checksum: string;
  released_at: string;
}

export function fetchAgentReleases() {
  return apiFetch<AgentRelease[]>("/api/v1/agent-releases");
}

export function publishAgentRelease(input: { version: string; platform: string; file_path: string }) {
  return apiFetch<AgentRelease>("/api/v1/agent-releases", { method: "POST", body: JSON.stringify(input) });
}
