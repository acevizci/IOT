-- Çok-metrikli ifade değerlendirme motoru: metric_name/condition/threshold'un tek-metrik
-- modelini bozmadan, opsiyonel bir AST (expression_ast) ekliyoruz. Biri doluysa basit
-- kural, diğeri doluysa karmaşık ifade -- ikisi birden asla dolu olmamalı (CHECK ile).
ALTER TABLE alert_template_rules ALTER COLUMN metric_name DROP NOT NULL;
ALTER TABLE alert_template_rules ALTER COLUMN condition DROP NOT NULL;
ALTER TABLE alert_template_rules ALTER COLUMN threshold DROP NOT NULL;
ALTER TABLE alert_template_rules ADD COLUMN IF NOT EXISTS expression_ast JSONB;
ALTER TABLE alert_template_rules ADD COLUMN IF NOT EXISTS display_expression TEXT;
ALTER TABLE alert_template_rules ADD CONSTRAINT chk_simple_or_expression
  CHECK ((metric_name IS NOT NULL AND condition IS NOT NULL) OR expression_ast IS NOT NULL);

ALTER TABLE alert_rules ALTER COLUMN metric_name DROP NOT NULL;
ALTER TABLE alert_rules ALTER COLUMN condition DROP NOT NULL;
ALTER TABLE alert_rules ALTER COLUMN threshold DROP NOT NULL;
ALTER TABLE alert_rules ADD COLUMN IF NOT EXISTS expression_ast JSONB;
ALTER TABLE alert_rules ADD COLUMN IF NOT EXISTS display_expression TEXT;
ALTER TABLE alert_rules ADD CONSTRAINT chk_simple_or_expression
  CHECK ((metric_name IS NOT NULL AND condition IS NOT NULL) OR expression_ast IS NOT NULL);
