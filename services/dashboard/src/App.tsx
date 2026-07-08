import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AuthProvider, useAuth } from "./auth/AuthContext";
import { DashboardLayout } from "./layouts/DashboardLayout";
import { Overview } from "./modules/dashboard/Overview";
import { DeviceList } from "./modules/devices/DeviceList";
import { DeviceDetail } from "./modules/devices/DeviceDetail";
import { AlertList } from "./modules/alerts/AlertList";
import { AlertRules } from "./modules/settings/AlertRules";
import { TrafficPage } from "./modules/traffic/TrafficPage";
import { TopologyPage } from "./modules/topology/TopologyPage";
import { DeviceGroupList } from "./modules/deviceGroups/DeviceGroupList";
import { DeviceGroupDetail } from "./modules/deviceGroups/DeviceGroupDetail";
import { TemplateList } from "./modules/templates/TemplateList";
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
            <Route path="/dashboard" element={<ProtectedRoute><Overview /></ProtectedRoute>} />
            <Route path="/devices" element={<ProtectedRoute><DeviceList /></ProtectedRoute>} />
            <Route path="/devices/:id" element={<ProtectedRoute><DeviceDetail /></ProtectedRoute>} />
            <Route path="/alerts" element={<ProtectedRoute><AlertList /></ProtectedRoute>} />
            <Route path="/traffic" element={<ProtectedRoute><TrafficPage /></ProtectedRoute>} />
            <Route path="/topology" element={<ProtectedRoute><TopologyPage /></ProtectedRoute>} />
            <Route path="/device-groups" element={<ProtectedRoute><DeviceGroupList /></ProtectedRoute>} />
            <Route path="/device-groups/:id" element={<ProtectedRoute><DeviceGroupDetail /></ProtectedRoute>} />
            <Route path="/templates" element={<ProtectedRoute><TemplateList /></ProtectedRoute>} />
            <Route path="/settings" element={<Navigate to="/settings/alert-rules" replace />} />
            <Route path="/settings/alert-rules" element={<ProtectedRoute><AlertRules /></ProtectedRoute>} />
            <Route path="*" element={<Navigate to="/dashboard" replace />} />
          </Routes>
        </BrowserRouter>
      </AuthProvider>
    </QueryClientProvider>
  );
}
