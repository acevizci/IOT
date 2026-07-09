-- Denetim kaydına "ne gönderildi, sonuç ne oldu" bilgisini ekliyoruz.
-- Önceden sadece method/path/status vardı — "kullanıcı hangi alanı hangi
-- değere değiştirdi" sorusuna cevap verilemiyordu.
--
-- request_body: kullanıcının gönderdiği veri (şifre/secret alanları [gizli] ile maskelenir)
-- response_body: PATCH/POST isteklerinde dönen güncel satır — doğal bir "sonra" görüntüsü
--   (ayrı bir "önce" sorgusu yapmaya gerek kalmadan, PATCH zaten güncel hâli döndürüyor)
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS request_body JSONB;
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS response_body JSONB;
