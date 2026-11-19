import { Router } from "express";
import { db, nowSql, parseIds } from "../db.js";
import { requireAuth } from "../auth.js";
import type { OptionRow, QuestionRow } from "../types.js";

export const tracksRouter = Router();

tracksRouter.use(requireAuth);

tracksRouter.get("/", (req, res) => {
  const userId = req.user!.id;
  const tracks = db
    .prepare(
      `SELECT
         t.id, t.slug, t.title, t.description, t.icon,
         t.points_per_question, t.pass_percent, t.sort_order,
         (SELECT COUNT(*) FROM questions q WHERE q.track_id = t.id) AS question_count,
         (SELECT COALESCE(SUM(q.points), 0) FROM questions q WHERE q.track_id = t.id) AS available_points,
         (SELECT COUNT(*) FROM earned_question_points e
           WHERE e.user_id = ? AND e.track_id = t.id) AS mastered_count,
         (SELECT COALESCE(SUM(e.points), 0) FROM earned_question_points e
           WHERE e.user_id = ? AND e.track_id = t.id) AS earned_points,
         (SELECT MAX(a.score) FROM attempts a
           WHERE a.user_id = ? AND a.track_id = t.id AND a.finished_at IS NOT NULL) AS best_score,
         (SELECT a.max_score FROM attempts a
           WHERE a.user_id = ? AND a.track_id = t.id AND a.finished_at IS NOT NULL
           ORDER BY a.score DESC, a.finished_at DESC LIMIT 1) AS best_max,
         (SELECT a.finished_at FROM attempts a
           WHERE a.user_id = ? AND a.track_id = t.id AND a.finished_at IS NOT NULL
           ORDER BY a.finished_at DESC LIMIT 1) AS last_finished_at
       FROM tracks t
       ORDER BY t.sort_order, t.id`
    )
    .all(userId, userId, userId, userId, userId);
  res.json({ tracks });
});

tracksRouter.get("/:id", (req, res) => {
  const id = String(req.params.id);
  const track = db
    .prepare("SELECT * FROM tracks WHERE id = ? OR slug = ?")
    .get(id, id);
  if (!track) {
    res.status(404).json({ error: "Track not found." });
    return;
  }
  res.json({ track });
});

tracksRouter.post("/:id/start", (req, res) => {
  const id = String(req.params.id);
  const track = db
    .prepare("SELECT * FROM tracks WHERE id = ? OR slug = ?")
    .get(id, id) as { id: number } | undefined;
  if (!track) {
    res.status(404).json({ error: "Track not found." });
    return;
  }

  const questions = db
    .prepare(
      "SELECT * FROM questions WHERE track_id = ? ORDER BY sort_order, id"
    )
    .all(track.id) as QuestionRow[];

  if (questions.length === 0) {
    res.status(400).json({ error: "This track has no questions yet." });
    return;
  }

  const open = db
    .prepare(
      `SELECT id FROM attempts
       WHERE user_id = ? AND track_id = ? AND finished_at IS NULL
       ORDER BY started_at DESC LIMIT 1`
    )
    .get(req.user!.id, track.id) as { id: number } | undefined;

  const attemptId = open
    ? open.id
    : Number(
        db
          .prepare(
            "INSERT INTO attempts (user_id, track_id, started_at) VALUES (?, ?, ?)"
          )
          .run(req.user!.id, track.id, nowSql()).lastInsertRowid
      );

  const saved = db
    .prepare(
      "SELECT question_id, selected_option_ids FROM attempt_answers WHERE attempt_id = ?"
    )
    .all(attemptId) as { question_id: number; selected_option_ids: string }[];
  const selectedByQuestion = Object.fromEntries(
    saved.map((row) => [row.question_id, parseIds(row.selected_option_ids)])
  );

  const payload = questions.map((q) => {
    const options = db
      .prepare(
        "SELECT * FROM options WHERE question_id = ? ORDER BY sort_order, id"
      )
      .all(q.id) as OptionRow[];
    return {
      id: q.id,
      text: q.text,
      type: q.type,
      difficulty: q.difficulty,
      points: q.points,
      options: options.map((o) => ({ id: o.id, text: o.text })),
      selectedOptionIds: selectedByQuestion[q.id] ?? []
    };
  });

  res.json({ attemptId, trackId: track.id, questions: payload });
});
