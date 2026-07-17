-- GÜVENİLİRLİK DÜZELTMESİ: başarısız bildirimler (email/webhook) hiç yeniden
-- denenmiyordu -- sessizce kayboluyordu (canlıda 137 başarısız / 14 başarılı
-- webhook gönderimi birikmişti). Bu migration, periyodik retry mekanizmasının
-- çalışabilmesi için gereken alanları ekliyor:
--
-- retry_count: kaç kez yeniden denendiği (belirli bir sınırdan sonra vazgeçilir)
-- payload: gönderilmek istenen İÇERİĞİN TAM KOPYASI -- retry sırasında alarmın
--          O ANKİ durumunu (belki "çözüldü" olmuş) yeniden sorgulamak yerine,
--          gönderim ANINDA ne gönderilmek isteniyorduysa TAM OLARAK onu tekrar
--          gönderiyoruz (örn. "yeni alarm" bildirimi başarısız olduysa, alarm bu
--          arada çözülmüş olsa bile retry hala "yeni alarm" mesajını gönderir,
--          "çözüldü" mesajıyla karışmaz).
ALTER TABLE notification_deliveries ADD COLUMN IF NOT EXISTS retry_count INT NOT NULL DEFAULT 0;
ALTER TABLE notification_deliveries ADD COLUMN IF NOT EXISTS payload JSONB NOT NULL DEFAULT '{}';
