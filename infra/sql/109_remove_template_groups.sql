-- Kullanıcı geri bildirimi: şablon "grupları" (kategori/klasörleme) özelliği
-- gerçek bir fayda sağlamadı -- device_groups (Uygula butonundaki "Grup seç")
-- ile aynı isimde olması da kafa karıştırdı. Tamamen kaldırılıyor.
ALTER TABLE alert_templates DROP COLUMN IF EXISTS template_group_id;
DROP TABLE IF EXISTS template_groups;
