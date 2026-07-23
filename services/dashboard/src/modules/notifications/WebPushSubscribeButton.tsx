import { useState } from "react";
import { BellRing, Check } from "lucide-react";

const VAPID_PUBLIC_KEY = import.meta.env.VITE_VAPID_PUBLIC_KEY as string | undefined;

// PushManager.subscribe applicationServerKey bir Uint8Array bekliyor, VAPID public
// key'i standart bir base64url string -- tarayıcı push API'sinin gerektirdiği dönüşüm.
function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

// Web Push (bildirim sistemi parça 5, kullanıcıyla konuşulup kararlaştırıldı): "hedef"
// (destination) bu kullanıcının kendi elle yazacağı bir şey DEĞİL -- tarayıcının Push
// API'siyle otomatik üretilen bir subscription objesi. Bu buton izin ister, service
// worker'a abone olur ve üretilen subscription'ı JSON string olarak parent forma verir
// (parent form onu normal user_media.destination gibi kaydeder).
export function WebPushSubscribeButton({ onSubscribed, subscribed }: { onSubscribed: (destination: string) => void; subscribed: boolean }) {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function handleSubscribe() {
    setError(null);
    if (!VAPID_PUBLIC_KEY) {
      setError("Sunucu Web Push için yapılandırılmamış");
      return;
    }
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
      setError("Bu tarayıcı push bildirimlerini desteklemiyor");
      return;
    }
    setPending(true);
    try {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setError("Bildirim izni verilmedi");
        return;
      }
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY) as BufferSource
      });
      onSubscribed(JSON.stringify(subscription));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Abonelik başarısız");
    } finally {
      setPending(false);
    }
  }

  if (subscribed) {
    return (
      <span className="flex items-center gap-1.5 text-sm px-2.5 py-1.5 text-[var(--text-success)]">
        <Check size={15} />
        Bu tarayıcı eklendi
      </span>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        onClick={handleSubscribe}
        disabled={pending}
        className="flex items-center gap-1.5 text-sm px-2.5 py-1.5 rounded-md border border-border-strong hover:bg-surface-1 disabled:opacity-50"
      >
        <BellRing size={15} />
        Bu tarayıcıyı etkinleştir
      </button>
      {error && <span className="text-[11px] text-[var(--text-danger)]">{error}</span>}
    </div>
  );
}
