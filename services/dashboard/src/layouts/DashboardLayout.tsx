import { ReactNode } from "react";
import { NavLink } from "react-router-dom";

const navItems = [
  { to: "/dashboard", label: "Genel bakış", icon: "📊" },
  { to: "/devices", label: "Cihazlar", icon: "🖧" },
  { to: "/alerts", label: "Alarmlar", icon: "🔔" }
];

export function DashboardLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen">
      <aside className="w-52 shrink-0 border-r border-border p-3">
        <p className="font-medium text-sm mb-4 px-2">Obs Platform</p>
        {navItems.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            className={({ isActive }) =>
              `flex items-center gap-2 px-3 py-2 rounded-md text-sm mb-1 ${
                isActive ? "bg-[var(--bg-accent)] text-[var(--text-accent)]" : "text-text-secondary"
              }`
            }
          >
            <span>{item.icon}</span>
            {item.label}
          </NavLink>
        ))}
      </aside>
      <main className="flex-1 p-6">{children}</main>
    </div>
  );
}
