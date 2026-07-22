import { NavLink } from "react-router-dom";
import { useAuth } from "../../auth/AuthContext";

// Kullanıcılar ve Kullanıcı grupları birbirine sıkıca bağlı (biri diğerinin
// üyelik/izin haritasını yönetir) -- Hostlar/Ağ Keşfi/Host Grupları/Şablonlar'ın
// DeviceSectionTabs.tsx'teki deseniyle AYNI mantık: sol menüde tek satır,
// aralarında bu sekme çubuğuyla geçiliyor.
export const USER_SECTION_PATHS: { to: string; label: string; resource: string }[] = [
  { to: "/users", label: "Kullanıcılar", resource: "users" },
  { to: "/user-groups", label: "Kullanıcı grupları", resource: "user_groups" }
];

export function UserSectionTabs() {
  const { permissions } = useAuth();
  const visibleTabs = USER_SECTION_PATHS.filter((t) => permissions[t.resource] !== "none");
  if (visibleTabs.length <= 1) return null;

  return (
    <div className="flex gap-1 bg-surface-1 rounded-md p-1 border border-border w-fit mb-4">
      {visibleTabs.map((tab) => (
        <NavLink
          key={tab.to}
          to={tab.to}
          className={({ isActive }) =>
            `text-xs px-3 py-1.5 rounded ${isActive ? "bg-[var(--bg-accent)] text-[var(--text-accent)] font-medium" : "text-text-secondary"}`
          }
        >
          {tab.label}
        </NavLink>
      ))}
    </div>
  );
}
