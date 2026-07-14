import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AuthProvider, useAuth } from "./auth/AuthContext";
import { DashboardLayout } from "./layouts/DashboardLayout";
import { DashboardPage } from "./modules/dashboards/DashboardPage";
import { DeviceList } from "./modules/devices/DeviceList";
import { DeviceDetail } from "./modules/devices/DeviceDetail";
import { AlertList } from "./modules/alerts/AlertList";
import { AlertDetail } from "./modules/alerts/AlertDetail";
import { TrafficPage } from "./modules/traffic/TrafficPage";
import { TopologyPage } from "./modules/topology/TopologyPage";
import { DeviceGroupList } from "./modules/deviceGroups/DeviceGroupList";
import { DeviceGroupDetail } from "./modules/deviceGroups/DeviceGroupDetail";
import { TemplateList } from "./modules/templates/TemplateList";
import { TemplateDetail } from "./modules/templates/TemplateDetail";
import { UserList } from "./modules/users/UserList";
import { NotificationSettings } from "./modules/notifications/NotificationSettings";
import { MaintenanceList } from "./modules/maintenance/MaintenanceList";
import { MaintenanceDetail } from "./modules/maintenance/MaintenanceDetail";
import { MacroList } from "./modules/macros/MacroList";
import { ValueMapList } from "./modules/valueMaps/ValueMapList";
import { WebScenarioDetail } from "./modules/webScenarios/WebScenarioDetail";
import { AuditLogList } from "./modules/auditLog/AuditLogList";
import { AgentManagementPage } from "./modules/agentRegistration/AgentManagementPage";
import { LoginPage } from "./modules/auth/LoginPage";
import { RegisterPage } from "./modules/auth/RegisterPage";

const queryClient = new QueryClient();

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { isAuthenticated } = useAuth();
  if (!isAuthenticated) return <Navigate to="/login" replace />;
  return <DashboardLayout>{children}</DashboardLayout>;
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <BrowserRouter>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route path="/register" element={<RegisterPage />} />
            <Route path="/dashboard" element={<ProtectedRoute><DashboardPage /></ProtectedRoute>} />
            <Route path="/devices" element={<ProtectedRoute><DeviceList /></ProtectedRoute>} />
            <Route path="/devices/:id" element={<ProtectedRoute><DeviceDetail /></ProtectedRoute>} />
            <Route path="/alerts" element={<ProtectedRoute><AlertList /></ProtectedRoute>} />
            <Route path="/alerts/:id" element={<ProtectedRoute><AlertDetail /></ProtectedRoute>} />
            <Route path="/traffic" element={<ProtectedRoute><TrafficPage /></ProtectedRoute>} />
            <Route path="/topology" element={<ProtectedRoute><TopologyPage /></ProtectedRoute>} />
            <Route path="/device-groups" element={<ProtectedRoute><DeviceGroupList /></ProtectedRoute>} />
            <Route path="/device-groups/:id" element={<ProtectedRoute><DeviceGroupDetail /></ProtectedRoute>} />
            <Route path="/templates" element={<ProtectedRoute><TemplateList /></ProtectedRoute>} />
            <Route path="/templates/:id" element={<ProtectedRoute><TemplateDetail /></ProtectedRoute>} />
            <Route path="/users" element={<ProtectedRoute><UserList /></ProtectedRoute>} />
            <Route path="/notifications" element={<ProtectedRoute><NotificationSettings /></ProtectedRoute>} />
            <Route path="/maintenance" element={<ProtectedRoute><MaintenanceList /></ProtectedRoute>} />
            <Route path="/maintenance/:id" element={<ProtectedRoute><MaintenanceDetail /></ProtectedRoute>} />
            <Route path="/macros" element={<ProtectedRoute><MacroList /></ProtectedRoute>} />
            <Route path="/value-maps" element={<ProtectedRoute><ValueMapList /></ProtectedRoute>} />
            <Route path="/web-scenarios/:id" element={<ProtectedRoute><WebScenarioDetail /></ProtectedRoute>} />
            <Route path="/audit-log" element={<ProtectedRoute><AuditLogList /></ProtectedRoute>} />
            <Route path="/agent-registration" element={<ProtectedRoute><AgentManagementPage /></ProtectedRoute>} />
            <Route path="*" element={<Navigate to="/dashboard" replace />} />
          </Routes>
        </BrowserRouter>
      </AuthProvider>
    </QueryClientProvider>
  );
}
