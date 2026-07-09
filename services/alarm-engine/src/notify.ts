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

async function findTargets(tenantId: string, deviceId: string, severity: string): Promise<NotificationTarget[]> {
  const severityRank = SEVERITY_RANK[severity] ?? 1;

  const result = await pool.query(
    `SELECT DISTINCT um.destination, um.min_severity, mt.id as media_type_id, mt.type, mt.config
     FROM user_media um
     JOIN media_types mt ON mt.id = um.media_type_id
     JOIN users u ON u.id = um.user_id
     WHERE u.tenant_id = $1
       AND um.active = true
       AND mt.active = true
       AND (
         um.device_group_id IS NULL
         OR um.device_group_id IN (
           SELECT device_group_id FROM device_group_members WHERE device_id = $2
         )
       )`,
    [tenantId, deviceId]
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

async function logDelivery(alertId: string, target: NotificationTarget, status: "sent" | "failed", errorMessage?: string) {
  try {
    await pool.query(
      `INSERT INTO notification_deliveries (alert_id, media_type_id, channel_type, destination, status, error_message)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [alertId, target.media_type_id, target.type, target.destination, status, errorMessage || null]
    );
  } catch (err) {
    console.error("[Notify] Gönderim kaydı yazılamadı:", err);
  }
}

export async function notifyAlert(params: {
  alertId: string;
  tenantId: string;
  deviceId: string;
  deviceName: string;
  severity: string;
  message: string;
}) {
  try {
    const targets = await findTargets(params.tenantId, params.deviceId, params.severity);

    for (const target of targets) {
      try {
        if (target.type === "email") {
          await sendEmail(
            target.config,
            target.destination,
            `[${params.severity.toUpperCase()}] ${params.deviceName}`,
            params.message
          );
        } else if (target.type === "webhook") {
          await sendWebhook(target.destination, {
            device: params.deviceName,
            severity: params.severity,
            message: params.message,
            timestamp: new Date().toISOString()
          });
        }
        console.log(`[Notify] ${target.type} bildirimi gönderildi: ${target.destination}`);
        await logDelivery(params.alertId, target, "sent");
      } catch (err) {
        console.error(`[Notify] ${target.type} gönderim hatası (${target.destination}):`, err);
        await logDelivery(params.alertId, target, "failed", err instanceof Error ? err.message : String(err));
      }
    }
  } catch (err) {
    console.error("[Notify] Hedef bulma hatası:", err);
  }
}
