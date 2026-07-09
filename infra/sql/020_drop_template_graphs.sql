-- template_graphs hiçbir zaman bir API endpoint'i veya UI'a bağlanmadı (ölü özellik).
-- Tablo zaten prod DB'den elle kaldırıldı; bu migration şemayı taze kurulumlarla
-- (yeni ortam, test DB'si vb.) tutarlı tutmak için var.
DROP TABLE IF EXISTS template_graphs;
