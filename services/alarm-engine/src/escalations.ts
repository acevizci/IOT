import { Pool } from "pg";

interface EscalationStep {
  step_order: number;
  delay_seconds: number;
  action_type: "notify" | "remote_command";
  remote_command: string | null;
  media_type: string | null;
  media_type_config: Record<string, any> | null;
}

const CORE_SERVICE_URL = process.env.CORE_SERVICE_URL || "http://core-service:3000";
const INTERNAL_SECRET = process.env.INTERNAL_SERVICE_SECRET || "";

async function fetchEscalationSteps(alertRuleId: string): Promise<EscalationStep[]> {
  try {
    const response = await fetch(`${CORE_SERVICE_URL}/api/v1/internal/alert-rules/${alertRuleId}/escalation-steps`, {
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
export async function processEscalations(pool: Pool): Promise<void> {
  const openAlerts = await pool.query(
    `SELECT id, rule_id, device_id, triggered_at, last_escalation_step
     FROM alerts WHERE resolved_at IS NULL`
  );

  for (const alert of openAlerts.rows) {
    const steps = await fetchEscalationSteps(alert.rule_id);
    if (steps.length === 0) continue;

    const elapsedSeconds = (Date.now() - new Date(alert.triggered_at).getTime()) / 1000;
    const nextStep = steps.find((s) => s.step_order === alert.last_escalation_step + 1);
    if (!nextStep) continue;

    if (elapsedSeconds < nextStep.delay_seconds) continue;

    if (nextStep.action_type === "remote_command" && nextStep.remote_command) {
      await triggerRemoteCommand(alert.device_id, nextStep.remote_command);
    } else if (nextStep.action_type === "notify") {
      console.log(`[Escalation] Bildirim adımı tetiklendi: alert=${alert.id} step=${nextStep.step_order}`);
      // Not: gerçek bildirim gönderimi mevcut notify.ts mekanizmasını kullanabilir,
      // burada sadece eskalasyon adımının ilerlediğini logluyoruz (temel iskelet).
    }

    await pool.query(`UPDATE alerts SET last_escalation_step = $1 WHERE id = $2`, [nextStep.step_order, alert.id]);
    console.log(`[Escalation] Alarm ${alert.id} adım ${nextStep.step_order}'e ilerledi (${elapsedSeconds.toFixed(0)}s geçti, gecikme: ${nextStep.delay_seconds}s)`);
  }
}
