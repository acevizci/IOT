import jwt from "jsonwebtoken";

const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-change-me";
const JWT_EXPIRES_IN = "8h";

// FAZ 1: eski 3 sabit boolean (canEditDevices/canEditAlertRules/canManageUsers)
// kaldırıldı -- artık her kaynak için ayrı satır tutan user_role_permissions
// tablosundan türetilen, kaynak->seviye haritası JWT'de taşınıyor.
export type PermissionLevel = "none" | "read" | "read_write";
export type PermissionMap = Record<string, PermissionLevel>;

export interface JwtPayload {
  userId: string;
  tenantId: string;
  email: string;
  roleId: string | null;
  permissions: PermissionMap;
}

export function signToken(payload: JwtPayload): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
}

export function verifyToken(token: string): JwtPayload {
  return jwt.verify(token, JWT_SECRET) as JwtPayload;
}
