import { ReactNode } from "react";
import { NavLink, useNavigate } from "react-router-dom";
import { LayoutDashboard, Router, Bell, Server, Activity, SlidersHorizontal, LogOut, Share2 } from "lucide-react";
import { useAlerts } from "../modules/alerts/useAlerts";
import { useAuth } from "../auth/AuthContext";

export function DashboardLayout({ children }: { children: ReactNode }) {
  const { data: alerts } = useAlerts("open");
  const openAlertCount = alerts?.length ?? 0;
  const { logout } = useAuth();
  const navigate = useNavigate();

  function handleLogout() {
    logout();
    navigate("/login");
  }

  return (
    <div className="flex min-h-screen">
      <aside className="w-56 shrink-0 border-r border-border p-3 flex flex-col gap-1">
        <div className="flex items-center gap-2 px-2 py-2 mb-3">
          <Server size={20} className="text-text-accent" />
          <span className="text-[15px] font-medium">Obs Platform</span>
        </div>

        <NavItem to="/dashboard" icon={<LayoutDashboard size={18} />} label="Genel bakış" />
        <NavItem to="/devices" icon={<Router size={18} />} label="Cihazlar" />
        <NavItem to="/alerts" icon={<Bell size={18} />} label="Alarmlar" badge={openAlertCount > 0 ? openAlertCount : undefined} />
        <NavItem to="/traffic" icon={<Activity size={18} />} label="Trafik" />
        <NavItem to="/topology" icon={<Share2 size={18} />} label="Topoloji" />

        <div className="mt-auto pt-3 border-t border-border">
          <NavItem to="/settings/alert-rules" icon={<SlidersHorizontal size={18} />} label="Alarm kuralları" />
          <button onClick={handleLogout} className="flex items-center gap-3 px-3 py-2 rounded-md text-sm text-text-secondary hover:bg-surface-1 w-full text-left">
            <LogOut size={18} />
            Çıkış yap
          </button>
        </div>
      </aside>
      <main className="flex-1 p-6 bg-surface-0">{children}</main>
    </div>
  );
}

function NavItem({
  to, icon, label, badge
}: { to: string; icon: ReactNode; label: string; badge?: number }) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        `flex items-center gap-3 px-3 py-2 rounded-md text-sm ${isActive ? "bg-[var(--bg-accent)] text-[var(--text-accent)] font-medium" : "text-text-secondary hover:bg-surface-1"}`
      }
    >
      {icon}
      <span className="flex-1">{label}</span>
      {badge !== undefined && (
        <span className="text-[11px] font-medium px-[7px] py-[1px] rounded-full bg-[var(--text-danger)] text-white">{badge}</span>
      )}
    </NavLink>
  );
}
