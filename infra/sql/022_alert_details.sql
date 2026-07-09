-- Yapısal alarm detayları — artık sadece serbest metin "message" içine gömülü değil,
-- ayrı sütunlarda tutuluyor (grafikle ilişkilendirme, filtreleme, analiz için).
ALTER TABLE alerts ADD COLUMN IF NOT EXISTS metric_name TEXT;
ALTER TABLE alerts ADD COLUMN IF NOT EXISTS condition TEXT;
ALTER TABLE alerts ADD COLUMN IF NOT EXISTS threshold NUMERIC;
ALTER TABLE alerts ADD COLUMN IF NOT EXISTS value NUMERIC;

-- Üstlenme (acknowledge) — "bunu gördüm, üzerinde çalışıyorum"
ALTER TABLE alerts ADD COLUMN IF NOT EXISTS acknowledged_at TIMESTAMPTZ;
ALTER TABLE alerts ADD COLUMN IF NOT EXISTS acknowledged_by UUID REFERENCES users(id) ON DELETE SET NULL;

-- Bir alarma bırakılan not/yorumlar (ekip içi iletişim için)
CREATE TABLE IF NOT EXISTS alert_comments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    alert_id UUID NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    comment TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_alert_comments_alert ON alert_comments(alert_id, created_at);

-- Bildirim gönderim geçmişi — önceden sadece container loglarında vardı,
-- log rotate olunca kayboluyordu. Artık kalıcı ve alarm başına sorgulanabilir.
CREATE TABLE IF NOT EXISTS notification_deliveries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    alert_id UUID NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
    media_type_id UUID REFERENCES media_types(id) ON DELETE SET NULL,
    channel_type TEXT NOT NULL,
    destination TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('sent', 'failed')),
    error_message TEXT,
    sent_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_notification_deliveries_alert ON notification_deliveries(alert_id);
