-- Bildirim sistemi tasarımı (kullanıcıyla konuşulup kararlaştırıldı, "uçtan uca
-- bildirim sistemi" turunun 1. parçası): mail içeriği önceden alarm-engine'de
-- tamamen sabit kodlanmıştı (services/alarm-engine/src/notify.ts) -- konu
-- "[SEVERITY] CihazAdı", gövde sadece ham alarm mesajı, HTML yok, marka/link yok,
-- hiçbir şekilde değiştirilemiyordu. Artık her tenant için 3 senaryo (yeni alarm/
-- çözüldü/eskalasyon) ayrı ayrı, HTML+düz metin olarak düzenlenebilir.
CREATE TABLE IF NOT EXISTS email_templates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    template_type TEXT NOT NULL CHECK (template_type IN ('new_alert', 'resolved_alert', 'escalation')),
    subject TEXT NOT NULL,
    body_html TEXT NOT NULL,
    body_text TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, template_type)
);

-- Her tenant için 3 senaryoyu da Zabbix'in varsayılan mesaj şablonlarına yakın,
-- makul bir içerikle seed eder. Kullanılabilir değişkenler:
-- {{cihaz_adi}} {{severity}} {{severity_etiketi}} {{mesaj}} {{tetiklenme_zamani}}
-- {{cozulme_zamani}} {{adim_no}} {{adim_gecikmesi}} {{tenant_adi}} {{alarm_linki}}
DO $$
DECLARE
  t RECORD;
BEGIN
  FOR t IN SELECT id FROM tenants LOOP
    INSERT INTO email_templates (tenant_id, template_type, subject, body_html, body_text)
    SELECT t.id, 'new_alert',
      '[{{severity_etiketi}}] {{cihaz_adi}}',
      '<div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto;">' ||
      '<div style="border-left: 4px solid #ea6b53; padding: 16px; background: #fdf3f1;">' ||
      '<p style="margin: 0 0 8px; font-size: 12px; color: #888; text-transform: uppercase;">{{severity_etiketi}}</p>' ||
      '<h2 style="margin: 0 0 12px; font-size: 18px; color: #222;">{{cihaz_adi}}</h2>' ||
      '<p style="margin: 0 0 12px; font-size: 14px; color: #333;">{{mesaj}}</p>' ||
      '<p style="margin: 0 0 16px; font-size: 12px; color: #888;">Tetiklenme: {{tetiklenme_zamani}}</p>' ||
      '<a href="{{alarm_linki}}" style="display: inline-block; padding: 8px 16px; background: #ea6b53; color: #fff; text-decoration: none; border-radius: 4px; font-size: 13px;">Alarmı görüntüle</a>' ||
      '</div></div>',
      E'[{{severity_etiketi}}] {{cihaz_adi}}\n\n{{mesaj}}\n\nTetiklenme: {{tetiklenme_zamani}}\nAlarm: {{alarm_linki}}'
    WHERE NOT EXISTS (SELECT 1 FROM email_templates WHERE tenant_id = t.id AND template_type = 'new_alert');

    INSERT INTO email_templates (tenant_id, template_type, subject, body_html, body_text)
    SELECT t.id, 'resolved_alert',
      '[ÇÖZÜLDÜ] {{cihaz_adi}}',
      '<div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto;">' ||
      '<div style="border-left: 4px solid #5ecca3; padding: 16px; background: #f0faf6;">' ||
      '<p style="margin: 0 0 8px; font-size: 12px; color: #888; text-transform: uppercase;">Çözüldü</p>' ||
      '<h2 style="margin: 0 0 12px; font-size: 18px; color: #222;">{{cihaz_adi}}</h2>' ||
      '<p style="margin: 0 0 12px; font-size: 14px; color: #333;">Çözüldü: {{mesaj}}</p>' ||
      '<p style="margin: 0 0 16px; font-size: 12px; color: #888;">Çözülme: {{cozulme_zamani}}</p>' ||
      '<a href="{{alarm_linki}}" style="display: inline-block; padding: 8px 16px; background: #5ecca3; color: #fff; text-decoration: none; border-radius: 4px; font-size: 13px;">Alarmı görüntüle</a>' ||
      '</div></div>',
      E'[ÇÖZÜLDÜ] {{cihaz_adi}}\n\nÇözüldü: {{mesaj}}\n\nÇözülme: {{cozulme_zamani}}\nAlarm: {{alarm_linki}}'
    WHERE NOT EXISTS (SELECT 1 FROM email_templates WHERE tenant_id = t.id AND template_type = 'resolved_alert');

    INSERT INTO email_templates (tenant_id, template_type, subject, body_html, body_text)
    SELECT t.id, 'escalation',
      '[ESKALASYON {{adim_no}}] {{cihaz_adi}}',
      '<div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto;">' ||
      '<div style="border-left: 4px solid #d97706; padding: 16px; background: #fdf6ec;">' ||
      '<p style="margin: 0 0 8px; font-size: 12px; color: #888; text-transform: uppercase;">Eskalasyon · Adım {{adim_no}}</p>' ||
      '<h2 style="margin: 0 0 12px; font-size: 18px; color: #222;">{{cihaz_adi}}</h2>' ||
      '<p style="margin: 0 0 12px; font-size: 14px; color: #333;">Bu alarm hâlâ çözülmedi: {{mesaj}}</p>' ||
      '<p style="margin: 0 0 16px; font-size: 12px; color: #888;">Tetiklenme: {{tetiklenme_zamani}}</p>' ||
      '<a href="{{alarm_linki}}" style="display: inline-block; padding: 8px 16px; background: #d97706; color: #fff; text-decoration: none; border-radius: 4px; font-size: 13px;">Alarmı görüntüle</a>' ||
      '</div></div>',
      E'[ESKALASYON {{adim_no}}] {{cihaz_adi}}\n\nBu alarm hâlâ çözülmedi: {{mesaj}}\n\nTetiklenme: {{tetiklenme_zamani}}\nAlarm: {{alarm_linki}}'
    WHERE NOT EXISTS (SELECT 1 FROM email_templates WHERE tenant_id = t.id AND template_type = 'escalation');
  END LOOP;
END $$;
