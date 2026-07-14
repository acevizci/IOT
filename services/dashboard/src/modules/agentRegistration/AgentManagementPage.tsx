import { useState } from "react";
import { AgentRegistrationPage } from "./AgentRegistrationPage";
import { AgentReleaseList } from "../agentReleases/AgentReleaseList";

const TABS = [
  { key: "registration", label: "Agent Kaydı" },
  { key: "releases", label: "Agent Sürümleri" }
] as const;

// "Agent Kaydı" (token oluşturma) ve "Agent Sürümleri" (self-update yönetimi) ayrı
// navigasyon linkleri olarak dururken kafa karıştırıcıydı -- ikisi de aynı "agent
// yönetimi" kapsamına giriyor. Tek bir sayfa altında sekmeler hâlinde birleştirildi.
export function AgentManagementPage() {
  const [tab, setTab] = useState<(typeof TABS)[number]["key"]>("registration");

  return (
    <div>
      <div className="flex items-center gap-1 px-6 pt-5 border-b border-border">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`px-3.5 py-2 text-sm rounded-t-lg transition-colors ${
              tab === t.key
                ? "bg-surface-2 text-text-accent font-medium border border-border border-b-0"
                : "text-text-secondary hover:bg-surface-1"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>
      {tab === "registration" ? <AgentRegistrationPage /> : <AgentReleaseList />}
    </div>
  );
}
