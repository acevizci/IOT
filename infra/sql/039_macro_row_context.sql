ALTER TABLE macro_overrides ADD COLUMN IF NOT EXISTS row_context TEXT;
-- row_context doluysa, bu override sadece o satır (örn. interface adı) için geçerlidir;
-- NULL ise mevcut davranış (device/device_group genelinde) korunur.
DROP INDEX IF EXISTS macro_overrides_macro_id_scope_type_scope_id_key;
ALTER TABLE macro_overrides DROP CONSTRAINT IF EXISTS macro_overrides_macro_id_scope_type_scope_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS idx_macro_overrides_unique
  ON macro_overrides (macro_id, scope_type, scope_id, COALESCE(row_context, ''));
