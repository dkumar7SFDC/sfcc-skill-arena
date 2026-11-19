import { Router } from "express";
import { requireAuth, requireRole } from "../auth.js";
import { db, nowSql, transaction } from "../db.js";

export const adminRouter = Router();
adminRouter.use(requireAuth, requireRole("admin"));

adminRouter.get("/questions", (req, res) => {
  const trackId = req.query.trackId ? Number(req.query.trackId) : undefined;
  const sql = trackId
    ? `SELECT q.*, t.title AS track_title, t.slug AS track_slug
       FROM questions q JOIN tracks t ON t.id = q.track_id
       WHERE q.track_id = ?
       ORDER BY q.sort_order, q.id`
    : `SELECT q.*, t.title AS track_title, t.slug AS track_slug
       FROM questions q JOIN tracks t ON t.id = q.track_id
       ORDER BY t.sort_order, q.sort_order, q.id`;
  const questions = trackId ? db.prepare(sql).all(trackId) : db.prepare(sql).all();
  const withOptions = (questions as Array<{ id: number }>).map((q) => ({
    ...q,
    options: db
      .prepare(
        "SELECT id, text, is_correct, sort_order FROM options WHERE question_id = ? ORDER BY sort_order, id"
      )
      .all(q.id)
  }));
  const tracks = db
    .prepare("SELECT id, slug, title FROM tracks ORDER BY sort_order")
    .all();
  res.json({ tracks, questions: withOptions });
});

adminRouter.post("/questions", (req, res) => {
  const trackId = Number(req.body?.trackId);
  const text = String(req.body?.text ?? "").trim();
  const type = req.body?.type === "multi" ? "multi" : "single";
  const difficulty = ["easy", "medium", "hard"].includes(req.body?.difficulty)
    ? req.body.difficulty
    : "medium";
  const points = Math.max(1, Number(req.body?.points) || 10);
  const explanation = String(req.body?.explanation ?? "").trim() || null;
  const options = Array.isArray(req.body?.options) ? req.body.options : [];

  if (!trackId || !text) {
    res.status(400).json({ error: "Track and question text are required." });
    return;
  }
  if (options.length < 2) {
    res.status(400).json({ error: "Add at least two options." });
    return;
  }
  const correctCount = options.filter((o: { correct?: boolean }) => o.correct).length;
  if (correctCount < 1) {
    res.status(400).json({ error: "Mark at least one correct option." });
    return;
  }
  if (type === "single" && correctCount !== 1) {
    res.status(400).json({ error: "Single-choice questions need exactly one correct option." });
    return;
  }

  const created = transaction(() => {
    const maxOrder = db
      .prepare(
        "SELECT COALESCE(MAX(sort_order), 0) AS n FROM questions WHERE track_id = ?"
      )
      .get(trackId) as { n: number };
    const q = db
      .prepare(
        `INSERT INTO questions (track_id, text, type, difficulty, points, explanation, sort_order)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(trackId, text, type, difficulty, points, explanation, maxOrder.n + 1);
    const questionId = Number(q.lastInsertRowid);
    options.forEach((opt: { text?: string; correct?: boolean }, i: number) => {
      const optionText = String(opt.text ?? "").trim();
      if (!optionText) return;
      db.prepare(
        "INSERT INTO options (question_id, text, is_correct, sort_order) VALUES (?, ?, ?, ?)"
      ).run(questionId, optionText, opt.correct ? 1 : 0, i + 1);
    });
    return questionId;
  })();

  res.status(201).json({ id: created });
});

adminRouter.post("/points", (req, res) => {
  const userId = Number(req.body?.userId);
  const points = Number(req.body?.points);
  const reason = String(req.body?.reason ?? "admin_adjustment").trim() || "admin_adjustment";
  const trackId = req.body?.trackId ? Number(req.body.trackId) : null;
  if (!userId || !Number.isFinite(points) || points === 0) {
    res.status(400).json({ error: "userId and non-zero points are required." });
    return;
  }
  const user = db.prepare("SELECT id FROM users WHERE id = ?").get(userId);
  if (!user) {
    res.status(404).json({ error: "User not found." });
    return;
  }
  db.prepare(
    `INSERT INTO points_ledger (user_id, track_id, points, reason, created_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(userId, trackId, points, reason, nowSql());
  res.json({ ok: true });
});

adminRouter.get("/users", (_req, res) => {
  const users = db
    .prepare(
      `SELECT user_id AS id, name, email, role, total_points, questions_mastered, created_at
       FROM v_user_points
       ORDER BY total_points DESC, name`
    )
    .all();
  res.json({ users });
});
