import { Router } from "express";
import { requireAuth } from "../auth.js";
import { db } from "../db.js";

export const leaderboardRouter = Router();
leaderboardRouter.use(requireAuth);

leaderboardRouter.get("/", (req, res) => {
  const trackId = req.query.trackId ? Number(req.query.trackId) : undefined;
  const windowDays = req.query.window === "7d" ? 7 : undefined;

  const tracks = db
    .prepare("SELECT id, slug, title FROM tracks ORDER BY sort_order, id")
    .all();

  if (trackId) {
    const rows = db
      .prepare(
        `SELECT
           u.id AS user_id,
           u.name,
           COALESCE(SUM(l.points), 0) AS points,
           COUNT(DISTINCT e.question_id) AS mastered
         FROM users u
         LEFT JOIN points_ledger l
           ON l.user_id = u.id AND l.track_id = ?
           ${windowDays ? "AND l.created_at >= datetime('now', ?)" : ""}
         LEFT JOIN earned_question_points e
           ON e.user_id = u.id AND e.track_id = ?
         WHERE u.role != 'admin'
         GROUP BY u.id
         ORDER BY points DESC, mastered DESC, u.name`
      )
      .all(
        ...(windowDays
          ? [trackId, `-${windowDays} days`, trackId]
          : [trackId, trackId])
      );
    res.json({ tracks, entries: rows, trackId, window: windowDays ? "7d" : "all" });
    return;
  }

  const rows = db
    .prepare(
      `SELECT
         u.id AS user_id,
         u.name,
         COALESCE((
           SELECT SUM(l.points) FROM points_ledger l
           WHERE l.user_id = u.id
           ${windowDays ? "AND l.created_at >= datetime('now', ?)" : ""}
         ), 0) AS points,
         (SELECT COUNT(*) FROM earned_question_points e WHERE e.user_id = u.id) AS mastered,
         (SELECT COUNT(DISTINCT e.track_id) FROM earned_question_points e WHERE e.user_id = u.id) AS tracks
       FROM users u
       WHERE u.role != 'admin'
       ORDER BY points DESC, mastered DESC, u.name`
    )
    .all(...(windowDays ? [`-${windowDays} days`] : []));

  res.json({ tracks, entries: rows, trackId: null, window: windowDays ? "7d" : "all" });
});
