-- Faz G: agent plugin'lerinin (Docker/PostgreSQL/Redis) baglanti bilgisi (endpoint/uri/
-- adres) su ana kadar SADECE agent'in kendi yerel agent_config.json dosyasindaydi --
-- sunucu bunu hic bilmiyordu, hicbir merkezi yonetim yoktu. Bu, SSH/SQL/Web collector'lar
-- icin makro sistemiyle cozdugumuz "merkezi baglanti yonetimi" felsefesine tamamen ters
-- dusuyordu. Sifreli saklaniyor (postgres.uri parola icerebilir) -- crypto.ts'deki
-- encryptSecret/decryptSecret ile, makrolardaki secret tipi gibi AES-256-GCM.
ALTER TABLE devices ADD COLUMN IF NOT EXISTS agent_plugin_config TEXT;
