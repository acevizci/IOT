-- Bildirim sistemi tasarımı ("parça parça" son adım, kullanıcıyla konuşulup kararlaştırıldı):
-- takvim bazlı nöbet çizelgelemesi -- saat/gün bazlı katmanlar (haftalık tekrar eden
-- pencereler) + öncelik bazlı çakışma çözümü + manuel geçersiz kılmalar (tatil/değişim).
-- Bir eskalasyon adımı artık SABİT bir kişiye (target_user_id, parça 3) DEĞİL, bir nöbet
-- çizelgesine hedeflenebiliyor -- alarm-engine tetiklenme anında "şu an kim nöbetçi"yi
-- çözüp AYNI target_user_id boru hattını (parça 3) kullanır.
CREATE TABLE IF NOT EXISTS oncall_schedules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  name TEXT NOT NULL,
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Haftalık tekrar eden bir zaman penceresi + bu pencerede kim nöbetçi + öncelik.
-- day_of_week NULL = her gün. start_time > end_time ise gece yarısını aşan pencere
-- (örn. 22:00-06:00) anlamına gelir. Çakışan katmanlarda YÜKSEK öncelik kazanır.
CREATE TABLE IF NOT EXISTS oncall_layers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  schedule_id UUID NOT NULL REFERENCES oncall_schedules(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day_of_week INTEGER CHECK (day_of_week BETWEEN 0 AND 6),
  start_time TIME NOT NULL DEFAULT '00:00',
  end_time TIME NOT NULL DEFAULT '23:59:59',
  priority INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Manuel geçersiz kılma (tatil, hastalık, nöbet değişimi) -- aktif olduğu sürece TÜM
-- katmanları ezer (öncelikten bağımsız, her zaman kazanır).
CREATE TABLE IF NOT EXISTS oncall_overrides (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  schedule_id UUID NOT NULL REFERENCES oncall_schedules(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ NOT NULL,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at)
);

CREATE INDEX IF NOT EXISTS idx_oncall_overrides_active ON oncall_overrides (schedule_id, starts_at, ends_at);

ALTER TABLE escalation_policy_steps
  ADD COLUMN IF NOT EXISTS target_oncall_schedule_id UUID REFERENCES oncall_schedules(id) ON DELETE SET NULL;
