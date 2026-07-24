import crypto from "crypto";

// Agent kayıt token'ı (tenant-seviyesinde) — API Token'ımızla aynı desen (SHA-256 hash).
export function generateRegistrationToken(): { rawToken: string; tokenHash: string } {
  const rawToken = `agentreg_${crypto.randomBytes(32).toString("hex")}`;
  const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");
  return { rawToken, tokenHash };
}

export function hashRegistrationToken(rawToken: string): string {
  return crypto.createHash("sha256").update(rawToken).digest("hex");
}

// Cihaza özel PSK (Pre-Shared Key) — Zabbix'in TLSPSKFile deseniyle aynı fikir:
// agent bu anahtarı yerel olarak saklar, her istekte kimliğini kanıtlamak için kullanır.
export function generateDevicePsk(): { rawPsk: string; pskHash: string } {
  const rawPsk = crypto.randomBytes(32).toString("hex"); // 256-bit, Zabbix PSK minimumuyla uyumlu
  const pskHash = crypto.createHash("sha256").update(rawPsk).digest("hex");
  return { rawPsk, pskHash };
}

export function hashDevicePsk(rawPsk: string): string {
  return crypto.createHash("sha256").update(rawPsk).digest("hex");
}

// Proxy kayıt token'ı (tenant-seviyesinde) — agent registration token'ıyla AYNI desen,
// sadece önek farklı (proxyreg_) ki loglarda/DB'de bir agent token'ıyla karıştırılmasın.
export function generateProxyRegistrationToken(): { rawToken: string; tokenHash: string } {
  const rawToken = `proxyreg_${crypto.randomBytes(32).toString("hex")}`;
  const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");
  return { rawToken, tokenHash };
}

export function hashProxyRegistrationToken(rawToken: string): string {
  return crypto.createHash("sha256").update(rawToken).digest("hex");
}

// Proxy'nin kendi kimliği (proxy_id + proxy_secret) — cihaz PSK'siyle aynı desen,
// merkeze proxy'nin kendisini kanıtlaması için (batch içindeki her cihazın PSK'si
// AYRICA doğrulanır, bu iki katmanlı güvenlik modelinin dış katmanı).
export function generateProxySecret(): { rawSecret: string; secretHash: string } {
  const rawSecret = crypto.randomBytes(32).toString("hex"); // 256-bit
  const secretHash = crypto.createHash("sha256").update(rawSecret).digest("hex");
  return { rawSecret, secretHash };
}

export function hashProxySecret(rawSecret: string): string {
  return crypto.createHash("sha256").update(rawSecret).digest("hex");
}
