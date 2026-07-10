import { KpiCardWidget } from "./widgets/KpiCardWidget";
import { ProblemListWidget } from "./widgets/ProblemListWidget";
import { DeviceStatusWidget } from "./widgets/DeviceStatusWidget";
import { GraphWidget } from "./widgets/GraphWidget";
import type { DashboardWidget, DashboardContext } from "../../api/dashboards";

// Faz 9.5 — dashboardContext, panonun üstündeki bağlam seçicisinin o anki değeridir.
// Sadece cihaz/host-grubu kapsamı olan widget tipleri (graph, device_status) bunu
// kullanır; kpi_card/problem_list'in zaten böyle bir kapsamı yok.
export function WidgetRenderer({ widget, dashboardContext }: { widget: DashboardWidget; dashboardContext?: DashboardContext }) {
  switch (widget.widget_type) {
    case "kpi_card":
      return <KpiCardWidget config={widget.config} title={widget.title} />;
    case "problem_list":
      return <ProblemListWidget config={widget.config} title={widget.title} />;
    case "device_status":
      return <DeviceStatusWidget config={widget.config} title={widget.title} dashboardContext={dashboardContext} />;
    case "graph":
      return <GraphWidget config={widget.config} title={widget.title} dashboardContext={dashboardContext} />;
    default:
      return <p className="text-xs text-text-muted p-2">Bilinmeyen widget tipi: {widget.widget_type}</p>;
  }
}
