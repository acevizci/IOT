-- FAZ J — VMware desteği için şema (Adım 2, Hyper-V ayrı bir adımda -- agent tarafında).
--
-- KİMLİK BİLGİSİ TASARIM KARARI: username/password için YENİ bir kolon/JSON yapısı
-- EKLENMEDİ. Kod incelemesiyle doğrulandı: mevcut SSH/SQL collector'ların İKİSİ DE
-- (collector_types.requires_device_config=true olan tek iki tip) kimlik bilgilerini
-- devices.attributes gibi bir alanda DEĞİL, MEVCUT MAKRO SİSTEMİ üzerinden çözüyor
-- (services/exec-collector/src/sshPoller.ts, sql-collector/src/sqlPoller.ts ->
-- fetchResolvedConfig() -> {$SSH_USER}/{$SSH_PASSWORD} gibi tenant/cihaz-grubu/cihaz
-- hiyerarşili makrolar). macros.value_type='secret' seçilirse değer GERÇEKTEN
-- şifreleniyor (encryptSecret(), core/src/index.ts:2949) -- yani makro sistemi zaten
-- tam bu iş için var, güvenli ve test edilmiş. VMware da AYNI deseni kullanacak:
-- {$VMWARE_USER} (string) + {$VMWARE_PASSWORD} (secret) makroları.
--
-- BÜYÜK ÖLÇEK GEREKÇESİ: çoğu ortamda TÜM vCenter'lar aynı servis hesabını paylaşır --
-- makro yaklaşımıyla bu, bir cihaz grubu seviyesinde BİR KEZ tanımlanır ve altındaki
-- tüm vCenter'lar miras alır; devices.attributes yaklaşımıyla her vCenter cihazına
-- ayrı ayrı girilmesi (ve rotasyonda ayrı ayrı güncellenmesi) gerekirdi.
--
-- Bu migration'da SADECE sır OLMAYAN yapılandırma (mode, TLS doğrulama) için kolon
-- ekleniyor.

-- 1) device_interfaces: 'vmware' tipini kabul et + VMware'e özel yapılandırma.
ALTER TABLE device_interfaces DROP CONSTRAINT IF EXISTS device_interfaces_interface_type_check;
ALTER TABLE device_interfaces ADD CONSTRAINT device_interfaces_interface_type_check
  CHECK (interface_type = ANY (ARRAY['snmp'::text, 'ssh'::text, 'sql'::text, 'web'::text, 'vmware'::text]));

ALTER TABLE device_interfaces ADD COLUMN IF NOT EXISTS vmware_mode text
  CHECK (vmware_mode IS NULL OR vmware_mode IN ('vcenter', 'esxi'));
ALTER TABLE device_interfaces ADD COLUMN IF NOT EXISTS tls_skip_verify boolean NOT NULL DEFAULT false;

-- 2) collector_types: yeni koleksiyoncu kaydı. requires_device_config=true çünkü
-- {$VMWARE_USER}/{$VMWARE_PASSWORD} makrolarının tanımlı olması gerekiyor (SSH/SQL'de
-- olduğu gibi -- bkz. yukarıdaki tasarım kararı notu).
INSERT INTO collector_types (key, display_name, category, config_schema, handler_service, requires_device_config)
VALUES ('vmware', 'VMware (vCenter/ESXi)', 'virtualization', '{"fields": ["entity_type"]}', 'vmware-collector', true)
ON CONFLICT (key) DO NOTHING;
