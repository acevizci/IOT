// RCA Adım 4 -- Olay (incident) motoru.
// alarm-engine, computeRootCauseCandidates'ı DOĞRUDAN import edemez (ayrı servis/build)
// -> core-service'in /api/v1/internal/root-cause-check endpoint'ini HTTP ile çağırır.
// escalations.ts ile AYNI internal-çağrı deseni (CORE_SERVICE_URL + x-internal-secret).

const CORE_SERVICE_URL = process.env.CORE_SERVICE_URL || "http://core-service:3000";
const INTERNAL_SECRET = process.env.INTERNAL_SERVICE_SECRET || "";

// Yeni bir alarm açıldığında çağrılır (fire-and-forget). Hata alarm akışını ETKİLEMEZ
// ve alarm-engine'i çökertmez -- tüm gövde try/catch ile sarılı, çağıranlar await etmez.
export async function checkRootCauseAndCreateIncident(
  tenantId: string,
  deviceId: string,
  alertId: string
): Promise<void> {
  try {
    await fetch(`${CORE_SERVICE_URL}/api/v1/internal/root-cause-check`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-internal-secret": INTERNAL_SECRET },
      body: JSON.stringify({ tenantId, deviceId, alertId })
    });
  } catch (err) {
    console.error("[Incident] root-cause-check çağrısı başarısız (yok sayıldı):", (err as Error).message);
  }
}

// Açık incident'ları tarar; kök-neden alarmı VE tüm etkilenen alarmlar çözülmüşse
// (resolved_at IS NOT NULL) incident'ı otomatik kapatır. Her resolved_at update'ine
// ayrı hook eklemek yerine (4 farklı yer, invaziv) alarm-engine'in periyodik döngüsünde.
export async function reconcileIncidents(pool: any): Promise<void> {
  const open = await pool.query(`SELECT id, root_cause_alert_id FROM incidents WHERE status = 'open'`);
  for (const inc of open.rows) {
    // Kök-neden alarmı hâlâ açıksa incident açık kalır.
    if (inc.root_cause_alert_id) {
      const rc = await pool.query(
        `SELECT 1 FROM alerts WHERE id = $1 AND resolved_at IS NULL`,
        [inc.root_cause_alert_id]
      );
      if (rc.rows.length > 0) continue;
    }
    // Etkilenen alarmlardan herhangi biri hâlâ açıksa incident açık kalır.
    const openAffected = await pool.query(
      `SELECT 1 FROM incident_affected_alerts iaa
       JOIN alerts a ON a.id = iaa.alert_id
       WHERE iaa.incident_id = $1 AND a.resolved_at IS NULL LIMIT 1`,
      [inc.id]
    );
    if (openAffected.rows.length > 0) continue;
    // Kök-neden + tüm etkilenenler çözülmüş -> incident'ı kapat.
    await pool.query(
      `UPDATE incidents SET status = 'resolved', resolved_at = now(), updated_at = now() WHERE id = $1`,
      [inc.id]
    );
    console.log(`[Incident] Otomatik kapatıldı (tüm alarmlar çözüldü): incident=${inc.id}`);
  }
}
