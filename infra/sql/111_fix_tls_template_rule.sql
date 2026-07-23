-- Şablon kuralı denetimi: "TLS Sertifika İzleme" şablonunda anlamsız bir test
-- kuralı vardı (metric_name='test', hiçbir item bunu üretmiyor -- şablonun
-- TEK item'ı cert_days_remaining). Üstelik gerçek amacı (sertifika süresi
-- dolmadan uyarmak) için HİÇBİR kural yoktu. Sahte kural silinip, endüstri
-- standardı iki kademeli sertifika süre uyarısı (30 gün=warning, 7 gün=high)
-- + erişilemezlik uyarısı ekleniyor.
DELETE FROM alert_template_rules
WHERE template_id = (SELECT id FROM alert_templates WHERE name = 'TLS Sertifika İzleme' AND tenant_id = 'b2dbf6ab-ff81-4afc-9115-fde9a96a2fa7')
  AND metric_name = 'test';

INSERT INTO alert_template_rules (template_id, metric_name, condition, threshold, duration_seconds, severity)
SELECT id, 'cert_days_remaining', 'lt', 30, 60, 'warning' FROM alert_templates
WHERE name = 'TLS Sertifika İzleme' AND tenant_id = 'b2dbf6ab-ff81-4afc-9115-fde9a96a2fa7'
  AND NOT EXISTS (
    SELECT 1 FROM alert_template_rules r WHERE r.template_id = alert_templates.id AND r.metric_name = 'cert_days_remaining' AND r.threshold = 30
  );

INSERT INTO alert_template_rules (template_id, metric_name, condition, threshold, duration_seconds, severity)
SELECT id, 'cert_days_remaining', 'lt', 7, 60, 'high' FROM alert_templates
WHERE name = 'TLS Sertifika İzleme' AND tenant_id = 'b2dbf6ab-ff81-4afc-9115-fde9a96a2fa7'
  AND NOT EXISTS (
    SELECT 1 FROM alert_template_rules r WHERE r.template_id = alert_templates.id AND r.metric_name = 'cert_days_remaining' AND r.threshold = 7
  );

INSERT INTO alert_template_rules (template_id, metric_name, condition, threshold, duration_seconds, severity)
SELECT id, 'cert_days_remaining_reachable', 'eq', 0, 60, 'high' FROM alert_templates
WHERE name = 'TLS Sertifika İzleme' AND tenant_id = 'b2dbf6ab-ff81-4afc-9115-fde9a96a2fa7'
  AND NOT EXISTS (
    SELECT 1 FROM alert_template_rules r WHERE r.template_id = alert_templates.id AND r.metric_name = 'cert_days_remaining_reachable'
  );
