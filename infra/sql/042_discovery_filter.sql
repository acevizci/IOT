ALTER TABLE template_items ADD COLUMN IF NOT EXISTS discovery_filter_regex TEXT;
-- doluysa, is_table walk sırasında label (interface adı gibi) bu regex'e UYMAYAN satırlar atlanır
