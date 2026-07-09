-- Makroları genelleştiriyoruz: artık sadece sayısal alarm eşiği değil,
-- Zabbix'teki gibi metin (host adı, port, kullanıcı adı) ve secret (parola,
-- private key) değerleri de tutabiliyor. Bu, device_collector_configs +
-- device_credentials tablolarının yerini alıyor (bkz. 032_drop_collector_credentials.sql).
ALTER TABLE macros ADD COLUMN IF NOT EXISTS value_type TEXT NOT NULL DEFAULT 'numeric'
  CHECK (value_type IN ('numeric', 'string', 'secret'));

-- NUMERIC -> TEXT: mevcut sayısal makrolar metne çevrilir, veri kaybı olmaz.
-- 'secret' tipi makroların default_value'su application-level (crypto.ts, AES-256-GCM)
-- şifreli metin olarak saklanır — aynı sütun, farklı içerik yorumu (value_type'a göre).
ALTER TABLE macros ALTER COLUMN default_value TYPE TEXT USING default_value::TEXT;
ALTER TABLE macro_overrides ALTER COLUMN value TYPE TEXT USING value::TEXT;
