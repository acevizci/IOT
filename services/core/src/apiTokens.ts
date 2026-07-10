import crypto from "crypto";

// Ham token'ı asla veritabanına yazmıyoruz — sadece SHA-256 hash'ini saklıyoruz,
// tıpkı şifre hash'lemesi gibi. Token bir kez gösterilir, kullanıcı kaybederse
// yeniden üretmesi gerekir (credential'larla aynı güvenlik prensibi).
export function generateApiToken(): { rawToken: string; tokenHash: string } {
  const rawToken = `obs_${crypto.randomBytes(32).toString("hex")}`;
  const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");
  return { rawToken, tokenHash };
}

export function hashApiToken(rawToken: string): string {
  return crypto.createHash("sha256").update(rawToken).digest("hex");
}
