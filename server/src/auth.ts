import crypto from "crypto";
import { Request, Response, NextFunction } from "express";
import { dbGet } from "./db";
import { ah } from "./asyncHandler";

export function generateToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

export interface AuthedRequest extends Request {
  userId?: number;
  role?: "teacher" | "student";
}

export interface ResolvedSession {
  userId: number;
  role: "teacher" | "student";
  username: string;
}

// Shared by requireAuth (HTTP) and the multiplayer WebSocket handshake
// (ws.ts) - a WS connection has no per-request middleware pipeline, so it
// looks up the same sessions table directly off the first client message.
export async function resolveToken(token: string): Promise<ResolvedSession | undefined> {
  return dbGet<ResolvedSession>(
    "SELECT s.user_id AS \"userId\", u.role AS role, u.username AS username FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?",
    [token]
  );
}

// Opaque bearer tokens in a sessions table rather than JWTs - simpler to
// reason about for a single-server MVP (no secret to manage, revoking a
// session is just a DELETE) and it's a drop-in swap for something fancier
// later if multiple backend instances ever need to validate tokens without
// hitting the DB.
export const requireAuth = ah(async (req: AuthedRequest, res: Response, next: NextFunction) => {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Missing bearer token" });
  }

  const token = header.slice("Bearer ".length);
  const row = await resolveToken(token);

  if (!row) {
    return res.status(401).json({ error: "Invalid or expired token" });
  }

  req.userId = row.userId;
  req.role = row.role;
  next();
});

// Use after requireAuth: requireRole("teacher") / requireRole("student").
export function requireRole(role: "teacher" | "student") {
  return (req: AuthedRequest, res: Response, next: NextFunction) => {
    if (req.role !== role) {
      return res.status(403).json({ error: `This action requires a ${role} account` });
    }
    next();
  };
}
