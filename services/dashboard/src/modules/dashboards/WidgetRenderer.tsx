import { KpiCardWidget } from "./widgets/KpiCardWidget";
import { ProblemListWidget } from "./widgets/ProblemListWidget";
import { DeviceStatusWidget } from "./widgets/DeviceStatusWidget";
import { GraphWidget } from "./widgets/GraphWidget";
import { SeverityDistributionWidget } from "./widgets/SeverityDistributionWidget";
import { ProblemDevicesWidget } from "./widgets/ProblemDevicesWidget";
import { TopNWidget } from "./widgets/TopNWidget";
import { PlatformSummaryWidget } from "./widgets/PlatformSummaryWidget";
import { ServiceHealthWidget } from "./widgets/ServiceHealthWidget";
import { EscalationHistoryWidget } from "./widgets/EscalationHistoryWidget";
import { MaintenanceWindowsWidget } from "./widgets/MaintenanceWindowsWidget";
import type { DashboardWidget, DashboardContext } from "../../api/dashboards";

// dashboardContext, panonun üstündeki bağlam seçicisinin o anki değeridir.
// Sadece cihaz/host-grubu kapsamı olan widget tipleri bunu kullanır.
export function WidgetRenderer({ widget, dashboardContext }: { widget: DashboardWidget; dashboardContext?: DashboardContext }) {
  const effectiveConfig = {
    ...widget.config,
    device_group_id: widget.config.device_group_id || dashboardContext?.deviceGroupId
  };

  switch (widget.widget_type) {
    case "kpi_card":
      return <KpiCardWidget config={widget.config} title={widget.title} />;
    case "problem_list":
      return <ProblemListWidget config={widget.config} title={widget.title} />;
    case "device_status":
      return <DeviceStatusWidget config={widget.config} title={widget.title} dashboardContext={dashboardContext} />;
    case "graph":
      return <GraphWidget config={widget.config} title={widget.title} dashboardContext={dashboardContext} />;
    case "severity_distribution":
      return <SeverityDistributionWidget config={effectiveConfig} title={widget.title} />;
    case "problem_devices":
      return <ProblemDevicesWidget config={effectiveConfig} title={widget.title} />;
    case "top_n":
      return <TopNWidget config={effectiveConfig} title={widget.title} />;
    case "platform_summary":
      return <PlatformSummaryWidget config={widget.config} title={widget.title} />;
    case "service_health":
      return <ServiceHealthWidget config={widget.config} title={widget.title} />;
    case "escalation_history":
      return <EscalationHistoryWidget config={widget.config} title={widget.title} />;
    case "maintenance_windows":
      return <MaintenanceWindowsWidget config={widget.config} title={widget.title} />;
    default:
      return <p className="text-xs text-text-muted p-2">Bilinmeyen widget tipi: {widget.widget_type}</p>;
  }
}
