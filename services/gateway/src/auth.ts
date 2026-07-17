import jwt from "jsonwebtoken";

const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-change-me";

export type PermissionLevel = "none" | "read" | "read_write";
export type PermissionMap = Record<string, PermissionLevel>;

export interface JwtPayload {
  userId: string;
  tenantId: string;
  email: string;
  roleId?: string | null;
  permissions?: PermissionMap;
}

export function verifyToken(token: string): JwtPayload {
  return jwt.verify(token, JWT_SECRET) as JwtPayload;
}
