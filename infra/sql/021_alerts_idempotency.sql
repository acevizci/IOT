-- Aynı (rule_id, device_id) için birden fazla AÇIK alarm oluşmasını engeller.
-- Çözülmüş (resolved_at IS NOT NULL) geçmiş alarmlar için kısıt uygulanmaz —
-- bir kural zaman içinde defalarca tetiklenip çözülebilir, bu normal.
--
-- Önce mevcut duplike açık alarmları temizle: her grup için en yeni tetiklenen
-- kalır, diğerleri "resolved_at = now()" ile kapatılır (veri kaybı olmadan,
-- sessizce silinmek yerine geçmişte kalırlar).
UPDATE alerts a
SET resolved_at = now()
WHERE a.resolved_at IS NULL
  AND a.id NOT IN (
    SELECT DISTINCT ON (rule_id, device_id) id
    FROM alerts
    WHERE resolved_at IS NULL
    ORDER BY rule_id, device_id, triggered_at DESC
  );

CREATE UNIQUE INDEX IF NOT EXISTS uq_alerts_open_rule_device
  ON alerts(rule_id, device_id)
  WHERE resolved_at IS NULL;
