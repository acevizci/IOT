-- Kullanıcılar/Kullanıcı Grupları denetimi: kullanıcı bazında aktif/pasif alanı
-- yoktu (sadece grup bazında frontend_access='disabled' vardı, tüm gruba etki
-- ediyordu). Tek bir kullanıcıyı devre dışı bırakmanın yolu yoktu.
ALTER TABLE users ADD COLUMN IF NOT EXISTS enabled BOOLEAN NOT NULL DEFAULT true;
