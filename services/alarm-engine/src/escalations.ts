import { Pool } from "pg";
import { notifyEscalationStep } from "./notify.js";

interface EscalationStep {
  step_order: number;
  delay_seconds: number;
  action_type: "notify" | "remote_command";
  remote_command: string | null;
  media_type: string | null;
  media_type_id: string | null;
  media_type_config: Record<string, any> | null;
  // Eskalasyon adımı hedefleme (parça 3): opsiyonel spesifik kişi -- bkz. notify.ts findTargets.
  target_user_id: string | null;
}

const CORE_SERVICE_URL = process.env.CORE_SERVICE_URL || "http://core-service:3000";
const INTERNAL_SECRET = process.env.INTERNAL_SERVICE_SECRET || "";

// Bildirim sistemi tasarımı: eskalasyon artık kuraldan BAĞIMSIZ, yeniden
// kullanılabilir bir "politika"ya bağlı (escalation_policies) -- hem şablon
// hem cihaza özel kurallar aynı yoldan (alert_rules.escalation_policy_id)
// okunuyor, önceki template_rule_id'ye özel dolaylı JOIN'e gerek kalmadı.
async function fetchEscalationSteps(alertRuleId: string): Promise<EscalationStep[]> {
  try {
    const response = await fetch(`${CORE_SERVICE_URL}/api/v1/internal/alert-rules/${alertRuleId}/escalation-policy`, {
      headers: { "x-internal-secret": INTERNAL_SECRET }
    });
    if (!response.ok) return [];
    return await response.json();
  } catch (err) {
    console.error(`[Escalation] Adımlar çekilemedi (rule=${alertRuleId}):`, err);
    return [];
  }
}

// Uzak komutu, Exec Collector'ın makro çözümleme + SSH mekanizmasını yeniden kullanarak
// çalıştırmak yerine, basitlik için burada DOĞRUDAN Core Service üzerinden bir "komut
// çalıştır" isteği tetikliyoruz — Exec Collector'ın zaten var olan device_id+command
// çalıştırma yeteneğini internal bir endpoint üzerinden tetikleriz (gerçek SSH bağlantısı
// Exec Collector'da kalır, kod tekrarı olmaz).
async function triggerRemoteCommand(deviceId: string, command: string): Promise<void> {
  try {
    await fetch(`${CORE_SERVICE_URL}/api/v1/internal/trigger-remote-command`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-internal-secret": INTERNAL_SECRET },
      body: JSON.stringify({ device_id: deviceId, command })
    });
    console.log(`[Escalation] Uzak komut tetiklendi: device=${deviceId} command="${command}"`);
  } catch (err) {
    console.error(`[Escalation] Uzak komut tetiklenemedi:`, err);
  }
}

// Açık, çözülmemiş alarmları kontrol edip, süresi gelen bir sonraki eskalasyon adımını tetikler.
// GÜVENİLİRLİK DÜZELTMESİ: hem en üst seviyedeki sorgu hem de her bir alarmın işlenmesi
// artık try/catch ile korunuyor -- önceden BİR alarmın işlenmesi sırasında oluşan bir hata
// (örn. beklenmeyen bir veri şekli), setInterval ile çağrılan bu fonksiyonun TAMAMEN
// yakalanmamış bir promise reddiyle sonuçlanmasına yol açabiliyordu (Node.js'in varsayılan
// davranışı bu durumda TÜM PROCESS'İ SONLANDIRIR) -- tek bir alarmın işlenmesindeki bir
// sorun, diğer TÜM açık alarmların eskalasyonunu (ve teorik olarak tüm alarm motorunu)
// durdurabiliyordu.
export async function processEscalations(pool: Pool): Promise<void> {
  let openAlerts;
  try {
    // GERÇEK EKSİKLİK DÜZELTMESİ (bildirim sistemi tasarımı): PagerDuty/Opsgenie
    // gibi endüstri standardı escalation policy'lerde bir olay üstlenildiğinde
    // (acknowledge) eskalasyon DURUR -- birini "ilgileniyorum" dedikten sonra hâlâ
    // bir sonraki adıma (örn. yöneticiye SMS) eskalasyon etmenin bir anlamı yok.
    // Bu kontrol hiç yoktu, acknowledged_at'e bakılmaksızın eskalasyon kör körüne
    // ilerliyordu.
    // Sustur/ertele (parça 4): acknowledged_at ile AYNI mantık -- ama kalıcı değil,
    // muted_until süresi geçince alarm otomatik olarak kaldığı adımdan devam eder.
    openAlerts = await pool.query(
      `SELECT id, tenant_id, rule_id, device_id, triggered_at, last_escalation_step
       FROM alerts WHERE resolved_at IS NULL AND acknowledged_at IS NULL AND (muted_until IS NULL OR muted_until <= now())`
    );
  } catch (err) {
    console.error("[Escalation] Açık alarmlar çekilemedi (bu tur atlanıyor):", err);
    return;
  }

  for (const alert of openAlerts.rows) {
    try {
      const steps = await fetchEscalationSteps(alert.rule_id);
      if (steps.length === 0) continue;

      const elapsedSeconds = (Date.now() - new Date(alert.triggered_at).getTime()) / 1000;
      const nextStep = steps.find((s) => s.step_order === alert.last_escalation_step + 1);
      if (!nextStep) continue;

      if (elapsedSeconds < nextStep.delay_seconds) continue;

      if (nextStep.action_type === "remote_command" && nextStep.remote_command) {
        await triggerRemoteCommand(alert.device_id, nextStep.remote_command);
      } else if (nextStep.action_type === "notify") {
        // EKSİKLİK DÜZELTMESİ: önceden burada sadece console.log yapılıyordu, hiçbir
        // gerçek bildirim GÖNDERİLMİYORDU -- eskalasyon politikaları tamamen sessizdi.
        if (nextStep.media_type_id) {
          const deviceResult = await pool.query(`SELECT name FROM devices WHERE id = $1`, [alert.device_id]);
          const deviceName = deviceResult.rows[0]?.name || "Bilinmeyen cihaz";
          const alertResult = await pool.query(`SELECT message, severity FROM alerts WHERE id = $1`, [alert.id]);
          const alertRow = alertResult.rows[0];
          await notifyEscalationStep({
            alertId: alert.id,
            tenantId: alert.tenant_id,
            deviceId: alert.device_id,
            deviceName,
            severity: alertRow?.severity || "warning",
            message: alertRow?.message || "Alarm detayı bulunamadı",
            mediaTypeId: nextStep.media_type_id,
            stepOrder: nextStep.step_order,
            targetUserId: nextStep.target_user_id
          });
        } else {
          console.warn(`[Escalation] Adım ${nextStep.step_order} (rule=${alert.rule_id}) 'notify' ama media_type_id yok -- hiçbir yere bildirilemiyor`);
        }
      }

      await pool.query(`UPDATE alerts SET last_escalation_step = $1 WHERE id = $2`, [nextStep.step_order, alert.id]);
      console.log(`[Escalation] Alarm ${alert.id} adım ${nextStep.step_order}'e ilerledi (${elapsedSeconds.toFixed(0)}s geçti, gecikme: ${nextStep.delay_seconds}s)`);
    } catch (err) {
      console.error(`[Escalation] Alarm ${alert.id} işlenirken hata (diğer alarmlar etkilenmeden devam ediliyor):`, err);
    }
  }
}
