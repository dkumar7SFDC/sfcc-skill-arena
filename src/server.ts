import cookieParser from "cookie-parser";
import express from "express";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { adminRouter } from "./routes/admin.js";
import { attemptsRouter } from "./routes/attempts.js";
import { authRouter } from "./routes/auth.js";
import { leaderboardRouter } from "./routes/leaderboard.js";
import { meRouter } from "./routes/me.js";
import { tracksRouter } from "./routes/tracks.js";
import { seedIfEmpty } from "./seed/seed.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const publicDir = join(__dirname, "..", "public");
const port = Number(process.env.PORT) || 3847;

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));
app.use(cookieParser());
app.use(
  express.static(publicDir, {
    setHeaders(res) {
      // Always revalidate so CSS/JS edits show up on a normal refresh.
      res.setHeader("Cache-Control", "no-cache");
    }
  })
);

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});
app.use("/api/auth", authRouter);
app.use("/api/tracks", tracksRouter);
app.use("/api/attempts", attemptsRouter);
app.use("/api/leaderboard", leaderboardRouter);
app.use("/api/me", meRouter);
app.use("/api/admin", adminRouter);

app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err);
  res.status(500).json({ error: err.message || "Server error" });
});

await seedIfEmpty();

app.listen(port, () => {
  console.log(`SFCC Skills Arena running at http://localhost:${port}`);
});
