import nodemailer from "nodemailer";
import pg from "pg";

const { Pool } = pg;

const pool = new Pool({
  host: process.env.POSTGRES_HOST || "postgres",
  port: Number(process.env.POSTGRES_PORT) || 5432,
  user: process.env.POSTGRES_USER,
  password: process.env.POSTGRES_PASSWORD,
  database: process.env.POSTGRES_DB,
  max: 5
});

const SEVERITY_RANK: Record<string, number> = {
  info: 0,
  warning: 1,
  average: 2,
  high: 3,
  disaster: 4
};

interface NotificationTarget {
  media_type_id: string;
  type: "email" | "webhook";
  config: any;
  destination: string;
  min_severity: string;
}

// GÜVENİLİRLİK DÜZELTMESİ: mediaTypeId verilirse (eskalasyon adımları için),
// sadece o KANAL TİPİNE ait hedefler döner -- escalation_steps tablosu bir
// hedef/kullanıcı belirtmiyor, sadece "bu adımda hangi kanal tipiyle bildirilsin"
// belirtiyor; gerçek alıcılar yine normal user_media/min_severity mantığından
// gelir, sadece kanal tipine göre filtrelenir.
async function findTargets(tenantId: string, deviceId: string, severity: string, mediaTypeId?: string): Promise<NotificationTarget[]> {
  const severityRank = SEVERITY_RANK[severity] ?? 1;

  const result = await pool.query(
    `SELECT DISTINCT um.destination, um.min_severity, mt.id as media_type_id, mt.type, mt.config
     FROM user_media um
     JOIN media_types mt ON mt.id = um.media_type_id
     JOIN users u ON u.id = um.user_id
     WHERE u.tenant_id = $1
       AND um.active = true
       AND mt.active = true
       AND ($3::uuid IS NULL OR mt.id = $3)
       AND (
         um.device_group_id IS NULL
         OR um.device_group_id IN (
           SELECT device_group_id FROM device_group_members WHERE device_id = $2
         )
       )`,
    [tenantId, deviceId, mediaTypeId || null]
  );

  // min_severity filtresi: hedefin eşiği, gelen alarmın önem derecesinden
  // YÜKSEKSE bu hedefe bildirim gitmez.
  const filtered: NotificationTarget[] = [];
  for (const row of result.rows) {
    const targetMinRank = SEVERITY_RANK[row.min_severity] ?? 1;
    if (severityRank < targetMinRank) continue;
    filtered.push({
      media_type_id: row.media_type_id,
      type: row.type,
      config: row.config,
      destination: row.destination,
      min_severity: row.min_severity
    });
  }
  return filtered;
}

async function sendEmail(config: any, destination: string, subject: string, body: string) {
  const transporter = nodemailer.createTransport({
    host: config.smtp_host,
    port: config.smtp_port || 587,
    secure: config.smtp_secure || false,
    auth: config.smtp_user ? { user: config.smtp_user, pass: config.smtp_pass } : undefined
  });

  await transporter.sendMail({
    from: config.from || "alerts@obs-platform.local",
    to: destination,
    subject,
    text: body
  });
}

async function sendWebhook(destination: string, payload: any) {
  const response = await fetch(destination, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (!response.ok) {
    throw new Error(`Webhook başarısız: ${response.status}`);
  }
}

// GÜVENİLİRLİK DÜZELTMESİ: önceden bir gönderim TEK SEFER denenip, başarısız
// olursa hiç tekrar denenmeden "failed" olarak kaydediliyordu -- canlıda bu
// yüzden 137 başarısız / 14 başarılı webhook birikmişti. Şimdi KISA bir bekleme
// ile 3 deneme yapılıyor (aynı değerlendirme turunda geçici bir hatayı/429'u
// atlatmak için); yine de başarısız olursa periyodik retryFailedDeliveries()
// bir sonraki turlarda tekrar dener (bkz. aşağıda).
async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  const delaysMs = [500, 2000];
  let lastErr: unknown;
  for (let attempt = 0; attempt <= delaysMs.length; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt < delaysMs.length) await new Promise((resolve) => setTimeout(resolve, delaysMs[attempt]));
    }
  }
  throw lastErr;
}

async function logDelivery(alertId: string, target: NotificationTarget, status: "sent" | "failed", payload: any, errorMessage?: string) {
  try {
    await pool.query(
      `INSERT INTO notification_deliveries (alert_id, media_type_id, channel_type, destination, status, error_message, payload)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [alertId, target.media_type_id, target.type, target.destination, status, errorMessage || null, JSON.stringify(payload)]
    );
  } catch (err) {
    console.error("[Notify] Gönderim kaydı yazılamadı:", err);
  }
}

async function deliverToTarget(alertId: string, target: NotificationTarget, statusLabel: string, params: { deviceName: string; severity: string; message: string; resolved?: boolean }) {
  try {
    if (target.type === "email") {
      const subject = `[${statusLabel}] ${params.deviceName}`;
      const body = params.resolved ? `Çözüldü: ${params.message}` : params.message;
      await withRetry(() => sendEmail(target.config, target.destination, subject, body));
      await logDelivery(alertId, target, "sent", { type: "email", subject, body });
    } else if (target.type === "webhook") {
      const payload = {
        device: params.deviceName,
        severity: params.severity,
        message: params.message,
        resolved: params.resolved ?? false,
        timestamp: new Date().toISOString()
      };
      await withRetry(() => sendWebhook(target.destination, payload));
      await logDelivery(alertId, target, "sent", { type: "webhook", body: payload });
    }
    console.log(`[Notify] ${target.type} bildirimi gönderildi (${params.resolved ? "çözüldü" : "yeni"}): ${target.destination}`);
  } catch (err) {
    console.error(`[Notify] ${target.type} gönderim hatası (${target.destination}):`, err);
    const payload = target.type === "email"
      ? { type: "email", subject: `[${statusLabel}] ${params.deviceName}`, body: params.resolved ? `Çözüldü: ${params.message}` : params.message }
      : { type: "webhook", body: { device: params.deviceName, severity: params.severity, message: params.message, resolved: params.resolved ?? false, timestamp: new Date().toISOString() } };
    await logDelivery(alertId, target, "failed", payload, err instanceof Error ? err.message : String(err));
  }
}

export async function notifyAlert(params: {
  alertId: string;
  tenantId: string;
  deviceId: string;
  deviceName: string;
  severity: string;
  message: string;
  resolved?: boolean;
}) {
  try {
    const targets = await findTargets(params.tenantId, params.deviceId, params.severity);
    const statusLabel = params.resolved ? "ÇÖZÜLDÜ" : params.severity.toUpperCase();
    for (const target of targets) {
      await deliverToTarget(params.alertId, target, statusLabel, params);
    }
  } catch (err) {
    console.error("[Notify] Hedef bulma hatası:", err);
  }
}

// EKSİKLİK DÜZELTMESİ: eskalasyon "notify" adımları önceden sadece konsola log
// yazıyordu, GERÇEKTEN hiçbir bildirim göndermiyordu (bkz. escalations.ts).
// Bu fonksiyon, o adımın belirttiği KANAL TİPİNE (mediaTypeId) ait hedeflere
// gerçek bir eskalasyon bildirimi gönderir.
export async function notifyEscalationStep(params: {
  alertId: string;
  tenantId: string;
  deviceId: string;
  deviceName: string;
  severity: string;
  message: string;
  mediaTypeId: string;
  stepOrder: number;
}) {
  try {
    const targets = await findTargets(params.tenantId, params.deviceId, params.severity, params.mediaTypeId);
    if (targets.length === 0) {
      console.log(`[Escalation] Adım ${params.stepOrder} için hiç hedef bulunamadı (media_type=${params.mediaTypeId})`);
      return;
    }
    const escalationMessage = `[Eskalasyon adım ${params.stepOrder}] Bu alarm hâlâ çözülmedi: ${params.message}`;
    for (const target of targets) {
      await deliverToTarget(params.alertId, target, `ESKALASYON-${params.severity.toUpperCase()}`, {
        deviceName: params.deviceName,
        severity: params.severity,
        message: escalationMessage
      });
    }
  } catch (err) {
    console.error("[Escalation] Bildirim gönderim hatası:", err);
  }
}

// GÜVENİLİRLİK DÜZELTMESİ: daha önce başarısız olup payload'ı saklanmış
// gönderimleri periyodik olarak yeniden dener. Sonsuza dek denemez (retry_count
// sınırı) ve çok eski (muhtemelen artık anlamsız) gönderimleri tekrar denemez
// (RETRY_WINDOW_MINUTES). Kalıcı olarak çalışmayan bir hedefin (örn. yanlış
// yapılandırılmış webhook URL'i) sonsuz retry ile sistemi meşgul etmesini önler.
const MAX_RETRY_ATTEMPTS = 5;
const RETRY_WINDOW_MINUTES = 60;

export async function retryFailedDeliveries() {
  const failed = await pool.query(
    `SELECT id, media_type_id, destination, channel_type, payload
     FROM notification_deliveries
     WHERE status = 'failed' AND retry_count < $1 AND sent_at > now() - ($2 || ' minutes')::interval`,
    [MAX_RETRY_ATTEMPTS, RETRY_WINDOW_MINUTES]
  );
  if (failed.rows.length === 0) return;
  console.log(`[Notify] ${failed.rows.length} başarısız bildirim yeniden deneniyor...`);

  for (const row of failed.rows) {
    try {
      const payload = row.payload || {};
      if (row.channel_type === "email") {
        const mediaTypeResult = await pool.query(`SELECT config FROM media_types WHERE id = $1`, [row.media_type_id]);
        if (mediaTypeResult.rows.length === 0) {
          await pool.query(`UPDATE notification_deliveries SET retry_count = retry_count + 1 WHERE id = $1`, [row.id]);
          continue;
        }
        await sendEmail(mediaTypeResult.rows[0].config, row.destination, payload.subject, payload.body);
      } else if (row.channel_type === "webhook") {
        await sendWebhook(row.destination, payload.body);
      }
      await pool.query(
        `UPDATE notification_deliveries SET status = 'sent', error_message = NULL, retry_count = retry_count + 1 WHERE id = $1`,
        [row.id]
      );
      console.log(`[Notify] Retry başarılı: delivery=${row.id} (${row.channel_type} -> ${row.destination})`);
    } catch (err) {
      await pool.query(
        `UPDATE notification_deliveries SET retry_count = retry_count + 1, error_message = $2 WHERE id = $1`,
        [row.id, err instanceof Error ? err.message : String(err)]
      );
      console.error(`[Notify] Retry başarısız: delivery=${row.id}`, err);
    }
  }
}
