import { NavLink } from "react-router-dom";
import { useAuth } from "../../auth/AuthContext";

// Hostlar, Ağ Keşfi, Host Grupları ve Şablonlar birbirine sıkıca bağlı --
// hepsi cihaz envanteri/yapılandırmasının bir parçası. Önceden sol menüde
// 4 ayrı satırdı; artık aralarında tek tıkla geçiş için paylaşımlı bir sekme
// çubuğu (DeviceDetail.tsx'teki sekme deseniyle AYNI görsel dil, ama gerçek
// rotalar arasında NavLink ile -- her biri kendi alt-rotasına (örn. /templates/:id)
// sahip bağımsız sayfalar olduğu için, DeviceDetail'in yerel state'li sekmeleri
// yerine routing-bazlı sekme kullanıyoruz).
// DashboardLayout.tsx'teki birleştirilmiş "Cihazlar" sol menü satırı da AYNI
// listeyi kullanıyor (matchPaths + breadcrumb etiketi için) -- tek kaynak,
// iki yerde birbirinden bağımsız kopya tutulmasın diye buradan export ediliyor.
// Value Maps ayrı bir üst-düzey kavram değil -- template_items.value_map_id
// üzerinden SADECE Şablonlar'a hizmet eden bir yardımcı veri, bu yüzden kendi
// sol menü satırı yerine buraya (aynı sekme çubuğuna) katıldı.
export const DEVICE_SECTION_PATHS: { to: string; label: string; resource: string }[] = [
  { to: "/devices", label: "Hostlar", resource: "devices" },
  { to: "/discovery", label: "Ağ Keşfi", resource: "devices" },
  { to: "/device-groups", label: "Host Grupları", resource: "device_groups" },
  { to: "/templates", label: "Şablonlar", resource: "templates" },
  { to: "/value-maps", label: "Value Maps", resource: "value_maps" }
];

export function DeviceSectionTabs() {
  const { permissions } = useAuth();
  // Sol menüdeki görünürlük mantığıyla AYNI: kaynak izni 'none' ise sekme
  // hiç gösterilmez (kullanıcının erişimi olmayan bir sekmeye tıklayıp 403
  // görmesin diye).
  const visibleTabs = DEVICE_SECTION_PATHS.filter((t) => permissions[t.resource] !== "none");
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
