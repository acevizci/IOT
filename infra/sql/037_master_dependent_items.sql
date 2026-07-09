ALTER TABLE template_items ADD COLUMN IF NOT EXISTS master_item_id UUID REFERENCES template_items(id) ON DELETE CASCADE;
