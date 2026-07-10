import jwt from "jsonwebtoken";

const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-change-me";
const JWT_EXPIRES_IN = "8h";

export interface JwtPayload {
  userId: string;
  tenantId: string;
  role: string;
  email: string;
  roleId?: string | null;
  canEditDevices: boolean;
  canEditAlertRules: boolean;
  canManageUsers: boolean;
}

export function signToken(payload: JwtPayload): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
}

export function verifyToken(token: string): JwtPayload {
  return jwt.verify(token, JWT_SECRET) as JwtPayload;
}
