# SFCC Skills Arena

HTML + TypeScript practice ground for Salesforce B2C Commerce Cloud. The team works through learning tracks, earns points on first-time correct answers, keeps a signed-in session, and climbs a leaderboard.

## How the database is modeled

SQLite file: `data/arena.db` (created on first boot). Totals are never stored as a mutable counter. They are **summed from an append-only ledger**, so scores can be audited and rebuilt.

```
users ─┬─ sessions                 (cookie token → user, with expiry)
       ├─ attempts ── attempt_answers
       ├─ earned_question_points   (unique user + question → no farming)
       └─ points_ledger            (every +/− points event)

tracks ── questions ── options     (correct flags stay on the server)
```

| Table | What it stores |
| --- | --- |
| `users` | Name, email, password hash, role (`dev` / `admin`) |
| `sessions` | Random token in an HttpOnly cookie, expiry |
| `tracks` | Learning path, default points, pass percent |
| `questions` | Text, single/multi, difficulty, **point value**, explanation |
| `options` | Answers; `is_correct` never sent until the attempt is finished |
| `attempts` | One quiz run and its score |
| `attempt_answers` | What the user picked on that run |
| `earned_question_points` | Unique `(user_id, question_id)` — points for a question can be earned once |
| `points_ledger` | Audit log: quiz awards and admin adjustments |

**Scoring rules**

- Quiz score = sum of question points answered correctly on that attempt.
- Arena points = ledger sum. A correct answer writes a ledger row only if that user has never banked that question.
- Retakes are allowed; they train people without inflating the board.
- Leaderboard = `SUM(points_ledger.points)` per developer, optional per-track and last-7-days filters.

## Run it

```bash
cd ~/Projects/sfcc-skills-arena
npm install
npm run seed    # optional; also runs automatically on first server start
npm run dev
```

Open [http://localhost:3847](http://localhost:3847).

| Account | Password | Role |
| --- | --- | --- |
| `admin@arena.local` | `ChangeMe!admin` | admin |
| `alex@arena.local` | `demo1234` | dev (seeded points) |
| `jordan@arena.local` | `demo1234` | dev (seeded points) |
| `sam@arena.local` | `demo1234` | dev |

The first *new* self-registered user on an empty user table becomes admin; after that, registrations are developers.

## API

- `POST /api/auth/register` `POST /api/auth/login` `POST /api/auth/logout` `GET /api/auth/me`
- `GET /api/tracks` · `POST /api/tracks/:id/start`
- `POST /api/attempts/:id/answer` · `POST /api/attempts/:id/finish`
- `GET /api/leaderboard?trackId=&window=7d`
- `GET /api/me/progress`
- Admin: `GET/POST /api/admin/questions` · `GET /api/admin/users` · `POST /api/admin/points`

Questions live in `src/seed/questions.json` if you want to bulk-edit the bank, then `npm run seed`.
# sfcc-skill-arena
