-- Manuel "çözüldü" işaretleme: kim tarafından manuel çözüldüğünü ayırt etmek için.
-- NULL ise alarm-engine tarafından OTOMATİK çözülmüş demektir (koşul artık
-- ihlal edilmiyor); dolu ise bir kullanıcı elle "çözüldü" olarak işaretlemiştir.
-- ÖNEMLİ DAVRANIŞ: manuel çözme, altta yatan koşulu DÜZELTMEZ -- eğer metrik
-- hâlâ eşiği aşıyorsa, alarm-engine'in bir sonraki değerlendirme turunda
-- (CHECK_INTERVAL_MS, varsayılan 30sn) bunu YENİ bir alarm olarak tekrar açar.
ALTER TABLE alerts ADD COLUMN IF NOT EXISTS resolved_manually_by UUID REFERENCES users(id) ON DELETE SET NULL;
