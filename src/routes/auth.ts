import { Router } from "express";
import {
  COOKIE_NAME,
  clearSessionCookie,
  createSession,
  destroySession,
  hashPassword,
  loadUserBySession,
  requireAuth,
  setSessionCookie,
  verifyPassword
} from "../auth.js";
import { db, nowSql } from "../db.js";

const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const authRouter = Router();

authRouter.get("/me", (req, res) => {
  const user = loadUserBySession(req.cookies[COOKIE_NAME]);
  if (!user) {
    res.status(401).json({ error: "Not signed in." });
    return;
  }
  res.json({ user });
});

authRouter.post("/register", async (req, res) => {
  const name = String(req.body?.name ?? "").trim();
  const email = String(req.body?.email ?? "").trim().toLowerCase();
  const password = String(req.body?.password ?? "");

  if (name.length < 2) {
    res.status(400).json({ error: "Name must be at least 2 characters." });
    return;
  }
  if (!emailRe.test(email)) {
    res.status(400).json({ error: "Enter a valid email." });
    return;
  }
  if (password.length < 8) {
    res.status(400).json({ error: "Password must be at least 8 characters." });
    return;
  }

  const exists = db.prepare("SELECT id FROM users WHERE email = ?").get(email);
  if (exists) {
    res.status(409).json({ error: "That email is already registered." });
    return;
  }

  const count = (db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n;
  const role = count === 0 ? "admin" : "dev";
  const hash = await hashPassword(password);
  const result = db
    .prepare(
      "INSERT INTO users (name, email, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)"
    )
    .run(name, email, hash, role, nowSql());

  const token = createSession(Number(result.lastInsertRowid));
  setSessionCookie(res, token);
  const user = loadUserBySession(token);
  res.status(201).json({ user });
});

authRouter.post("/login", async (req, res) => {
  const email = String(req.body?.email ?? "").trim().toLowerCase();
  const password = String(req.body?.password ?? "");
  const row = db
    .prepare("SELECT id, password_hash FROM users WHERE email = ?")
    .get(email) as { id: number; password_hash: string } | undefined;

  if (!row || !(await verifyPassword(password, row.password_hash))) {
    res.status(401).json({ error: "Invalid email or password." });
    return;
  }

  const token = createSession(row.id);
  setSessionCookie(res, token);
  const user = loadUserBySession(token);
  res.json({ user });
});

authRouter.post("/logout", requireAuth, (req, res) => {
  destroySession(req.cookies[COOKIE_NAME]);
  clearSessionCookie(res);
  res.json({ ok: true });
});
