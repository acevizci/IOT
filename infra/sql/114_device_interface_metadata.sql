-- Gerçek eksiklik (kullanıcı ile ekran görüntüsü karşılaştırmasında bulundu):
-- SNMP arayüz taramamız sadece ifDescr'i (ham teknik isim, "Gi1/0/1") yakalıyordu
-- -- ağ yöneticisinin porta verdiği anlamlı açıklamayı (ifAlias, örn.
-- "Kenar_Switch_Uplink") hiç çekmiyorduk. Bu METRİK verisi değil, bir port'un
-- nispeten durağan METADATASI -- her poll turunda metrics tablosuna (zaten
-- zaman-serisi/partitioned) yazmak yerine ayrı, cihaz+arayüz başına TEK satırlı
-- bir tabloda tutuluyor.
CREATE TABLE IF NOT EXISTS device_interface_metadata (
    device_id UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    interface TEXT NOT NULL,
    alias TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (device_id, interface)
);
