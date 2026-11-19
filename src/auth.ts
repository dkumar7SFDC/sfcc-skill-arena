import { randomBytes, timingSafeEqual } from "node:crypto";
import bcrypt from "bcryptjs";
import type { NextFunction, Request, Response } from "express";
import { db, nowSql } from "./db.js";
import type { AuthedUser, Role } from "./types.js";

const SESSION_DAYS = 14;
export const COOKIE_NAME = "arena_sid";

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 10);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

export function createSession(userId: number): string {
  const token = randomBytes(32).toString("hex");
  const expires = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000)
    .toISOString()
    .replace("T", " ")
    .slice(0, 19);
  db.prepare(
    "INSERT INTO sessions (token, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)"
  ).run(token, userId, expires, nowSql());
  return token;
}

export function destroySession(token: string | undefined): void {
  if (!token) return;
  db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
}

export function setSessionCookie(res: Response, token: string): void {
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_DAYS * 24 * 60 * 60 * 1000
  });
}

export function clearSessionCookie(res: Response): void {
  res.clearCookie(COOKIE_NAME, { path: "/" });
}

function loadUser(userId: number): AuthedUser | undefined {
  return db
    .prepare(
      `SELECT user_id AS id, name, email, role, created_at, total_points, questions_mastered
       FROM v_user_points WHERE user_id = ?`
    )
    .get(userId) as AuthedUser | undefined;
}

export function loadUserBySession(token: string | undefined): AuthedUser | undefined {
  if (!token) return undefined;
  const row = db
    .prepare(
      `SELECT user_id FROM sessions WHERE token = ? AND expires_at > datetime('now')`
    )
    .get(token) as { user_id: number } | undefined;
  if (!row) return undefined;
  return loadUser(row.user_id);
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const user = loadUserBySession(req.cookies[COOKIE_NAME]);
  if (!user) {
    res.status(401).json({ error: "Sign in required." });
    return;
  }
  req.user = user;
  next();
}

export function requireRole(...roles: Role[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ error: "Sign in required." });
      return;
    }
    if (!roles.includes(req.user.role)) {
      res.status(403).json({ error: "Admins only." });
      return;
    }
    next();
  };
}

export function passwordsMatch(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
