import { type ReactNode, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import {
  LayoutDashboard, Router, Bell, Share2, ShieldAlert, Activity,
  Eye, Settings, UsersRound, ChevronDown, ChevronRight,
  Users, Mail, LogOut, Clock, Variable, ScrollText, PlusCircle,
  CircleUser, Server
} from "lucide-react";
import { useAlerts } from "../modules/alerts/useAlerts";
import { useAuth } from "../auth/AuthContext";
import { DEVICE_SECTION_PATHS } from "../modules/devices/DeviceSectionTabs";
import { USER_SECTION_PATHS } from "../modules/users/UserSectionTabs";
import { ChangePasswordModal } from "../modules/users/ChangePasswordModal";

// Build zamanında ayarlanabilir (Vite env). Yoksa varsayılan kullanılır.
const APP_VERSION = (import.meta.env.VITE_APP_VERSION as string) ?? "1.0.0";
const ENV_LABEL = (import.meta.env.VITE_ENV_LABEL as string) ?? "Üretim";

interface NavItemDef {
  to?: string;
  label: string;
  icon: ReactNode;
  badge?: number;
  disabled?: boolean;
  disabledLabel?: string;
  resource?: string; // izin haritasındaki kaynak anahtarı -- 'none' ise menüde hiç gösterilmez
  // Hostlar/Ağ Keşfi/Host Grupları/Şablonlar artık TEK satır (DeviceSectionTabs.tsx'teki
  // sekme çubuğuyla aralarında geçiliyor) -- bu satırın aktif/vurgulu görünmesi
  // ve breadcrumb'ın doğru alt-sayfayı göstermesi için hangi rotalardan HERHANGİ
  // birinin eşleştiğini bilmesi gerekiyor (tek bir `to` yetmiyor).
  matchPaths?: string[];
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
  const { logout, permissions, isSuperadmin } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [showAccountMenu, setShowAccountMenu] = useState(false);
  const [showChangePassword, setShowChangePassword] = useState(false);

  // Hostlar, Ağ Keşfi, Host Grupları, Şablonlar birbirine sıkıca bağlı (hepsi
  // cihaz envanteri/yapılandırması) -- artık kendi sayfalarının üstündeki
  // DeviceSectionTabs sekme çubuğuyla birbirine bağlılar (bkz. modules/devices/
  // DeviceSectionTabs.tsx -- DEVICE_SECTION_PATHS oradan import ediliyor, tek
  // kaynak), bu yüzden sol menüde 4 AYRI satır olarak kalmalarının anlamı
  // kalmadı (sadece kalabalık ederdi). İzin kaynakları FARKLI (devices /
  // device_groups / templates) olduğu için basitçe tek bir `resource`'a
  // indirgenemiyor -- görünürlük ayrı hesaplanıyor (herhangi biri erişilebilirse
  // satır gösterilir), rota da erişilebilir OLAN İLK sayfaya gider.
  const accessibleDevicePaths = DEVICE_SECTION_PATHS.filter((p) => permissions[p.resource] !== "none");
  // Kullanıcılar + Kullanıcı grupları -- Cihazlar'la AYNI mantık (bkz. modules/
  // users/UserSectionTabs.tsx): iki ayrı sayfa ama izin kaynakları farklı
  // (users / user_groups) olduğu için görünürlük ayrı hesaplanıyor.
  const accessibleUserPaths = USER_SECTION_PATHS.filter((p) => (p.superadminOnly ? isSuperadmin : permissions[p.resource!] !== "none"));

  const allGroups: NavGroupDef[] = [
    {
      key: "monitoring",
      label: "İzleme",
      icon: <Eye size={16} />,
      items: [
        { to: "/dashboard", label: "Genel bakış", icon: <LayoutDashboard size={15} />, resource: "dashboards" },
        { to: "/alerts", label: "Alarmlar", icon: <Bell size={15} />, badge: openAlertCount > 0 ? openAlertCount : undefined, resource: "alert_rules" },
        { to: "/topology", label: "Topoloji", icon: <Share2 size={15} />, resource: "topology" },
        { to: "/incidents", label: "Olaylar", icon: <ShieldAlert size={15} />, resource: "topology" },
        // GERÇEK EKSİKLİK (kullanıcı bulundu): APM (servis/trace izleme) fiilen
        // bir İZLEME özelliği, Yapılandırma'da durmasının bir anlamı yoktu.
        { to: "/apm", label: "APM", icon: <Activity size={15} />, resource: "devices" }
      ]
    },
    {
      key: "configuration",
      label: "Yapılandırma",
      icon: <Settings size={16} />,
      items: [
        ...(accessibleDevicePaths.length > 0
          ? [{
              to: accessibleDevicePaths[0].to,
              label: "Cihazlar",
              icon: <Router size={15} />,
              matchPaths: DEVICE_SECTION_PATHS.map((p) => p.to)
            }]
          : []),
        { to: "/agent-registration", label: "Agent Kaydı", icon: <PlusCircle size={15} />, resource: "devices" },
        { to: "/proxy-setup", label: "Proxy Kurulumu", icon: <PlusCircle size={15} />, resource: "proxies" },
        { to: "/proxies", label: "Proxy'ler", icon: <Server size={15} />, resource: "proxies" },
        { to: "/maintenance", label: "Bakım pencereleri", icon: <Clock size={15} />, resource: "maintenance" },
        { to: "/macros", label: "Makrolar", icon: <Variable size={15} />, resource: "macros" },
        { to: "/syslog-patterns", label: "Syslog Desenleri", icon: <ScrollText size={15} />, resource: "alert_rules" },
      ]
    },
    {
      key: "administration",
      label: "Yönetim",
      icon: <UsersRound size={16} />,
      items: [
        ...(accessibleUserPaths.length > 0
          ? [{
              to: accessibleUserPaths[0].to,
              label: "Kullanıcılar",
              icon: <Users size={15} />,
              matchPaths: USER_SECTION_PATHS.map((p) => p.to)
            }]
          : []),
        { to: "/notifications", label: "Bildirim kanalları", icon: <Mail size={15} />, resource: "notifications" },
        { to: "/audit-log", label: "Denetim kaydı", icon: <ScrollText size={15} />, resource: "audit_log" },
        { to: "/queue", label: "Kuyruk (Queue)", icon: <Clock size={15} />, resource: "queue" }
      ]
    }
  ];

  // FAZ: menü görünürlüğü. Bir öğenin kaynağı izin haritasında 'none' ise (veya
  // hiç yoksa, ki bu da fiilen 'none' anlamına gelir) menüde hiç gösterilmiyor.
  // resource belirtilmemiş öğeler (nadiren) her zaman gösterilir. Bir grubun TÜM
  // öğeleri gizlenirse, grubun kendisi de (boş başlık görünmesin diye) gizlenir.
  const isVisible = (item: NavItemDef) => !item.resource || permissions[item.resource] !== "none";
  const groups = allGroups
    .map((g) => ({ ...g, items: g.items.filter(isVisible) }))
    .filter((g) => g.items.length > 0);

  // Rota eşleşmesi: tam eşleşme ya da alt-rota (/devices/:id). "/devices" ile
  // "/device-groups" karışmasın diye "başlar mı" yerine sınır kontrolü yapılır.
  // matchPaths varsa (birleştirilmiş "Cihazlar" satırı) BUNLARDAN herhangi biri
  // eşleşince aktif sayılır -- tek bir `to` yetmez.
  const pathMatches = (path: string) => location.pathname === path || location.pathname.startsWith(path + "/");
  const matches = (item: Pick<NavItemDef, "to" | "matchPaths">) => {
    const paths = item.matchPaths ?? (item.to ? [item.to] : []);
    return paths.some(pathMatches);
  };

  const activeGroup = groups.find((g) => g.items.some((i) => matches(i)));
  const activeItem = groups.flatMap((g) => g.items).find((i) => matches(i));
  // Birleştirilmiş satırlardaysak ("Cihazlar", "Kullanıcılar"), breadcrumb'ta
  // genel etiket yerine gerçekte hangi alt-sayfada olduğumuzu (örn. "Ağ Keşfi")
  // gösterelim.
  const SPECIFIC_PATH_LABELS = [...DEVICE_SECTION_PATHS, ...USER_SECTION_PATHS];
  const activeSpecificLabel = activeItem?.matchPaths
    ? SPECIFIC_PATH_LABELS.find((p) => pathMatches(p.to))?.label ?? activeItem.label
    : activeItem?.label;
  const pageTitle = activeItem ? `${activeGroup?.label} / ${activeSpecificLabel}` : "Genel bakış";

  const [expandedKey, setExpandedKey] = useState<string | undefined>(activeGroup?.key ?? "monitoring");

  function handleLogout() {
    logout();
    navigate("/login");
  }

  return (
    <div className="flex min-h-screen bg-surface-0 text-text-primary">
      {/* Sol menü */}
      <aside className="w-56 shrink-0 border-r border-border flex flex-col">
        {/* Marka */}
        <div className="flex items-center gap-2.5 px-4 h-14 border-b border-border shrink-0">
          <div className="w-7 h-7 rounded-lg bg-brand text-brand-contrast flex items-center justify-center font-medium text-[15px] font-mono shrink-0">G</div>
          <div className="leading-none">
            <div className="text-[15px] font-medium">Gözlem<span className="text-brand">.</span></div>
            <div className="text-[9px] tracking-[0.14em] uppercase text-text-muted mt-1">Observability</div>
          </div>
        </div>

        {/* Navigasyon */}
        <nav className="flex-1 overflow-y-auto p-3 flex flex-col gap-0.5">
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
                      <NavRow key={item.label} item={item} isActive={matches(item)} />
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </nav>

        {/* Çıkış */}
        <div className="p-3 border-t border-border shrink-0">
          <button onClick={handleLogout} className="flex items-center gap-2.5 px-2.5 py-2 rounded-md text-sm text-text-secondary hover:bg-surface-1 w-full text-left">
            <LogOut size={16} />
            Çıkış yap
          </button>
        </div>
      </aside>

      {/* Sağ kolon: header + içerik + footer */}
      <div className="flex-1 flex flex-col min-w-0">
        <header className="h-14 shrink-0 flex items-center justify-between px-6 border-b border-border bg-[var(--header-bg)]">
          <div className="text-sm text-text-secondary truncate">{pageTitle}</div>
          <div className="flex items-center gap-4 shrink-0">
            <span className="text-[11px] font-medium px-2.5 py-1 rounded-full bg-[var(--bg-accent)] text-[var(--text-accent)]">{ENV_LABEL}</span>
            <Link to="/alerts" title="Alarmlar" className="relative text-text-secondary hover:text-text-primary">
              <Bell size={18} />
              {openAlertCount > 0 && (
                <span className="absolute -top-1.5 -right-1.5 min-w-[15px] h-[15px] px-1 rounded-full bg-[var(--text-danger)] text-white text-[9px] font-medium flex items-center justify-center">
                  {openAlertCount > 99 ? "99+" : openAlertCount}
                </span>
              )}
            </Link>
            <div className="relative">
              <button
                onClick={() => setShowAccountMenu((v) => !v)}
                className="w-7 h-7 rounded-full bg-surface-1 border border-border flex items-center justify-center text-text-secondary hover:text-text-primary"
                title="Hesap"
              >
                <CircleUser size={18} />
              </button>
              {showAccountMenu && (
                <>
                  <div className="fixed inset-0 z-10" onClick={() => setShowAccountMenu(false)} />
                  <div className="absolute right-0 top-9 z-20 w-48 bg-surface-2 border border-border rounded-lg shadow-lg py-1">
                    <button
                      onClick={() => { setShowChangePassword(true); setShowAccountMenu(false); }}
                      className="w-full text-left px-3 py-2 text-sm text-text-secondary hover:bg-surface-1"
                    >
                      Şifremi değiştir
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </header>

        {showChangePassword && <ChangePasswordModal onClose={() => setShowChangePassword(false)} />}

        <main className="flex-1 p-6 overflow-y-auto">{children}</main>

        <footer className="shrink-0 flex items-center justify-between px-6 py-2.5 border-t border-border bg-[var(--footer-bg)] text-[11px] text-text-muted">
          <div className="flex items-center gap-2">
            <div className="w-4 h-4 rounded bg-brand text-brand-contrast flex items-center justify-center text-[9px] font-mono">G</div>
            <span>Gözlem Observability</span>
          </div>
          <div className="flex items-center gap-4">
            <span className="flex items-center gap-1.5 text-text-success font-medium">
              <span className="w-1.5 h-1.5 rounded-full bg-[var(--text-success)]" />
              Tüm sistemler çalışıyor
            </span>
            <span>Sürüm {APP_VERSION}</span>
            <span>© {new Date().getFullYear()} İnnova</span>
          </div>
        </footer>
      </div>
    </div>
  );
}

function NavRow({ item, isActive }: { item: NavItemDef; isActive: boolean }) {
  if (item.disabled || !item.to) {
    return (
      <div className="flex items-center gap-2 px-2.5 py-1.5 rounded-md text-[13px] text-text-muted">
        {item.icon}
        <span className="flex-1">{item.label}</span>
        {item.disabledLabel && <span className="text-[11px]">{item.disabledLabel}</span>}
      </div>
    );
  }

  // matchPaths'li (birleştirilmiş) satırlarda aktiflik NavLink'in kendi
  // path-eşleşmesiyle DEĞİL, üst bileşendeki matchPaths-farkında matches()
  // fonksiyonuyla hesaplanıyor -- bu yüzden Link + dışarıdan verilen isActive.
  return (
    <Link
      to={item.to}
      className={`flex items-center gap-2 px-2.5 py-1.5 rounded-md text-[13px] ${
        isActive ? "bg-[var(--bg-accent)] text-[var(--text-accent)] font-medium" : "text-text-secondary hover:bg-surface-1"
      }`}
    >
      {item.icon}
      <span className="flex-1">{item.label}</span>
      {item.badge !== undefined && (
        <span className="text-[10.5px] font-medium px-[6px] py-[1px] rounded-full bg-[var(--text-danger)] text-white">{item.badge}</span>
      )}
    </Link>
  );
}
