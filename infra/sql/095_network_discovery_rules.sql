-- Ağ Keşfi (Network Discovery) yeniden tasarımı: eski tek-seferlik, /24 ile
-- sınırlı, tarayıcıda saklanan (kalıcı olmayan) "subnet scan" özelliğinin
-- yerine -- endüstri standardı (Zabbix/LibreNMS tarzı) kalıcı, kural-bazlı,
-- zamanlanabilir keşif. Her kural birden fazla CIDR aralığını, SNMP
-- kimlik bilgisini (v2c community VEYA v3 auth+priv) ve isteğe bağlı bir
-- periyodik çalışma aralığını taşır. Bulunan host'lar discovery_candidates'ta
-- BİRİKİR (Redis'teki eski job gibi 1 saatte silinmez) -- kullanıcı istediği
-- zaman inceleyip toplu olarak cihaz ekleyebilir.

CREATE TABLE discovery_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  name text NOT NULL,
  cidr_ranges text[] NOT NULL,
  snmp_version text NOT NULL DEFAULT 'v2c' CHECK (snmp_version IN ('v2c', 'v3')),
  snmp_community text,
  -- SNMPv3: authKey/privKey gerçek parola niteliğinde -- crypto.ts'teki
  -- encryptSecret/decryptSecret ile AYNI AES-256-GCM şemasıyla şifreli saklanır
  -- (LDAP bind password ve macro secret'larıyla AYNI konvansiyon).
  snmp_v3_username text,
  snmp_v3_level text CHECK (snmp_v3_level IN ('noAuthNoPriv', 'authNoPriv', 'authPriv')),
  snmp_v3_auth_protocol text,
  snmp_v3_auth_key_encrypted text,
  snmp_v3_priv_protocol text,
  snmp_v3_priv_key_encrypted text,
  -- NULL = sadece manuel ("Şimdi çalıştır"), dolu = otomatik periyodik tarama.
  schedule_interval_hours integer,
  last_run_at timestamptz,
  active boolean NOT NULL DEFAULT true,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_discovery_rules_tenant ON discovery_rules (tenant_id);

CREATE TABLE discovery_candidates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  rule_id uuid REFERENCES discovery_rules(id) ON DELETE SET NULL,
  ip_address text NOT NULL,
  sys_descr text,
  interface_count integer,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  -- Kullanıcı "bunu eklemeyeceğim" dediğinde sessizce tekrar tekrar önüne
  -- çıkmasın diye soft-dismiss (hard-delete değil -- bir sonraki taramada
  -- last_seen_at güncellenip tekrar "yeni" gibi görünmesin istendi).
  dismissed boolean NOT NULL DEFAULT false,
  added_device_id uuid REFERENCES devices(id) ON DELETE SET NULL,
  UNIQUE (tenant_id, ip_address)
);
CREATE INDEX idx_discovery_candidates_tenant ON discovery_candidates (tenant_id) WHERE dismissed = false AND added_device_id IS NULL;
