import { lazy, Suspense } from "react";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AuthProvider, useAuth } from "./auth/AuthContext";
import { DashboardLayout } from "./layouts/DashboardLayout";

// Rota bileşenleri tembel yüklenir (route bazlı kod bölme). Böylece ilk açılışta
// yalnızca ihtiyaç duyulan sayfa indirilir; recharts/xlsx gibi ağır bağımlılıklar
// ilgili sayfa açılana kadar bundle'a girmez. Modüller isim (named) export ettiği
// için default'a eşliyoruz.
const lazyNamed = <T extends Record<string, unknown>>(
  factory: () => Promise<T>,
  name: keyof T
) => lazy(() => factory().then((m) => ({ default: m[name] as React.ComponentType })));

const DashboardPage = lazyNamed(() => import("./modules/dashboards/DashboardPage"), "DashboardPage");
const DeviceList = lazyNamed(() => import("./modules/devices/DeviceList"), "DeviceList");
const DeviceDetail = lazyNamed(() => import("./modules/devices/DeviceDetail"), "DeviceDetail");
const AlertList = lazyNamed(() => import("./modules/alerts/AlertList"), "AlertList");
const AlertDetail = lazyNamed(() => import("./modules/alerts/AlertDetail"), "AlertDetail");
const TopologyPage = lazyNamed(() => import("./modules/topology/TopologyPage"), "TopologyPage");
const IncidentList = lazyNamed(() => import("./modules/incidents/IncidentList"), "IncidentList");
const IncidentDetail = lazyNamed(() => import("./modules/incidents/IncidentDetail"), "IncidentDetail");
const ApmServiceList = lazyNamed(() => import("./modules/apm/ApmServiceList"), "ApmServiceList");
const ApmTraceList = lazyNamed(() => import("./modules/apm/ApmTraceList"), "ApmTraceList");
const ApmTraceDetail = lazyNamed(() => import("./modules/apm/ApmTraceDetail"), "ApmTraceDetail");
const NetworkDiscoveryPage = lazyNamed(() => import("./modules/discovery/NetworkDiscoveryPage"), "NetworkDiscoveryPage");
const DeviceGroupList = lazyNamed(() => import("./modules/deviceGroups/DeviceGroupList"), "DeviceGroupList");
const DeviceGroupDetail = lazyNamed(() => import("./modules/deviceGroups/DeviceGroupDetail"), "DeviceGroupDetail");
const TemplateList = lazyNamed(() => import("./modules/templates/TemplateList"), "TemplateList");
const TemplateDetail = lazyNamed(() => import("./modules/templates/TemplateDetail"), "TemplateDetail");
const UserList = lazyNamed(() => import("./modules/users/UserList"), "UserList");
const TenantsPage = lazyNamed(() => import("./modules/tenants/TenantsPage"), "TenantsPage");
const UserGroupList = lazyNamed(() => import("./modules/userGroups/UserGroupList"), "UserGroupList");
const UserGroupDetail = lazyNamed(() => import("./modules/userGroups/UserGroupDetail"), "UserGroupDetail");
const NotificationSettings = lazyNamed(() => import("./modules/notifications/NotificationSettings"), "NotificationSettings");
const MaintenanceList = lazyNamed(() => import("./modules/maintenance/MaintenanceList"), "MaintenanceList");
const MaintenanceDetail = lazyNamed(() => import("./modules/maintenance/MaintenanceDetail"), "MaintenanceDetail");
const MacroList = lazyNamed(() => import("./modules/macros/MacroList"), "MacroList");
const ValueMapList = lazyNamed(() => import("./modules/valueMaps/ValueMapList"), "ValueMapList");
const SyslogPatternList = lazyNamed(() => import("./modules/syslogPatterns/SyslogPatternList"), "SyslogPatternList");
const WebScenarioDetail = lazyNamed(() => import("./modules/webScenarios/WebScenarioDetail"), "WebScenarioDetail");
const AuditLogList = lazyNamed(() => import("./modules/auditLog/AuditLogList"), "AuditLogList");
const QueuePage = lazyNamed(() => import("./modules/queue/QueuePage"), "QueuePage");
const AgentManagementPage = lazyNamed(() => import("./modules/agentRegistration/AgentManagementPage"), "AgentManagementPage");
const ProxySetupPage = lazyNamed(() => import("./modules/proxy/ProxySetupPage"), "ProxySetupPage");
const ProxyListPage = lazyNamed(() => import("./modules/proxy/ProxyListPage"), "ProxyListPage");
const LoginPage = lazyNamed(() => import("./modules/auth/LoginPage"), "LoginPage");
const RegisterPage = lazyNamed(() => import("./modules/auth/RegisterPage"), "RegisterPage");

// GERÇEK HATA DÜZELTMESİ (canlı ortamda gözlemlendi -- "429 fırtınası"):
// varsayılan QueryClient her başarısız isteği (429 dahil) 3 kez tekrar dener.
// Birden fazla widget aynı anda gateway'in dakikalık rate limit'ine (300/dk,
// bkz. core-service) takılınca, HEPSİ aynı anda tekrar deniyor -- bu da AYNI
// pencerede istek sayısını katlayarak artırıp limitin hiç boşalmamasına yol
// açıyordu. 429'da tekrar denemeyi tamamen kapatıyoruz -- zaten her query'nin
// kendi refetchInterval'ı (genelde 30sn) bir sonraki normal turda otomatik
// tekrar dener, ayrıca bir retry'a gerek yok.
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (failureCount, error) => {
        if ((error as Error & { status?: number })?.status === 429) return false;
        return failureCount < 3;
      }
    }
  }
});

function PageFallback() {
  return (
    <div className="min-h-[40vh] flex items-center justify-center text-sm text-text-muted">
      Yükleniyor…
    </div>
  );
}

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
          <Suspense fallback={<PageFallback />}>
            <Routes>
              <Route path="/login" element={<LoginPage />} />
              <Route path="/register" element={<RegisterPage />} />
              <Route path="/dashboard" element={<ProtectedRoute><DashboardPage /></ProtectedRoute>} />
              <Route path="/devices" element={<ProtectedRoute><DeviceList /></ProtectedRoute>} />
              <Route path="/devices/:id" element={<ProtectedRoute><DeviceDetail /></ProtectedRoute>} />
              <Route path="/discovery" element={<ProtectedRoute><NetworkDiscoveryPage /></ProtectedRoute>} />
              <Route path="/alerts" element={<ProtectedRoute><AlertList /></ProtectedRoute>} />
              <Route path="/alerts/:id" element={<ProtectedRoute><AlertDetail /></ProtectedRoute>} />
              <Route path="/topology" element={<ProtectedRoute><TopologyPage /></ProtectedRoute>} />
              <Route path="/incidents" element={<ProtectedRoute><IncidentList /></ProtectedRoute>} />
              <Route path="/incidents/:id" element={<ProtectedRoute><IncidentDetail /></ProtectedRoute>} />
              <Route path="/apm" element={<ProtectedRoute><ApmServiceList /></ProtectedRoute>} />
              <Route path="/apm/traces" element={<ProtectedRoute><ApmTraceList /></ProtectedRoute>} />
              <Route path="/apm/traces/:traceId" element={<ProtectedRoute><ApmTraceDetail /></ProtectedRoute>} />
              <Route path="/device-groups" element={<ProtectedRoute><DeviceGroupList /></ProtectedRoute>} />
              <Route path="/device-groups/:id" element={<ProtectedRoute><DeviceGroupDetail /></ProtectedRoute>} />
              <Route path="/templates" element={<ProtectedRoute><TemplateList /></ProtectedRoute>} />
              <Route path="/templates/:id" element={<ProtectedRoute><TemplateDetail /></ProtectedRoute>} />
              <Route path="/users" element={<ProtectedRoute><UserList /></ProtectedRoute>} />
              <Route path="/tenants" element={<ProtectedRoute><TenantsPage /></ProtectedRoute>} />
              <Route path="/user-groups" element={<ProtectedRoute><UserGroupList /></ProtectedRoute>} />
              <Route path="/user-groups/:id" element={<ProtectedRoute><UserGroupDetail /></ProtectedRoute>} />
              <Route path="/notifications" element={<ProtectedRoute><NotificationSettings /></ProtectedRoute>} />
              <Route path="/maintenance" element={<ProtectedRoute><MaintenanceList /></ProtectedRoute>} />
              <Route path="/maintenance/:id" element={<ProtectedRoute><MaintenanceDetail /></ProtectedRoute>} />
              <Route path="/macros" element={<ProtectedRoute><MacroList /></ProtectedRoute>} />
              <Route path="/value-maps" element={<ProtectedRoute><ValueMapList /></ProtectedRoute>} />
              <Route path="/syslog-patterns" element={<ProtectedRoute><SyslogPatternList /></ProtectedRoute>} />
              <Route path="/web-scenarios/:id" element={<ProtectedRoute><WebScenarioDetail /></ProtectedRoute>} />
              <Route path="/audit-log" element={<ProtectedRoute><AuditLogList /></ProtectedRoute>} />
              <Route path="/agent-registration" element={<ProtectedRoute><AgentManagementPage /></ProtectedRoute>} />
              <Route path="/proxy-setup" element={<ProtectedRoute><ProxySetupPage /></ProtectedRoute>} />
              <Route path="/proxies" element={<ProtectedRoute><ProxyListPage /></ProtectedRoute>} />
              <Route path="/queue" element={<ProtectedRoute><QueuePage /></ProtectedRoute>} />
              <Route path="*" element={<Navigate to="/dashboard" replace />} />
            </Routes>
          </Suspense>
        </BrowserRouter>
      </AuthProvider>
    </QueryClientProvider>
  );
}
