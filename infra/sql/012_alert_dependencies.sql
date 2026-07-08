-- Template seviyesinde bağımlılık tanımı (bir template kuralı başka bir template kuralına bağımlı olabilir)
ALTER TABLE alert_template_rules ADD COLUMN IF NOT EXISTS depends_on_template_rule_id UUID REFERENCES alert_template_rules(id) ON DELETE SET NULL;

-- Cihaz bazlı gerçek kural bağımlılığı (template uygulanınca otomatik oluşur, ya da elle tanımlanabilir)
CREATE TABLE IF NOT EXISTS alert_rule_dependencies (
    rule_id UUID NOT NULL REFERENCES alert_rules(id) ON DELETE CASCADE,
    depends_on_rule_id UUID NOT NULL REFERENCES alert_rules(id) ON DELETE CASCADE,
    PRIMARY KEY (rule_id, depends_on_rule_id)
);
