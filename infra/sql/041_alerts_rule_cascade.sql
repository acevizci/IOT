-- Kural silinince bağlı alarm geçmişinin de silinebilmesi için (madde 7.7 test temizliğinde bulundu)
ALTER TABLE alerts DROP CONSTRAINT IF EXISTS alerts_rule_id_fkey;
ALTER TABLE alerts ADD CONSTRAINT alerts_rule_id_fkey FOREIGN KEY (rule_id) REFERENCES alert_rules(id) ON DELETE CASCADE;
