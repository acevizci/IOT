-- Value map incelemesi: template_items.value_map_id SADECE template_item'a bağlı
-- item'larda çalışıyor. Baseline poller'in (npm servisi, template'siz) doğrudan
-- ürettiği if_oper_status gibi metriklerin arkasında HİÇBİR template_item yok --
-- bu yüzden dashboard'da "up/down/testing" yerine ham 1/2/3/6 rakamları olarak
-- görünüyorlardı (StatusTimeline bileşeni value_map_id'siz metrikleri düz çizgi
-- grafik olarak çiziyor, GraphWidget.tsx'te doğrulandı).
--
-- Çözüm: template_item'dan BAĞIMSIZ, tenant + metric_name bazlı ikinci bir
-- value_map bağlama tablosu. /api/v1/metrics/names bu tabloyu template_item
-- eşlemesi bulunamayan metrikler için YEDEK (fallback) olarak kullanacak.
CREATE TABLE IF NOT EXISTS metric_value_maps (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id),
    metric_name TEXT NOT NULL,
    value_map_id UUID NOT NULL REFERENCES value_maps(id) ON DELETE CASCADE,
    UNIQUE(tenant_id, metric_name)
);

-- if_oper_status için endüstri standardı eşleme: IF-MIB'in ifOperStatus enum'u
-- (RFC 2863) -- Zabbix'in kendi hazır şablonlarında da AYNI yedi durumla gelir.
-- Her tenant için value_map + eşleme satırı, idempotent (tekrar çalıştırılabilir).
DO $$
DECLARE
  t RECORD;
  vm_id UUID;
BEGIN
  FOR t IN SELECT id FROM tenants LOOP
    INSERT INTO value_maps (tenant_id, name, mappings)
    VALUES (
      t.id,
      'IF-MIB ifOperStatus',
      '[
        {"value": "1", "label": "up"},
        {"value": "2", "label": "down"},
        {"value": "3", "label": "testing"},
        {"value": "4", "label": "unknown"},
        {"value": "5", "label": "dormant"},
        {"value": "6", "label": "notPresent"},
        {"value": "7", "label": "lowerLayerDown"}
      ]'::jsonb
    )
    ON CONFLICT (tenant_id, name) DO NOTHING;

    SELECT id INTO vm_id FROM value_maps WHERE tenant_id = t.id AND name = 'IF-MIB ifOperStatus';

    INSERT INTO metric_value_maps (tenant_id, metric_name, value_map_id)
    VALUES (t.id, 'if_oper_status', vm_id)
    ON CONFLICT (tenant_id, metric_name) DO NOTHING;
  END LOOP;
END $$;
