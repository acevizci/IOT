-- Bildirim sistemi tasarımı ("parça parça" 5. adım, kullanıcıyla konuşulup kararlaştırıldı):
-- üç yeni kanal -- PagerDuty (webhook'un 3. format'ı olarak, media_types.type genişletmesi
-- GEREKTİRMİYOR), genel HTTP SMS geçidi (yeni type='sms') ve Tarayıcı Web Push (yeni
-- type='webpush'). SMS ve Web Push için media_types.type CHECK kısıtı genişletiliyor.
ALTER TABLE media_types DROP CONSTRAINT IF EXISTS media_types_type_check;
ALTER TABLE media_types ADD CONSTRAINT media_types_type_check
  CHECK (type = ANY (ARRAY['email'::text, 'webhook'::text, 'sms'::text, 'webpush'::text]));
