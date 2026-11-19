import { Router } from "express";
import { requireAuth } from "../auth.js";
import { db } from "../db.js";

export const meRouter = Router();
meRouter.use(requireAuth);

meRouter.get("/progress", (req, res) => {
  const userId = req.user!.id;
  const tracks = db
    .prepare(
      `SELECT
         t.id, t.slug, t.title, t.icon,
         (SELECT COUNT(*) FROM questions q WHERE q.track_id = t.id) AS question_count,
         (SELECT COUNT(*) FROM earned_question_points e
           WHERE e.user_id = ? AND e.track_id = t.id) AS mastered_count,
         (SELECT COALESCE(SUM(e.points), 0) FROM earned_question_points e
           WHERE e.user_id = ? AND e.track_id = t.id) AS earned_points,
         (SELECT COALESCE(SUM(q.points), 0) FROM questions q WHERE q.track_id = t.id) AS available_points
       FROM tracks t
       ORDER BY t.sort_order`
    )
    .all(userId, userId);

  const attempts = db
    .prepare(
      `SELECT a.id, a.track_id, t.title AS track_title, a.started_at, a.finished_at,
              a.score, a.max_score, a.passed
       FROM attempts a
       JOIN tracks t ON t.id = a.track_id
       WHERE a.user_id = ? AND a.finished_at IS NOT NULL
       ORDER BY a.finished_at DESC
       LIMIT 20`
    )
    .all(userId);

  const ledger = db
    .prepare(
      `SELECT l.id, l.points, l.reason, l.created_at, t.title AS track_title
       FROM points_ledger l
       LEFT JOIN tracks t ON t.id = l.track_id
       WHERE l.user_id = ?
       ORDER BY l.created_at DESC
       LIMIT 30`
    )
    .all(userId);

  res.json({
    user: req.user,
    tracks,
    attempts,
    ledger
  });
});
