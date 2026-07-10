import { KpiCardWidget } from "./widgets/KpiCardWidget";
import { ProblemListWidget } from "./widgets/ProblemListWidget";
import { DeviceStatusWidget } from "./widgets/DeviceStatusWidget";
import { GraphWidget } from "./widgets/GraphWidget";
import type { DashboardWidget } from "../../api/dashboards";

export function WidgetRenderer({ widget }: { widget: DashboardWidget }) {
  switch (widget.widget_type) {
    case "kpi_card":
      return <KpiCardWidget config={widget.config} title={widget.title} />;
    case "problem_list":
      return <ProblemListWidget config={widget.config} title={widget.title} />;
    case "device_status":
      return <DeviceStatusWidget config={widget.config} title={widget.title} />;
    case "graph":
      return <GraphWidget config={widget.config} title={widget.title} />;
    default:
      return <p className="text-xs text-text-muted p-2">Bilinmeyen widget tipi: {widget.widget_type}</p>;
  }
}
