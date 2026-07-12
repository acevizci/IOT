-- Faz 10-sonrası kritik düzeltme: cihaz tamamen erişilemez (SNMP yanıt vermiyor) hale
-- geldiğinde önceden HİÇ alarm üretilmiyordu -- metrik-eşik bazlı alert_rules mantığı,
-- yeni metrik değeri hiç gelmediği için değerlendirilecek bir şey bulamıyordu. Bu bayrak,
-- alarm-engine'in otomatik oluşturduğu "cihaz erişilemez" (heartbeat) kurallarını normal
-- (kullanıcı tanımlı, metrik-eşikli) kurallardan ayırt etmek için kullanılıyor -- hem
-- normal değerlendirme döngüsünden hariç tutulsun hem de Kurallar sekmesinde farklı
-- gösterilebilsin diye.
ALTER TABLE alert_rules ADD COLUMN IF NOT EXISTS is_heartbeat BOOLEAN NOT NULL DEFAULT false;
