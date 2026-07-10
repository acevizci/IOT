ALTER TABLE alert_template_rules ADD COLUMN IF NOT EXISTS recovery_threshold NUMERIC;
ALTER TABLE alert_rules ADD COLUMN IF NOT EXISTS recovery_threshold NUMERIC;
-- recovery_threshold NULL ise mevcut davranış (aynı eşikte düzelme) korunur.
-- Doluysa, alarm >threshold'da tetiklenir ama sadece <recovery_threshold olunca düzelir
-- (histerezis — arada gürültü/flapping olmasın diye, Zabbix'in ayrı recovery_expression'ının karşılığı).
