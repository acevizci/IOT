-- Bildirim sistemi tasarımı ("parça parça" 3. adım, kullanıcıyla konuşulup kararlaştırıldı):
-- eskalasyon adımı hedefleme. Önceden bir adım sadece "hangi kanal TİPİYLE bildirilsin"
-- belirtiyordu (media_type_id) -- gerçek alıcılar o tenant'taki, o kanal tipini kullanan
-- HERKESTİ (min_severity/device_group filtrelerine uyanlar). Artık adım opsiyonel olarak
-- SPESİFİK bir kişiye hedeflenebiliyor -- belirtilirse sadece o kullanıcıya (ve severity/
-- device_group filtreleri ATLANARAK, çünkü bu artık kişiye özel bir eskalasyon kararı,
-- kullanıcının kendi genel tercihine bağlı bir yayın değil) gönderilir.
ALTER TABLE escalation_policy_steps
  ADD COLUMN IF NOT EXISTS target_user_id UUID REFERENCES users(id) ON DELETE SET NULL;
