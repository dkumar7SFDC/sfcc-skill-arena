import { Router } from "express";
import { requireAuth } from "../auth.js";
import { db, nowSql, parseIds, sameSet, transaction } from "../db.js";
import type { OptionRow, QuestionRow } from "../types.js";

export const attemptsRouter = Router();
attemptsRouter.use(requireAuth);

function publicQuestion(q: QuestionRow, options: OptionRow[]) {
  return {
    id: q.id,
    text: q.text,
    type: q.type,
    difficulty: q.difficulty,
    points: q.points,
    options: options.map((o) => ({ id: o.id, text: o.text }))
  };
}

function getAttemptForUser(attemptId: string | string[] | undefined, userId: number) {
  return db
    .prepare("SELECT * FROM attempts WHERE id = ? AND user_id = ?")
    .get(String(attemptId), userId) as
    | {
        id: number;
        user_id: number;
        track_id: number;
        started_at: string;
        finished_at: string | null;
        score: number;
        max_score: number;
        passed: number;
      }
    | undefined;
}

attemptsRouter.get("/:id", (req, res) => {
  const attempt = getAttemptForUser(req.params.id, req.user!.id);
  if (!attempt) {
    res.status(404).json({ error: "Attempt not found." });
    return;
  }

  const questions = db
    .prepare(
      "SELECT * FROM questions WHERE track_id = ? ORDER BY sort_order, id"
    )
    .all(attempt.track_id) as QuestionRow[];
  const saved = db
    .prepare(
      "SELECT question_id, selected_option_ids FROM attempt_answers WHERE attempt_id = ?"
    )
    .all(attempt.id) as { question_id: number; selected_option_ids: string }[];
  const selectedByQuestion = Object.fromEntries(
    saved.map((row) => [row.question_id, parseIds(row.selected_option_ids)])
  );

  res.json({
    attempt: {
      id: attempt.id,
      trackId: attempt.track_id,
      startedAt: attempt.started_at,
      finishedAt: attempt.finished_at,
      score: attempt.score,
      maxScore: attempt.max_score
    },
    questions: questions.map((q) => {
      const options = db
        .prepare(
          "SELECT * FROM options WHERE question_id = ? ORDER BY sort_order, id"
        )
        .all(q.id) as OptionRow[];
      return {
        ...publicQuestion(q, options),
        selectedOptionIds: selectedByQuestion[q.id] ?? []
      };
    })
  });
});

attemptsRouter.post("/:id/answer", (req, res) => {
  const attempt = getAttemptForUser(req.params.id, req.user!.id);
  if (!attempt) {
    res.status(404).json({ error: "Attempt not found." });
    return;
  }
  if (attempt.finished_at) {
    res.status(400).json({ error: "This attempt is already finished." });
    return;
  }

  const questionId = Number(req.body?.questionId);
  const optionIds = Array.isArray(req.body?.optionIds)
    ? (req.body.optionIds as unknown[]).map(Number)
    : [];
  const question = db
    .prepare("SELECT * FROM questions WHERE id = ? AND track_id = ?")
    .get(questionId, attempt.track_id) as QuestionRow | undefined;
  if (!question) {
    res.status(400).json({ error: "Question is not part of this track." });
    return;
  }

  const validIds = new Set(
    (
      db
        .prepare("SELECT id FROM options WHERE question_id = ?")
        .all(questionId) as { id: number }[]
    ).map((o) => o.id)
  );
  if (optionIds.some((id) => !validIds.has(id))) {
    res.status(400).json({ error: "Invalid option selected." });
    return;
  }
  if (question.type === "single" && optionIds.length > 1) {
    res.status(400).json({ error: "Pick a single answer." });
    return;
  }

  db.prepare(
    `INSERT INTO attempt_answers (attempt_id, question_id, selected_option_ids)
     VALUES (?, ?, ?)
     ON CONFLICT(attempt_id, question_id)
     DO UPDATE SET selected_option_ids = excluded.selected_option_ids`
  ).run(attempt.id, questionId, JSON.stringify(optionIds));

  res.json({ ok: true });
});

attemptsRouter.post("/:id/finish", (req, res) => {
  const attempt = getAttemptForUser(req.params.id, req.user!.id);
  if (!attempt) {
    res.status(404).json({ error: "Attempt not found." });
    return;
  }
  if (attempt.finished_at) {
    res.status(400).json({ error: "This attempt is already finished." });
    return;
  }

  const incoming = Array.isArray(req.body?.answers)
    ? (req.body.answers as { questionId: number; optionIds: number[] }[])
    : [];
  for (const ans of incoming) {
    const questionId = Number(ans.questionId);
    const optionIds = Array.isArray(ans.optionIds) ? ans.optionIds.map(Number) : [];
    const question = db
      .prepare("SELECT id FROM questions WHERE id = ? AND track_id = ?")
      .get(questionId, attempt.track_id);
    if (!question) continue;
    db.prepare(
      `INSERT INTO attempt_answers (attempt_id, question_id, selected_option_ids)
       VALUES (?, ?, ?)
       ON CONFLICT(attempt_id, question_id)
       DO UPDATE SET selected_option_ids = excluded.selected_option_ids`
    ).run(attempt.id, questionId, JSON.stringify(optionIds));
  }

  const questions = db
    .prepare(
      "SELECT * FROM questions WHERE track_id = ? ORDER BY sort_order, id"
    )
    .all(attempt.track_id) as QuestionRow[];
  const track = db
    .prepare("SELECT * FROM tracks WHERE id = ?")
    .get(attempt.track_id) as { pass_percent: number };

  let score = 0;
  let maxScore = 0;
  let newlyEarned = 0;
  const review = [];

  const result = transaction(() => {
    for (const q of questions) {
      maxScore += q.points;
      const options = db
        .prepare(
          "SELECT * FROM options WHERE question_id = ? ORDER BY sort_order, id"
        )
        .all(q.id) as OptionRow[];
      const correctIds = options.filter((o) => o.is_correct).map((o) => o.id);
      const saved = db
        .prepare(
          "SELECT selected_option_ids FROM attempt_answers WHERE attempt_id = ? AND question_id = ?"
        )
        .get(attempt.id, q.id) as { selected_option_ids: string } | undefined;
      const selected = parseIds(saved?.selected_option_ids);
      const isCorrect = sameSet(selected, correctIds);
      if (isCorrect) score += q.points;

      let awarded = 0;
      if (isCorrect) {
        const already = db
          .prepare(
            "SELECT 1 FROM earned_question_points WHERE user_id = ? AND question_id = ?"
          )
          .get(req.user!.id, q.id);
        if (!already) {
          awarded = q.points;
          newlyEarned += awarded;
          db.prepare(
            `INSERT INTO earned_question_points
             (user_id, question_id, track_id, attempt_id, points, earned_at)
             VALUES (?, ?, ?, ?, ?, ?)`
          ).run(req.user!.id, q.id, attempt.track_id, attempt.id, awarded, nowSql());
          db.prepare(
            `INSERT INTO points_ledger
             (user_id, track_id, attempt_id, question_id, points, reason, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`
          ).run(
            req.user!.id,
            attempt.track_id,
            attempt.id,
            q.id,
            awarded,
            "correct_first_time",
            nowSql()
          );
        }
      }

      db.prepare(
        `INSERT INTO attempt_answers
         (attempt_id, question_id, selected_option_ids, is_correct, points_awarded)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(attempt_id, question_id)
         DO UPDATE SET is_correct = excluded.is_correct, points_awarded = excluded.points_awarded`
      ).run(attempt.id, q.id, JSON.stringify(selected), isCorrect ? 1 : 0, awarded);

      review.push({
        id: q.id,
        text: q.text,
        type: q.type,
        difficulty: q.difficulty,
        points: q.points,
        explanation: q.explanation,
        selectedOptionIds: selected,
        correctOptionIds: correctIds,
        isCorrect,
        pointsAwarded: awarded,
        options: options.map((o) => ({
          id: o.id,
          text: o.text,
          isCorrect: Boolean(o.is_correct)
        }))
      });
    }

    const passed = maxScore > 0 && (score / maxScore) * 100 >= track.pass_percent ? 1 : 0;
    db.prepare(
      `UPDATE attempts
       SET finished_at = ?, score = ?, max_score = ?, passed = ?
       WHERE id = ?`
    ).run(nowSql(), score, maxScore, passed, attempt.id);

    return { score, maxScore, passed: Boolean(passed), newlyEarned };
  });
  const totals = db
    .prepare(
      "SELECT total_points, questions_mastered FROM v_user_points WHERE user_id = ?"
    )
    .get(req.user!.id) as { total_points: number; questions_mastered: number };

  res.json({
    attemptId: attempt.id,
    trackId: attempt.track_id,
    ...result,
    totalPoints: totals.total_points,
    questionsMastered: totals.questions_mastered,
    review
  });
});
