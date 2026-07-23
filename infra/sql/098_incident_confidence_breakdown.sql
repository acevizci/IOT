-- RCA/Olaylar incelemesi: confidence motoru (rootCause.ts) her aday için
-- relationship_weight / temporal_score / hierarchy_weight / hop_decay / hop_distance
-- ve kaynak cihazdan adaya kadar geçilen zinciri (visited_path) hesaplıyor, ama
-- /api/v1/internal/root-cause-check SADECE nihai confidence sayısını yazıyordu --
-- döküm ve zincir hesaplanıp atılıyordu. Kullanıcı "neden bu cihaz suçlanıyor?"
-- sorusuna hiçbir yerde cevap bulamıyordu (aynı desen: anomali/tahminsel analizde
-- daha önce düzeltilen "hesaplanıp atılan bağlam" sorunu).
--
-- path_device_ids: kaynak cihazdan (incidents.root_cause_device_id / ilgili
-- affected alert'in device_id'si DEĞİL, incident'ın ana anchor cihazı) adaya kadar
-- geçilen cihazların UUID dizisi -- isimlere okuma anında (GET endpoint'lerinde)
-- devices tablosuyla join'lenerek çözülüyor (cihaz adı değişirse/silinirse diye
-- isim yerine id saklanıyor, mevcut root_cause_device_id deseniyle AYNI yaklaşım).
ALTER TABLE incidents
  ADD COLUMN IF NOT EXISTS relationship_weight NUMERIC,
  ADD COLUMN IF NOT EXISTS temporal_score NUMERIC,
  ADD COLUMN IF NOT EXISTS hierarchy_weight NUMERIC,
  ADD COLUMN IF NOT EXISTS hop_decay NUMERIC,
  ADD COLUMN IF NOT EXISTS hop_distance INTEGER,
  ADD COLUMN IF NOT EXISTS path_device_ids UUID[];

ALTER TABLE incident_affected_alerts
  ADD COLUMN IF NOT EXISTS relationship_weight NUMERIC,
  ADD COLUMN IF NOT EXISTS temporal_score NUMERIC,
  ADD COLUMN IF NOT EXISTS hierarchy_weight NUMERIC,
  ADD COLUMN IF NOT EXISTS hop_decay NUMERIC,
  ADD COLUMN IF NOT EXISTS hop_distance INTEGER,
  ADD COLUMN IF NOT EXISTS path_device_ids UUID[];
