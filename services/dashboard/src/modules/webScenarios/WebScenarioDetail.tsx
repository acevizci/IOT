import { useParams, Link } from "react-router-dom";
import { ArrowLeft, Globe } from "lucide-react";
import { useWebScenario } from "./useWebScenarios";

export function WebScenarioDetail() {
  const { id } = useParams<{ id: string }>();
  const { data: scenario, isLoading } = useWebScenario(id!);

  if (isLoading) return <p className="text-sm text-text-secondary">Yükleniyor...</p>;
  if (!scenario) return <p className="text-sm text-[var(--text-danger)]">Senaryo bulunamadı.</p>;

  return (
    <div>
      <Link to={`/templates/${scenario.template_id}`} className="flex items-center gap-1.5 text-sm text-text-secondary mb-3 w-fit">
        <ArrowLeft size={15} />
        Şablona dön
      </Link>

      <div className="flex items-center gap-2 mb-1">
        <Globe size={18} className="text-text-secondary" />
        <h1 className="text-lg font-medium">{scenario.name}</h1>
      </div>
      <p className="text-sm text-text-secondary mb-5">
        {scenario.polling_interval_seconds}s aralıkla · {scenario.user_agent || "varsayılan User-Agent"}
      </p>

      <p className="text-sm font-medium mb-2">Adımlar ({scenario.steps.length})</p>
      <div className="border border-border rounded-xl overflow-hidden">
        {scenario.steps.map((step) => (
          <div key={step.id} className="px-4 py-3 border-b border-border last:border-0">
            <p className="text-sm font-medium">{step.name}</p>
            <p className="text-xs text-text-muted font-mono mt-0.5">{step.url}</p>
            <p className="text-xs text-text-secondary mt-1">Beklenen durum kodu: {step.expected_status_code}</p>
            <p className="text-[11px] text-text-muted mt-1">
              Otomatik üretilen metrikler: <code>_response_code</code>, <code>_response_time_ms</code>, <code>_status</code>
            </p>
          </div>
        ))}
        {scenario.steps.length === 0 && <p className="text-sm text-text-muted p-4">Adım tanımlanmadı.</p>}
      </div>
    </div>
  );
}
