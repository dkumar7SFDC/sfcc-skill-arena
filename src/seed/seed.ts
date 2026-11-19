import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { hashPassword } from "../auth.js";
import { db, nowSql, transaction } from "../db.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

interface SeedOption {
  text: string;
  correct?: boolean;
}

interface SeedQuestion {
  text: string;
  type: "single" | "multi";
  difficulty: "easy" | "medium" | "hard";
  points: number;
  explanation: string;
  options: SeedOption[];
}

interface SeedTrack {
  slug: string;
  title: string;
  description: string;
  icon: string;
  pointsPerQuestion: number;
  passPercent: number;
  sortOrder: number;
  questions: SeedQuestion[];
}

interface SeedFile {
  tracks: SeedTrack[];
}

const seedUsers = [
  { name: "Arena Admin", email: "admin@arena.local", password: "ChangeMe!admin", role: "admin" as const },
  { name: "Alex Rivera", email: "alex@arena.local", password: "demo1234", role: "dev" as const },
  { name: "Jordan Patel", email: "jordan@arena.local", password: "demo1234", role: "dev" as const },
  { name: "Sam Okonkwo", email: "sam@arena.local", password: "demo1234", role: "dev" as const }
];

function loadSeedFile(): SeedFile {
  return JSON.parse(readFileSync(join(__dirname, "questions.json"), "utf8")) as SeedFile;
}

export function seedCatalog(): void {
  const { tracks } = loadSeedFile();
  const insertTrack = db.prepare(
    `INSERT INTO tracks (slug, title, description, icon, points_per_question, pass_percent, sort_order)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(slug) DO UPDATE SET
       title = excluded.title,
       description = excluded.description,
       icon = excluded.icon,
       points_per_question = excluded.points_per_question,
       pass_percent = excluded.pass_percent,
       sort_order = excluded.sort_order`
  );

  transaction(() => {
    for (const track of tracks) {
      insertTrack.run(
        track.slug,
        track.title,
        track.description,
        track.icon,
        track.pointsPerQuestion,
        track.passPercent,
        track.sortOrder
      );
      const row = db.prepare("SELECT id FROM tracks WHERE slug = ?").get(track.slug) as {
        id: number;
      };
      const existing = db
        .prepare("SELECT COUNT(*) AS n FROM questions WHERE track_id = ?")
        .get(row.id) as { n: number };
      if (existing.n > 0) continue;

      track.questions.forEach((q, qi) => {
        const qid = Number(
          db
            .prepare(
              `INSERT INTO questions (track_id, text, type, difficulty, points, explanation, sort_order)
               VALUES (?, ?, ?, ?, ?, ?, ?)`
            )
            .run(row.id, q.text, q.type, q.difficulty, q.points, q.explanation, qi + 1)
            .lastInsertRowid
        );
        q.options.forEach((opt, oi) => {
          db.prepare(
            "INSERT INTO options (question_id, text, is_correct, sort_order) VALUES (?, ?, ?, ?)"
          ).run(qid, opt.text, opt.correct ? 1 : 0, oi + 1);
        });
      });
    }
  });
}

export async function seedDemoUsers(): Promise<void> {
  for (const user of seedUsers) {
    const exists = db.prepare("SELECT id FROM users WHERE email = ?").get(user.email);
    if (exists) continue;
    const hash = await hashPassword(user.password);
    db.prepare(
      "INSERT INTO users (name, email, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)"
    ).run(user.name, user.email, hash, user.role, nowSql());
  }
}

function seedDemoProgress(): void {
  const alex = db.prepare("SELECT id FROM users WHERE email = ?").get("alex@arena.local") as
    | { id: number }
    | undefined;
  const jordan = db.prepare("SELECT id FROM users WHERE email = ?").get("jordan@arena.local") as
    | { id: number }
    | undefined;
  if (!alex || !jordan) return;

  const already = db
    .prepare("SELECT COUNT(*) AS n FROM points_ledger WHERE user_id IN (?, ?)")
    .get(alex.id, jordan.id) as { n: number };
  if (already.n > 0) return;

  const awardCorrect = (userId: number, trackSlug: string, count: number) => {
    const track = db.prepare("SELECT id FROM tracks WHERE slug = ?").get(trackSlug) as { id: number };
    const questions = db
      .prepare("SELECT id, points FROM questions WHERE track_id = ? ORDER BY sort_order LIMIT ?")
      .all(track.id, count) as { id: number; points: number }[];
    const attemptId = Number(
      db
        .prepare(
          "INSERT INTO attempts (user_id, track_id, started_at, finished_at, score, max_score, passed) VALUES (?, ?, ?, ?, ?, ?, 1)"
        )
        .run(userId, track.id, nowSql(), nowSql(), 0, 0).lastInsertRowid
    );
    let score = 0;
    let max = 0;
    for (const q of questions) {
      max += q.points;
      score += q.points;
      db.prepare(
        `INSERT INTO earned_question_points (user_id, question_id, track_id, attempt_id, points, earned_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(userId, q.id, track.id, attemptId, q.points, nowSql());
      db.prepare(
        `INSERT INTO points_ledger (user_id, track_id, attempt_id, question_id, points, reason, created_at)
         VALUES (?, ?, ?, ?, ?, 'correct_first_time', ?)`
      ).run(userId, track.id, attemptId, q.id, q.points, nowSql());
    }
    db.prepare("UPDATE attempts SET score = ?, max_score = ? WHERE id = ?").run(score, max, attemptId);
  };

  transaction(() => {
    awardCorrect(alex.id, "architecture", 5);
    awardCorrect(alex.id, "sfra", 3);
    awardCorrect(jordan.id, "architecture", 3);
    awardCorrect(jordan.id, "apis", 4);
  });
}

export async function seedIfEmpty(): Promise<void> {
  seedCatalog();
  await seedDemoUsers();
  seedDemoProgress();
}

async function main(): Promise<void> {
  seedCatalog();
  await seedDemoUsers();
  seedDemoProgress();
  const tracks = (db.prepare("SELECT COUNT(*) AS n FROM tracks").get() as { n: number }).n;
  const questions = (db.prepare("SELECT COUNT(*) AS n FROM questions").get() as { n: number }).n;
  const users = (db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n;
  console.log(`Seed complete: ${tracks} tracks, ${questions} questions, ${users} users.`);
}

const isDirect = process.argv[1]?.includes("seed.ts") || process.argv[1]?.includes("seed.js");
if (isDirect) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
