-- Mevcut device_collector_configs + device_credentials verisini (gerçek, çalışan bir
-- SSH bağlantısı — "VM Root SSH") yeni makro sistemine taşır. Parola, ÇÖZÜLMEDEN
-- doğrudan kopyalanır: macro_overrides.value ve device_credentials.encrypted_secret
-- aynı AES-256-GCM anahtarı/algoritmasıyla (crypto.ts, CREDENTIAL_ENCRYPTION_KEY)
-- şifrelendiği için ciphertext'i olduğu gibi taşımak güvenlidir ve decrypt/re-encrypt
-- adımına hiç gerek yoktur.

-- 1) ssh_exec kullanan her tenant için gerekli makroları oluştur (yoksa)
INSERT INTO macros (tenant_id, key, value_type, default_value, description)
SELECT DISTINCT d.tenant_id, '{$SSH_PORT}', 'numeric', '22', 'SSH bağlantı portu'
FROM device_collector_configs dcc JOIN devices d ON d.id = dcc.device_id
WHERE dcc.collector_type = 'ssh_exec'
ON CONFLICT (tenant_id, key) DO NOTHING;

INSERT INTO macros (tenant_id, key, value_type, default_value, description)
SELECT DISTINCT d.tenant_id, '{$SSH_USER}', 'string', '', 'SSH kullanıcı adı'
FROM device_collector_configs dcc JOIN devices d ON d.id = dcc.device_id
WHERE dcc.collector_type = 'ssh_exec'
ON CONFLICT (tenant_id, key) DO NOTHING;

INSERT INTO macros (tenant_id, key, value_type, default_value, description)
SELECT DISTINCT d.tenant_id, '{$SSH_PASSWORD}', 'secret', '', 'SSH parolası (şifreli saklanır)'
FROM device_collector_configs dcc JOIN devices d ON d.id = dcc.device_id
WHERE dcc.collector_type = 'ssh_exec'
ON CONFLICT (tenant_id, key) DO NOTHING;

-- 2) Cihaz bazlı override'lar: port, kullanıcı adı
INSERT INTO macro_overrides (macro_id, scope_type, scope_id, value)
SELECT m.id, 'device', dcc.device_id, COALESCE(dcc.config->>'port', '22')
FROM device_collector_configs dcc
JOIN devices d ON d.id = dcc.device_id
JOIN macros m ON m.tenant_id = d.tenant_id AND m.key = '{$SSH_PORT}'
WHERE dcc.collector_type = 'ssh_exec'
ON CONFLICT (macro_id, scope_type, scope_id) DO UPDATE SET value = EXCLUDED.value;

INSERT INTO macro_overrides (macro_id, scope_type, scope_id, value)
SELECT m.id, 'device', dcc.device_id, dc.username
FROM device_collector_configs dcc
JOIN devices d ON d.id = dcc.device_id
JOIN device_credentials dc ON dc.id = (dcc.config->>'credential_id')::uuid
JOIN macros m ON m.tenant_id = d.tenant_id AND m.key = '{$SSH_USER}'
WHERE dcc.collector_type = 'ssh_exec'
ON CONFLICT (macro_id, scope_type, scope_id) DO UPDATE SET value = EXCLUDED.value;

-- Parola: aynı algoritma/anahtar olduğu için ciphertext ÇÖZÜLMEDEN kopyalanır.
INSERT INTO macro_overrides (macro_id, scope_type, scope_id, value)
SELECT m.id, 'device', dcc.device_id, dc.encrypted_secret
FROM device_collector_configs dcc
JOIN devices d ON d.id = dcc.device_id
JOIN device_credentials dc ON dc.id = (dcc.config->>'credential_id')::uuid
JOIN macros m ON m.tenant_id = d.tenant_id AND m.key = '{$SSH_PASSWORD}'
WHERE dcc.collector_type = 'ssh_exec'
ON CONFLICT (macro_id, scope_type, scope_id) DO UPDATE SET value = EXCLUDED.value;

-- 3) Template item'ların connection_config'ine makro referanslarını ekle.
-- auth_type: mevcut credential_type'a göre ('ssh_password' -> 'password') — Exec Collector
-- artık device_credentials'a değil, bu alana ve {$SSH_PASSWORD} makrosuna bakacak.
UPDATE template_items ti
SET connection_config = ti.connection_config || jsonb_build_object(
  'port', '{$SSH_PORT}',
  'username', '{$SSH_USER}',
  'password', '{$SSH_PASSWORD}',
  'auth_type', 'password'
)
WHERE ti.collector_type = 'ssh_exec';
