-- Bildirim sistemi tasarımı ("parça parça" 2. adım, kullanıcıyla konuşulup kararlaştırıldı):
-- flapping bastırma. Bir kural kısa sürede tekrar tekrar açılıp kapanırsa (ör. eşik sınırında
-- salınan bir metrik), alarm YİNE normal şekilde açılır/çözülür (arayüzde görünür) ama
-- BİLDİRİM gönderilmez -- amaç bildirim fırtınasını önlemek, alarmı gizlemek değil.
-- Kullanıcı kararı: kural bazında ayrı eşik (tenant-genel tek bir ayar DEĞİL) -- anomali/
-- tahminsel izleme ile AYNI opt-out deseni (varsayılan açık, kural bazında kapatılabilir).
ALTER TABLE alert_rules
  ADD COLUMN IF NOT EXISTS flapping_enabled BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS flapping_threshold_count INTEGER NOT NULL DEFAULT 4,
  ADD COLUMN IF NOT EXISTS flapping_window_seconds INTEGER NOT NULL DEFAULT 900;

-- Bildirimi bastırılan alarmlar arayüzde işaretlenebilsin diye (audit/görünürlük).
ALTER TABLE alerts
  ADD COLUMN IF NOT EXISTS notification_suppressed BOOLEAN NOT NULL DEFAULT false;
