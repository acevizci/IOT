-- Gercek bulgu: exec/sql/web collector'lari (SSH/SQL/Web) TEK bir hatada HEMEN
-- 'down' raporluyordu -- SNMP tarafinda (npm-service) zaten var olan ardisik-basarisizlik
-- esigi (FAILURE_THRESHOLD/SUCCESS_THRESHOLD) burada HIC yoktu. Gecici bir ag gecikmesi/
-- timeout bile aninda bir 'device_reachability' alarmi tetikleyebiliyordu (flapping riski).
-- consecutive_failures sayaci, /api/v1/internal/devices/:id/collector-status endpoint'inde
-- (TUM collector tiplerinin ORTAK yazma noktasi) bir esik uygulanmasini saglar.
ALTER TABLE device_collector_status ADD COLUMN IF NOT EXISTS consecutive_failures INTEGER NOT NULL DEFAULT 0;
