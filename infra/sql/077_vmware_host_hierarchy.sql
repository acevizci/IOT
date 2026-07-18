-- FAZ J — Host/Cluster Hiyerarşisi Düzeltmesi
--
-- KULLANICI GERİ BİLDİRİMİ (haklı): önceki tasarımda VM/host/datastore/cluster'ın
-- HEPSİ tek bir vCenter cihazının instance_label etiketleri olarak modellenmişti --
-- bu, (a) dashboard'da gerçek bir hiyerarşi/drill-down göstermeyi imkansız kılıyordu
-- (bir host arızalandığında "vCenter'da alarm var" görünüyordu, "Host X'te alarm var"
-- değil), (b) cihaz-grubu izin sistemi device_id bazlı çalıştığı için, birine "sadece
-- şu host'u görebilsin" izni vermek İMKANSIZDI (host ayrı bir device_id değildi).
--
-- DÜZELTME: Host'lar SAYICA AZ (2-20/vCenter) olduğu için GERÇEK devices satırlarına
-- yükseltiliyor. VM'ler SAYICA ÇOK (300+) olduğu için instance_label etiketi olarak
-- KALIYOR -- ama artık vCenter'ın değil, ÇALIŞTIKLARI HOST'un device_id'sine bağlanıyor.
-- Cluster'lar, host'ları içeren birer device_group -- YENİ bir "hiyerarşi" kavramı
-- İCAT EDİLMİYOR, bugün (Faz 1-4) zaten kurulup test edilmiş device_groups +
-- user_group_device_permissions sistemi yeniden kullanılıyor.

-- devices.attributes (mevcut JSONB) zaten vSphere host MOID'ini (attributes.
-- vmware_host_id) taşıyabilir -- yeni bir kolon GEREKMİYOR, sadece uygulama
-- kodunda bu alanı find-or-create anahtarı olarak kullanacağız.

-- device_groups: vmware-collector'ın OTOMATİK yönettiği grupları (kullanıcının elle
-- oluşturduğu normal gruplardan ayırt etmek + idempotent senkronizasyon için) işaretler.
ALTER TABLE device_groups ADD COLUMN IF NOT EXISTS vmware_source_device_id UUID REFERENCES devices(id) ON DELETE CASCADE;
ALTER TABLE device_groups ADD COLUMN IF NOT EXISTS vmware_external_id TEXT;
-- vmware_external_id: 'all-hosts' (vCenter'ın TÜM host'ları) veya bir cluster MOID'i
-- (örn. 'domain-c1') -- vmware_source_device_id ile birlikte BENZERSİZ bir anahtar
-- oluşturuyor, senkronizasyon "bu grup zaten var mı" diye bunu sorgulayarak çalışır.
CREATE UNIQUE INDEX IF NOT EXISTS uq_device_groups_vmware_sync
  ON device_groups (vmware_source_device_id, vmware_external_id)
  WHERE vmware_source_device_id IS NOT NULL;
