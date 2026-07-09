import crypto from "crypto";

const ALGORITHM = "aes-256-gcm";

function getKey(): Buffer {
  const hexKey = process.env.CREDENTIAL_ENCRYPTION_KEY;
  if (!hexKey || hexKey.length !== 64) {
    throw new Error("CREDENTIAL_ENCRYPTION_KEY tanımlı değil veya yanlış uzunlukta (64 hex karakter olmalı)");
  }
  return Buffer.from(hexKey, "hex");
}

// Şifreli metni "iv:authTag:ciphertext" (hepsi hex) formatında tek bir string olarak döner —
// tek bir TEXT kolonunda saklanabilsin diye.
export function encryptSecret(plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, getKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${authTag.toString("hex")}:${encrypted.toString("hex")}`;
}

export function decryptSecret(stored: string): string {
  const [ivHex, authTagHex, encryptedHex] = stored.split(":");
  const decipher = crypto.createDecipheriv(ALGORITHM, getKey(), Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(authTagHex, "hex"));
  const decrypted = Buffer.concat([decipher.update(Buffer.from(encryptedHex, "hex")), decipher.final()]);
  return decrypted.toString("utf8");
}
