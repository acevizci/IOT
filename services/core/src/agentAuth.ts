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
