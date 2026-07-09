ALTER TABLE template_items ADD COLUMN IF NOT EXISTS formula TEXT;
ALTER TABLE template_items ADD COLUMN IF NOT EXISTS formula_oids JSONB;
-- formula örneği: "(used - free) / used * 100"
-- formula_oids örneği: {"used": "1.3.6.1.4.1.9.9.48.1.1.1.5.1", "free": "1.3.6.1.4.1.9.9.48.1.1.1.6.1"}
