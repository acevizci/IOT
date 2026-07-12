-- Zabbix'in "Status: Enabled/Disabled" kavramı — Availability'den (erişilebilirlik) farklı,
-- kullanıcının cihazı izlemeyi tamamen durdurup durdurmadığı (pause/resume).
ALTER TABLE devices ADD COLUMN IF NOT EXISTS enabled BOOLEAN NOT NULL DEFAULT true;
