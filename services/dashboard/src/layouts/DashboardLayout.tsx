import { ReactNode, useState } from "react";
import { NavLink, useLocation, useNavigate } from "react-router-dom";
import {
  LayoutDashboard, Router, Bell, Server, Activity, Share2,
  Eye, Settings, UsersRound, ChevronDown, ChevronRight,
  SlidersHorizontal, Folders, LayoutTemplate, Users, Mail, LogOut, Clock, Variable, ScrollText, Tag, Download, PlusCircle
} from "lucide-react";
import { useAlerts } from "../modules/alerts/useAlerts";
import { useAuth } from "../auth/AuthContext";

interface NavItemDef {
  to?: string;
  label: string;
  icon: ReactNode;
  badge?: number;
  disabled?: boolean;
  disabledLabel?: string;
}

interface NavGroupDef {
  key: string;
  label: string;
  icon: ReactNode;
  items: NavItemDef[];
}

export function DashboardLayout({ children }: { children: ReactNode }) {
  const { data: alertsData } = useAlerts({ status: "open" });
  const openAlertCount = alertsData?.total ?? 0;
  const { logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const groups: NavGroupDef[] = [
    {
      key: "monitoring",
      label: "İzleme",
      icon: <Eye size={16} />,
      items: [
        { to: "/dashboard", label: "Genel bakış", icon: <LayoutDashboard size={15} /> },
        { to: "/alerts", label: "Alarmlar", icon: <Bell size={15} />, badge: openAlertCount > 0 ? openAlertCount : undefined },
        { to: "/topology", label: "Topoloji", icon: <Share2 size={15} /> }
      ]
    },
    {
      key: "configuration",
      label: "Yapılandırma",
      icon: <Settings size={16} />,
      items: [
        { to: "/devices", label: "Hostlar", icon: <Router size={15} /> },
        { to: "/agent-registration", label: "Agent Kaydı", icon: <PlusCircle size={15} /> },
        { to: "/device-groups", label: "Host grupları", icon: <Folders size={15} /> },
        { to: "/templates", label: "Şablonlar", icon: <LayoutTemplate size={15} /> },
        { to: "/maintenance", label: "Bakım pencereleri", icon: <Clock size={15} /> },
        { to: "/macros", label: "Makrolar", icon: <Variable size={15} /> },
        { to: "/value-maps", label: "Value Maps", icon: <Tag size={15} /> },
      ]
    },
    {
      key: "administration",
      label: "Yönetim",
      icon: <UsersRound size={16} />,
      items: [
        { to: "/users", label: "Kullanıcılar", icon: <Users size={15} /> },
        { to: "/notifications", label: "Bildirim kanalları", icon: <Mail size={15} /> },
        { to: "/audit-log", label: "Denetim kaydı", icon: <ScrollText size={15} /> }
      ]
    }
  ];

  const activeGroupKey = groups.find((g) => g.items.some((i) => i.to && location.pathname.startsWith(i.to)))?.key;
  const [expandedKey, setExpandedKey] = useState<string | undefined>(activeGroupKey ?? "monitoring");

  function handleLogout() {
    logout();
    navigate("/login");
  }

  return (
    <div className="flex min-h-screen">
      <aside className="w-56 shrink-0 border-r border-border p-3 flex flex-col gap-0.5">
        <div className="flex items-center gap-2 px-2 py-2 mb-2">
          <Server size={20} className="text-text-accent" />
          <span className="text-[15px] font-medium">Obs Platform</span>
        </div>

        {groups.map((group) => {
          const isExpanded = expandedKey === group.key;
          return (
            <div key={group.key} className="mb-0.5">
              <button
                onClick={() => setExpandedKey(isExpanded ? undefined : group.key)}
                className="flex items-center gap-2 px-2.5 py-2 rounded-md text-[13.5px] font-medium text-text-secondary hover:bg-surface-1 w-full text-left"
              >
                {group.icon}
                <span className="flex-1">{group.label}</span>
                {isExpanded ? <ChevronDown size={15} className="text-text-muted" /> : <ChevronRight size={15} className="text-text-muted" />}
              </button>

              {isExpanded && (
                <div className="flex flex-col ml-[19px] pl-3.5 border-l border-border mb-1">
                  {group.items.map((item) => (
                    <NavRow key={item.label} item={item} />
                  ))}
                </div>
              )}
            </div>
          );
        })}

        <div className="mt-auto pt-3 border-t border-border">
          <button onClick={handleLogout} className="flex items-center gap-2.5 px-2.5 py-2 rounded-md text-sm text-text-secondary hover:bg-surface-1 w-full text-left">
            <LogOut size={16} />
            Çıkış yap
          </button>
        </div>
      </aside>
      <main className="flex-1 p-6 bg-surface-0">{children}</main>
    </div>
  );
}

function NavRow({ item }: { item: NavItemDef }) {
  if (item.disabled || !item.to) {
    return (
      <div className="flex items-center gap-2 px-2.5 py-1.5 rounded-md text-[13px] text-text-muted">
        {item.icon}
        <span className="flex-1">{item.label}</span>
        {item.disabledLabel && <span className="text-[11px]">{item.disabledLabel}</span>}
      </div>
    );
  }

  return (
    <NavLink
      to={item.to}
      className={({ isActive }) =>
        `flex items-center gap-2 px-2.5 py-1.5 rounded-md text-[13px] ${
          isActive ? "bg-[var(--bg-accent)] text-[var(--text-accent)] font-medium" : "text-text-secondary hover:bg-surface-1"
        }`
      }
    >
      {item.icon}
      <span className="flex-1">{item.label}</span>
      {item.badge !== undefined && (
        <span className="text-[10.5px] font-medium px-[6px] py-[1px] rounded-full bg-[var(--text-danger)] text-white">{item.badge}</span>
      )}
    </NavLink>
  );
}
