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
import { DeviceCardWidget } from "./widgets/DeviceCardWidget";
import { StatusBadgeWidget } from "./widgets/StatusBadgeWidget";
import { RawTableWidget } from "./widgets/RawTableWidget";
import { NoteWidget } from "./widgets/NoteWidget";
import { ClockWidget } from "./widgets/ClockWidget";
import { UrlWidget } from "./widgets/UrlWidget";
import { GaugeWidget } from "./widgets/GaugeWidget";
import { PieChartWidget } from "./widgets/PieChartWidget";
import { DeviceExplorerWidget } from "./widgets/DeviceExplorerWidget";
import { StatusGridWidget } from "./widgets/StatusGridWidget";
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
    case "device_card":
      return <DeviceCardWidget config={widget.config} title={widget.title} />;
    case "status_badge":
      return <StatusBadgeWidget config={widget.config} title={widget.title} />;
    case "raw_table":
      return <RawTableWidget config={widget.config} title={widget.title} />;
    case "note":
      return <NoteWidget config={widget.config} title={widget.title} />;
    case "clock":
      return <ClockWidget config={widget.config} title={widget.title} />;
    case "url":
      return <UrlWidget config={widget.config} title={widget.title} />;
    case "gauge":
      return <GaugeWidget config={widget.config} title={widget.title} />;
    case "pie_chart":
      return <PieChartWidget config={effectiveConfig} title={widget.title} />;
    case "device_explorer":
      return <DeviceExplorerWidget config={effectiveConfig} title={widget.title} />;
    case "status_grid":
      return <StatusGridWidget config={effectiveConfig} title={widget.title} />;
    default:
      return <p className="text-xs text-text-muted p-2">Bilinmeyen widget tipi: {widget.widget_type}</p>;
  }
}
