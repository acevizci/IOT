-- Bildirim sistemi tasarım kararı: eskalasyon adımları önceden TEK bir
-- alert_template_rule_id'ye bağlıydı (escalation_steps) -- Zabbix'in Actions/
-- Operations'ı veya PagerDuty/Opsgenie'nin Escalation Policy'si gibi YENİDEN
-- KULLANILABİLİR değildi (aynı 3 adımlı zinciri her kuralda yeniden girmek
-- gerekirdi). Kullanıcıyla konuşulup KARARLAŞTIRILDI: eskalasyon artık
-- bağımsız, adlandırılmış bir "politika" (escalation_policies +
-- escalation_policy_steps) -- hem şablon kuralları HEM cihaza özel kurallar
-- bir politikayı SEÇEBİLİR, aynı politika istenildiği kadar kurala atanabilir.
-- escalation_steps hiç kullanılmıyordu (0 satır) -- veri kaybı yok.
DROP TABLE IF EXISTS escalation_steps;

CREATE TABLE escalation_policies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  name TEXT NOT NULL,
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE escalation_policy_steps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  policy_id UUID NOT NULL REFERENCES escalation_policies(id) ON DELETE CASCADE,
  step_order INTEGER NOT NULL,
  delay_seconds INTEGER NOT NULL,
  action_type TEXT NOT NULL CHECK (action_type = ANY (ARRAY['notify'::text, 'remote_command'::text])),
  media_type_id UUID REFERENCES media_types(id),
  remote_command TEXT
);

ALTER TABLE alert_rules ADD COLUMN IF NOT EXISTS escalation_policy_id UUID REFERENCES escalation_policies(id) ON DELETE SET NULL;
ALTER TABLE alert_template_rules ADD COLUMN IF NOT EXISTS escalation_policy_id UUID REFERENCES escalation_policies(id) ON DELETE SET NULL;
