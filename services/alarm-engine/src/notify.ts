import nodemailer from "nodemailer";
import pg from "pg";
import webpush from "web-push";
import { decryptSecret } from "./crypto.js";

const { Pool } = pg;

const pool = new Pool({
  host: process.env.POSTGRES_HOST || "postgres",
  port: Number(process.env.POSTGRES_PORT) || 5432,
  user: process.env.POSTGRES_USER,
  password: process.env.POSTGRES_PASSWORD,
  database: process.env.POSTGRES_DB,
  max: 5
});

// GERÇEK EKSİKLİK DÜZELTMESİ (alarm sistemi incelemesi): 'critical' burada hiç
// tanımlı değildi -- alerts.severity CHECK kısıtlaması bunu izin veriyordu ama
// hiçbir yol onu üretemiyordu (kural/kanal şemaları eksikti, ayrıca düzeltildi).
// Tanımsız kalsaydı SEVERITY_RANK[severity] ?? 1 ile sessizce 'warning' sırasına
// düşer, min_severity='disaster' ayarlamış bir kullanıcı 'critical' alarmlarını
// HİÇ ALMAZDI. disaster'dan sonraki en yüksek sıra olarak ekleniyor.
const SEVERITY_RANK: Record<string, number> = {
  info: 0,
  warning: 1,
  average: 2,
  high: 3,
  disaster: 4,
  critical: 5
};

const SEVERITY_LABEL_TR: Record<string, string> = {
  info: "Bilgi",
  warning: "Uyarı",
  average: "Orta",
  high: "Yüksek",
  disaster: "Felaket",
  critical: "Kritik"
};

// Bildirim sistemi tasarımı ("uçtan uca bildirim sistemi" turunun 1. parçası --
// kullanıcıyla konuşulup kararlaştırıldı): mail içeriği önceden burada tamamen
// sabit kodlanmıştı -- artık her tenant'ın kendi email_templates satırından
// (services/core/src/index.ts'teki CRUD'la düzenlenebilir) okunuyor.
const DASHBOARD_BASE_URL = process.env.DASHBOARD_BASE_URL || "http://localhost:5173";

// Web Push (bildirim sistemi parça 5): VAPID anahtarları platform-genelinde (env
// değişkeni) -- media_types.config'te GEREKMİYOR, tüm webpush kanalları AYNI anahtar
// çiftini kullanır (tarayıcı push API'sinin gereksinimi budur, SMTP gibi kanal-bazlı değil).
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || "";
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || "";
if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(process.env.VAPID_SUBJECT || "mailto:admin@localhost", VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
}

interface EmailTemplateRow {
  subject: string;
  body_html: string;
  body_text: string;
}

async function fetchEmailTemplate(tenantId: string, templateType: "new_alert" | "resolved_alert" | "escalation"): Promise<EmailTemplateRow | null> {
  const result = await pool.query(
    `SELECT subject, body_html, body_text FROM email_templates WHERE tenant_id = $1 AND template_type = $2`,
    [tenantId, templateType]
  );
  return result.rows[0] || null;
}

// Basit {{degisken}} yer değiştirmesi -- kullanılabilir değişkenler: cihaz_adi,
// severity, severity_etiketi, mesaj, tetiklenme_zamani, cozulme_zamani, adim_no,
// tenant_adi, alarm_linki. Tanımsız bir değişken boş string'e düşer (sessizce).
function renderTemplate(text: string, vars: Record<string, string>): string {
  return text.replace(/\{\{(\w+)\}\}/g, (_, key: string) => vars[key] ?? "");
}

interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

async function renderEmailContent(
  tenantId: string,
  templateType: "new_alert" | "resolved_alert" | "escalation",
  vars: Record<string, string>,
  fallback: { subject: string; text: string }
): Promise<RenderedEmail> {
  const template = await fetchEmailTemplate(tenantId, templateType);
  if (!template) {
    // GERÇEK EKSİKLİK için savunma: tenant'ın (beklenmedik şekilde) hiç şablon
    // satırı yoksa eski sabit-metin davranışına düşülür -- bildirim asla sessizce
    // engellenmez.
    return { subject: fallback.subject, text: fallback.text, html: "" };
  }
  return {
    subject: renderTemplate(template.subject, vars),
    text: renderTemplate(template.body_text, vars),
    html: renderTemplate(template.body_html, vars)
  };
}

interface NotificationTarget {
  media_type_id: string;
  type: "email" | "webhook" | "sms" | "webpush";
  config: any;
  destination: string;
  min_severity: string;
}

// GÜVENİLİRLİK DÜZELTMESİ: mediaTypeId verilirse (eskalasyon adımları için),
// sadece o KANAL TİPİNE ait hedefler döner -- escalation_steps tablosu bir
// hedef/kullanıcı belirtmiyor, sadece "bu adımda hangi kanal tipiyle bildirilsin"
// belirtiyor; gerçek alıcılar yine normal user_media/min_severity mantığından
// gelir, sadece kanal tipine göre filtrelenir.
//
// Eskalasyon adımı hedefleme (parça 3, kullanıcıyla konuşulup kararlaştırıldı):
// targetUserId verilirse SADECE o kullanıcının kanalına gidilir -- ve bilinçli
// olarak min_severity/device_group filtreleri ATLANIR. Gerekçe: bu artık genel
// bir yayın kuralı değil, "bu alarmda kesinlikle şu kişiye ulaşılsın" diyen
// açık bir insan kararı -- o kişinin kendi genel tercihi (örn. sadece critical
// alsın) yüzünden sessizce atlanması, hedeflemenin amacını boşa çıkarır.
async function findTargets(tenantId: string, deviceId: string, severity: string, mediaTypeId?: string, targetUserId?: string): Promise<NotificationTarget[]> {
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
       AND ($4::uuid IS NULL OR um.user_id = $4)
       AND (
         $4::uuid IS NOT NULL
         OR um.device_group_id IS NULL
         OR um.device_group_id IN (
           SELECT device_group_id FROM device_group_members WHERE device_id = $2
         )
       )`,
    [tenantId, deviceId, mediaTypeId || null, targetUserId || null]
  );

  // min_severity filtresi: hedefin eşiği, gelen alarmın önem derecesinden
  // YÜKSEKSE bu hedefe bildirim gitmez -- targetUserId belirtilmişse bu filtre
  // de atlanır (yukarıdaki gerekçe).
  const filtered: NotificationTarget[] = [];
  for (const row of result.rows) {
    if (!targetUserId) {
      const targetMinRank = SEVERITY_RANK[row.min_severity] ?? 1;
      if (severityRank < targetMinRank) continue;
    }
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

// GERÇEK EKSİKLİK DÜZELTMESİ (bildirim sistemi tasarımı): config.smtp_pass
// önceden config JSONB'de DÜZ METİN olarak bekleniyordu (ki zaten hiç
// toplanmıyordu) -- artık core encryptSecret ile şifreleyip smtp_pass_encrypted
// olarak saklıyor, burada AYNI anahtarla (CREDENTIAL_ENCRYPTION_KEY) çözülüyor.
async function sendEmail(config: any, destination: string, subject: string, textBody: string, htmlBody?: string) {
  const pass = config.smtp_pass_encrypted ? decryptSecret(config.smtp_pass_encrypted) : undefined;
  const transporter = nodemailer.createTransport({
    host: config.smtp_host,
    port: config.smtp_port || 587,
    secure: config.smtp_secure || false,
    auth: config.smtp_user ? { user: config.smtp_user, pass } : undefined
  });

  await transporter.sendMail({
    from: config.from || "alerts@obs-platform.local",
    to: destination,
    subject,
    text: textBody,
    html: htmlBody || undefined
  });
}

// Bildirim sistemi tasarımı (parça 5, kullanıcıyla konuşulup kararlaştırıldı): PagerDuty,
// webhook'un yeni bir "format"ı olarak eklendi (Slack/Teams ile AYNI mantık) -- ayrı bir
// media_types.type GEREKMİYOR. PagerDuty'nin gerçek isteği her zaman SABİT bir URL'e gider
// (PAGERDUTY_EVENTS_URL); kullanıcının "destination" olarak girdiği değer gerçekte o
// entegrasyonun routing_key'idir (URL değil). dedup_key=alertId ile trigger/resolve AYNI
// PagerDuty olayını eşleştirir (aksi halde resolve, trigger edilen olayı hiç kapatamaz).
const PAGERDUTY_EVENTS_URL = "https://events.pagerduty.com/v2/enqueue";
const PAGERDUTY_SEVERITY_MAP: Record<string, string> = {
  info: "info",
  warning: "warning",
  average: "warning",
  high: "error",
  disaster: "critical",
  critical: "critical"
};

// GERÇEK EKSİKLİK DÜZELTMESİ: sabit {device,severity,message,...} JSON'u
// Slack/Teams'in beklediği payload şekliyle UYUŞMUYORDU -- webhook kanalı
// gerçekte sadece ham JSON alıcılarla (webhook.site gibi) çalışıyordu, Slack'e
// bağlanan biri hiçbir mesaj görmüyordu (Slack "text" alanı yoksa mesajı
// SESSİZCE reddeder/göstermez). media_types.config.format'a göre doğru şekli üretir.
function buildWebhookPayload(
  config: any,
  params: { deviceName: string; severity: string; message: string; resolved?: boolean },
  destination: string,
  alertId: string
): any {
  const format = config?.format || "generic";
  const statusIcon = params.resolved ? "✅" : "🔴";
  const text = `${statusIcon} [${params.severity.toUpperCase()}] ${params.deviceName}: ${params.resolved ? "Çözüldü: " : ""}${params.message}`;

  if (format === "slack") {
    return { text };
  }
  if (format === "teams") {
    return {
      "@type": "MessageCard",
      "@context": "http://schema.org/extensions",
      summary: text,
      themeColor: params.resolved ? "5ecca3" : "ea6b53",
      text
    };
  }
  if (format === "pagerduty") {
    return {
      routing_key: destination,
      event_action: params.resolved ? "resolve" : "trigger",
      dedup_key: alertId,
      payload: {
        summary: text,
        severity: PAGERDUTY_SEVERITY_MAP[params.severity] || "warning",
        source: params.deviceName,
        timestamp: new Date().toISOString()
      }
    };
  }
  return {
    device: params.deviceName,
    severity: params.severity,
    message: params.message,
    resolved: params.resolved ?? false,
    timestamp: new Date().toISOString()
  };
}

// PagerDuty her zaman PAGERDUTY_EVENTS_URL'e gider -- kullanıcının girdiği "destination"
// gerçek istek URL'i değil, payload içindeki routing_key'dir (bkz. buildWebhookPayload).
function webhookRequestUrl(config: any, destination: string): string {
  return config?.format === "pagerduty" ? PAGERDUTY_EVENTS_URL : destination;
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

// Genel HTTP SMS geçidi (bildirim sistemi parça 5, kullanıcıyla konuşulup
// kararlaştırıldı): Twilio'ya ÖZEL DEĞİL -- kullanıcı kendi SMS sağlayıcısının HTTP
// endpoint'ini yapılandırır. Gövde şablonu opsiyonel ({{to}}/{{message}} yer
// tutucuları) -- boşsa basit bir varsayılan JSON gövdesi kullanılır. sms_auth_token,
// smtp_pass ile AYNI şekilde şifreli saklanır (core'da encryptSecret), burada çözülür.
async function sendSms(config: any, destination: string, message: string) {
  const token = config?.sms_auth_token_encrypted ? decryptSecret(config.sms_auth_token_encrypted) : undefined;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (config?.sms_auth_header && token) {
    headers[config.sms_auth_header] = token;
  }
  const template = config?.sms_body_template || '{"to":"{{to}}","message":"{{message}}"}';
  const body = template
    .replace(/\{\{to\}\}/g, destination)
    .replace(/\{\{message\}\}/g, message.replace(/"/g, '\\"'));

  const method = config?.sms_method === "GET" ? "GET" : "POST";
  const url = method === "GET" ? `${config.sms_endpoint_url}?${new URLSearchParams({ to: destination, message }).toString()}` : config.sms_endpoint_url;
  const response = await fetch(url, {
    method,
    headers,
    body: method === "GET" ? undefined : body
  });
  if (!response.ok) {
    throw new Error(`SMS gönderimi başarısız: ${response.status}`);
  }
}

// Tarayıcı Web Push (bildirim sistemi parça 5): "destination" kullanıcının tarayıcısında
// üretilen bir PushSubscription objesinin JSON string'i (endpoint + p256dh/auth anahtarları)
// -- kullanıcı bunu YAZMAZ, frontend'deki abone olma akışıyla otomatik üretilir.
async function sendWebPush(destination: string, title: string, body: string) {
  const subscription = JSON.parse(destination);
  await webpush.sendNotification(subscription, JSON.stringify({ title, body }));
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

async function deliverToTarget(
  alertId: string,
  target: NotificationTarget,
  emailContent: RenderedEmail,
  webhookParams: { deviceName: string; severity: string; message: string; resolved?: boolean }
) {
  try {
    if (target.type === "email") {
      await withRetry(() => sendEmail(target.config, target.destination, emailContent.subject, emailContent.text, emailContent.html));
      await logDelivery(alertId, target, "sent", { type: "email", subject: emailContent.subject, body: emailContent.text, html: emailContent.html });
    } else if (target.type === "webhook") {
      const payload = buildWebhookPayload(target.config, webhookParams, target.destination, alertId);
      await withRetry(() => sendWebhook(webhookRequestUrl(target.config, target.destination), payload));
      await logDelivery(alertId, target, "sent", { type: "webhook", body: payload });
    } else if (target.type === "sms") {
      await withRetry(() => sendSms(target.config, target.destination, emailContent.text));
      await logDelivery(alertId, target, "sent", { type: "sms", body: emailContent.text });
    } else if (target.type === "webpush") {
      await withRetry(() => sendWebPush(target.destination, emailContent.subject, emailContent.text));
      await logDelivery(alertId, target, "sent", { type: "webpush", body: { title: emailContent.subject, body: emailContent.text } });
    }
    console.log(`[Notify] ${target.type} bildirimi gönderildi (${webhookParams.resolved ? "çözüldü" : "yeni"}): ${target.destination}`);
  } catch (err) {
    console.error(`[Notify] ${target.type} gönderim hatası (${target.destination}):`, err);
    const payload = target.type === "email"
      ? { type: "email", subject: emailContent.subject, body: emailContent.text, html: emailContent.html }
      : target.type === "webhook"
      ? { type: "webhook", body: buildWebhookPayload(target.config, webhookParams, target.destination, alertId) }
      : target.type === "sms"
      ? { type: "sms", body: emailContent.text }
      : { type: "webpush", body: { title: emailContent.subject, body: emailContent.text } };
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
    if (targets.length === 0) return;

    const statusLabel = params.resolved ? "ÇÖZÜLDÜ" : params.severity.toUpperCase();
    const now = new Date().toLocaleString("tr-TR");
    const vars: Record<string, string> = {
      cihaz_adi: params.deviceName,
      severity: params.severity,
      severity_etiketi: SEVERITY_LABEL_TR[params.severity] ?? params.severity,
      mesaj: params.message,
      tetiklenme_zamani: now,
      cozulme_zamani: params.resolved ? now : "",
      alarm_linki: `${DASHBOARD_BASE_URL}/alerts/${params.alertId}`
    };
    const emailContent = await renderEmailContent(
      params.tenantId,
      params.resolved ? "resolved_alert" : "new_alert",
      vars,
      { subject: `[${statusLabel}] ${params.deviceName}`, text: params.resolved ? `Çözüldü: ${params.message}` : params.message }
    );

    for (const target of targets) {
      await deliverToTarget(params.alertId, target, emailContent, params);
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
  targetUserId?: string | null;
}) {
  try {
    const targets = await findTargets(params.tenantId, params.deviceId, params.severity, params.mediaTypeId, params.targetUserId || undefined);
    if (targets.length === 0) {
      console.log(
        params.targetUserId
          ? `[Escalation] Adım ${params.stepOrder} için hedef kişide (user=${params.targetUserId}) bu kanal tipinde (media_type=${params.mediaTypeId}) bildirim ayarı bulunamadı`
          : `[Escalation] Adım ${params.stepOrder} için hiç hedef bulunamadı (media_type=${params.mediaTypeId})`
      );
      return;
    }
    const escalationMessage = `[Eskalasyon adım ${params.stepOrder}] Bu alarm hâlâ çözülmedi: ${params.message}`;
    const vars: Record<string, string> = {
      cihaz_adi: params.deviceName,
      severity: params.severity,
      severity_etiketi: SEVERITY_LABEL_TR[params.severity] ?? params.severity,
      mesaj: params.message,
      tetiklenme_zamani: new Date().toLocaleString("tr-TR"),
      adim_no: String(params.stepOrder),
      alarm_linki: `${DASHBOARD_BASE_URL}/alerts/${params.alertId}`
    };
    const emailContent = await renderEmailContent(
      params.tenantId,
      "escalation",
      vars,
      { subject: `[ESKALASYON ${params.stepOrder}] ${params.deviceName}`, text: escalationMessage }
    );

    for (const target of targets) {
      await deliverToTarget(params.alertId, target, emailContent, {
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
        await sendEmail(mediaTypeResult.rows[0].config, row.destination, payload.subject, payload.body, payload.html);
      } else if (row.channel_type === "webhook") {
        const mediaTypeResult = await pool.query(`SELECT config FROM media_types WHERE id = $1`, [row.media_type_id]);
        await sendWebhook(webhookRequestUrl(mediaTypeResult.rows[0]?.config, row.destination), payload.body);
      } else if (row.channel_type === "sms") {
        const mediaTypeResult = await pool.query(`SELECT config FROM media_types WHERE id = $1`, [row.media_type_id]);
        await sendSms(mediaTypeResult.rows[0]?.config, row.destination, payload.body);
      } else if (row.channel_type === "webpush") {
        await sendWebPush(row.destination, payload.body?.title, payload.body?.body);
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

// Test bildirimi -- kullanıcı gerçek bir alarm oluşana kadar kanalın çalışıp
// çalışmadığını hiç öğrenemiyordu. Gerçek bir alarma bağlı olmadığı için
// notification_deliveries'e kayıt YAZMIYOR (alert_id NOT NULL FK) -- sadece
// gönderimin başarılı olup olmadığını doğrudan çağırana döndürür.
export async function sendTestNotification(mediaType: { type: string; config: any }, destination: string): Promise<void> {
  const testParams = {
    deviceName: "Test Cihazı",
    severity: "warning",
    message: "Bu, bildirim kanalınızın çalıştığını doğrulamak için gönderilen bir test mesajıdır.",
    resolved: false
  };
  if (mediaType.type === "email") {
    await sendEmail(mediaType.config, destination, "[TEST] Gözlem Platformu Bildirim Testi", testParams.message);
  } else if (mediaType.type === "webhook") {
    const payload = buildWebhookPayload(mediaType.config, testParams, destination, `test-${Date.now()}`);
    await sendWebhook(webhookRequestUrl(mediaType.config, destination), payload);
  } else if (mediaType.type === "sms") {
    await sendSms(mediaType.config, destination, testParams.message);
  } else if (mediaType.type === "webpush") {
    await sendWebPush(destination, "[TEST] Gözlem Platformu Bildirim Testi", testParams.message);
  } else {
    throw new Error(`Bilinmeyen kanal tipi: ${mediaType.type}`);
  }
}

// Mail Şablonları sekmesindeki "Test gönder" -- kanal testinden (yukarıdaki
// sendTestNotification) FARKLI olarak, kullanıcının O AN KAYDETMEDİĞİ/kaydettiği
// GERÇEK şablon içeriğini örnek verilerle render edip gönderir -- böylece
// kaydetmeden önce gerçek e-posta istemcisinde nasıl göründüğünü görebilir.
export async function sendTestEmailWithTemplate(
  mediaType: { type: string; config: any },
  destination: string,
  template: { subject: string; body_html: string; body_text: string }
): Promise<void> {
  if (mediaType.type !== "email") {
    throw new Error("Şablon testi sadece email kanalları için geçerlidir");
  }
  const now = new Date().toLocaleString("tr-TR");
  const vars: Record<string, string> = {
    cihaz_adi: "Test Cihazı",
    severity: "high",
    severity_etiketi: SEVERITY_LABEL_TR.high,
    mesaj: "Bu, mail şablonunuzun gerçek bir e-posta istemcisinde nasıl görüneceğini doğrulamak için gönderilen bir test mesajıdır.",
    tetiklenme_zamani: now,
    cozulme_zamani: now,
    adim_no: "1",
    alarm_linki: `${DASHBOARD_BASE_URL}/alerts/test`
  };
  const subject = `[TEST] ${renderTemplate(template.subject, vars)}`;
  const text = renderTemplate(template.body_text, vars);
  const html = renderTemplate(template.body_html, vars);
  await sendEmail(mediaType.config, destination, subject, text, html);
}
