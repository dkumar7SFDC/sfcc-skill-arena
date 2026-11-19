import { $, $$, api, escapeHtml, ICONS } from "./api.js";

const app = $("#app");
let user;
let quizState = null;

try {
  ({ user } = await api("/api/auth/me"));
} catch {
  location.replace("/");
}

$("#who").textContent = user.name;
$("#my-points").textContent = `${user.total_points} pts`;
if (user.role === "admin") $("#admin-nav").classList.remove("hidden");
$("#logout").addEventListener("click", async () => {
  await api("/api/auth/logout", { method: "POST" });
  location.href = "/";
});

function setNav(name) {
  $$("[data-nav]").forEach((el) => el.classList.toggle("active", el.dataset.nav === name));
}

function parseHash() {
  const raw = location.hash.replace(/^#\/?/, "");
  const [path] = raw.split("?");
  const [route, a, b] = path.split("/");
  return { route: route || "tracks", a, b };
}

async function render() {
  const { route, a } = parseHash();
  if (route === "quiz") return renderQuiz(a);
  if (route === "result") return renderResult();
  if (route === "leaderboard") return renderLeaderboard();
  if (route === "progress") return renderProgress();
  if (route === "admin") return renderAdmin();
  return renderTracks();
}

async function renderTracks() {
  setNav("tracks");
  const { tracks } = await api("/api/tracks");
  app.innerHTML = `
    <div class="page-head">
      <div>
        <div class="kicker">Learning paths</div>
        <h1>Pick a track and start earning</h1>
        <p>Points are awarded the first time you answer a question correctly. Retakes still train you, they just don’t farm the board.</p>
      </div>
    </div>
    <div class="grid">
      ${tracks
        .map((t) => {
          const pct = t.question_count
            ? Math.round((t.mastered_count / t.question_count) * 100)
            : 0;
          return `
            <article class="card track">
              <div class="track-icon">${ICONS[t.icon] || ICONS.path}</div>
              <h3>${escapeHtml(t.title)}</h3>
              <p>${escapeHtml(t.description)}</p>
              <div class="meta">
                <span>${t.question_count} questions</span>
                <span>${t.available_points} pts in play</span>
                <span>${t.earned_points} earned</span>
              </div>
              <div class="bar"><span style="width:${pct}%"></span></div>
              <button class="btn" data-start="${t.id}">
                ${t.mastered_count ? "Continue / retake" : "Start track"}
              </button>
            </article>`;
        })
        .join("")}
    </div>`;
  $$("[data-start]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      const data = await api(`/api/tracks/${btn.dataset.start}/start`, { method: "POST" });
      quizState = { ...data, index: 0 };
      location.hash = `#/quiz/${data.attemptId}`;
    });
  });
}

async function renderQuiz(attemptId) {
  setNav("tracks");
  if (!quizState || String(quizState.attemptId) !== String(attemptId)) {
    const data = await api(`/api/attempts/${attemptId}`);
    if (data.attempt.finishedAt) {
      app.innerHTML = `<div class="card question"><h2>This attempt is already finished.</h2><p class="tiny">Open the track again to start a new run.</p><a class="btn" href="#/tracks">Back to tracks</a></div>`;
      return;
    }
    quizState = { attemptId: data.attempt.id, trackId: data.attempt.trackId, questions: data.questions, index: 0 };
  }
  drawQuestion();
}

function drawQuestion() {
  const qs = quizState.questions;
  const i = quizState.index;
  const q = qs[i];
  const selected = new Set(q.selectedOptionIds || []);
  app.innerHTML = `
    <div class="quiz-shell">
      <aside class="card quiz-side">
        <div class="kicker">Question ${i + 1} / ${qs.length}</div>
        <h3>Stay honest</h3>
        <p class="tiny">Answers are stored on the server. Correctness is revealed only after you finish.</p>
        <div class="q-dots">
          ${qs
            .map(
              (item, idx) =>
                `<button type="button" class="${idx === i ? "on" : ""} ${item.selectedOptionIds?.length ? "done" : ""}" data-jump="${idx}">${idx + 1}</button>`
            )
            .join("")}
        </div>
        <button class="btn gold full" id="finish">Submit track</button>
      </aside>
      <section class="card question">
        <div>
          <span class="badge ${escapeHtml(q.difficulty)}">${escapeHtml(q.difficulty)}</span>
          <span class="badge">${q.points} pts</span>
          <span class="badge">${q.type === "multi" ? "Select all that apply" : "Single choice"}</span>
        </div>
        <h2 style="margin:18px 0 8px">${escapeHtml(q.text)}</h2>
        <div class="options">
          ${q.options
            .map(
              (o) => `
            <label class="option ${selected.has(o.id) ? "picked" : ""}">
              <input type="${q.type === "multi" ? "checkbox" : "radio"}" name="opt" value="${o.id}" ${selected.has(o.id) ? "checked" : ""} />
              <span>${escapeHtml(o.text)}</span>
            </label>`
            )
            .join("")}
        </div>
        <div class="actions">
          <button class="btn secondary" id="prev" ${i === 0 ? "disabled" : ""}>Back</button>
          <button class="btn" id="next">${i === qs.length - 1 ? "Review & submit" : "Next"}</button>
        </div>
      </section>
    </div>`;

  const collect = () =>
    $$("input[name=opt]:checked").map((el) => Number(el.value));

  async function persist() {
    const optionIds = collect();
    q.selectedOptionIds = optionIds;
    await api(`/api/attempts/${quizState.attemptId}/answer`, {
      method: "POST",
      body: { questionId: q.id, optionIds }
    });
  }

  $$("input[name=opt]").forEach((input) => {
    input.addEventListener("change", async () => {
      $$(".option").forEach((el) => el.classList.toggle("picked", el.querySelector("input").checked));
      await persist();
    });
  });
  $$("[data-jump]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      await persist();
      quizState.index = Number(btn.dataset.jump);
      drawQuestion();
    });
  });
  $("#prev").addEventListener("click", async () => {
    await persist();
    quizState.index -= 1;
    drawQuestion();
  });
  $("#next").addEventListener("click", async () => {
    await persist();
    if (i === qs.length - 1) return finishQuiz();
    quizState.index += 1;
    drawQuestion();
  });
  $("#finish").addEventListener("click", finishQuiz);
}

async function finishQuiz() {
  const answers = quizState.questions.map((q) => ({
    questionId: q.id,
    optionIds: q.selectedOptionIds || []
  }));
  const result = await api(`/api/attempts/${quizState.attemptId}/finish`, {
    method: "POST",
    body: { answers }
  });
  sessionStorage.setItem("last-result", JSON.stringify(result));
  user.total_points = result.totalPoints;
  $("#my-points").textContent = `${user.total_points} pts`;
  quizState = null;
  location.hash = "#/result";
}

function renderResult() {
  setNav("tracks");
  const raw = sessionStorage.getItem("last-result");
  if (!raw) {
    app.innerHTML = `<p>No result to show. <a href="#/tracks">Back to tracks</a></p>`;
    return;
  }
  const r = JSON.parse(raw);
  const pct = r.maxScore ? Math.round((r.score / r.maxScore) * 100) : 0;
  app.innerHTML = `
    <div class="page-head">
      <div>
        <div class="kicker">${r.passed ? "Passed" : "Keep training"}</div>
        <h1>${r.score} / ${r.maxScore} · ${pct}%</h1>
        <p>This run scored ${r.score} quiz points. You banked <b>${r.newlyEarned}</b> new arena points (first-time corrects only).</p>
      </div>
      <a class="btn" href="#/tracks">More tracks</a>
    </div>
    <div class="review">
      ${r.review
        .map(
          (q) => `
        <article class="card question">
          <div>
            <span class="badge ${q.isCorrect ? "easy" : "hard"}">${q.isCorrect ? "Correct" : "Incorrect"}</span>
            <span class="badge">${q.pointsAwarded} pts banked</span>
          </div>
          <h3 style="margin:12px 0">${escapeHtml(q.text)}</h3>
          <div class="options">
            ${q.options
              .map((o) => {
                const picked = q.selectedOptionIds.includes(o.id);
                const cls = o.isCorrect ? "right" : picked ? "wrong" : "";
                return `<div class="option ${cls}">${escapeHtml(o.text)}</div>`;
              })
              .join("")}
          </div>
          ${q.explanation ? `<div class="explain">${escapeHtml(q.explanation)}</div>` : ""}
        </article>`
        )
        .join("")}
    </div>`;
}

async function renderLeaderboard() {
  setNav("leaderboard");
  const params = new URLSearchParams(location.hash.split("?")[1] || "");
  const trackId = params.get("trackId") || "";
  const window = params.get("window") || "all";
  const qs = new URLSearchParams();
  if (trackId) qs.set("trackId", trackId);
  if (window === "7d") qs.set("window", "7d");
  const data = await api(`/api/leaderboard?${qs.toString()}`);
  app.innerHTML = `
    <div class="page-head">
      <div>
        <div class="kicker">Team board</div>
        <h1>Who’s climbing the stack</h1>
        <p>Totals come from the points ledger. Admin users are excluded so the board stays a developer race.</p>
      </div>
      <div class="filters">
        <select id="track-filter">
          <option value="">All tracks</option>
          ${data.tracks.map((t) => `<option value="${t.id}" ${String(t.id) === trackId ? "selected" : ""}>${escapeHtml(t.title)}</option>`).join("")}
        </select>
        <select id="window-filter">
          <option value="all" ${window === "all" ? "selected" : ""}>All time</option>
          <option value="7d" ${window === "7d" ? "selected" : ""}>Last 7 days</option>
        </select>
      </div>
    </div>
    <div class="card" style="padding:8px 18px 18px">
      <table class="table">
        <thead><tr><th>#</th><th>Developer</th><th>Points</th><th>Mastered</th></tr></thead>
        <tbody>
          ${
            data.entries.length
              ? data.entries
                  .map(
                    (row, i) => `
            <tr class="${row.user_id === user.id ? "me" : ""}">
              <td class="rank">${i + 1}</td>
              <td>${escapeHtml(row.name)}${row.user_id === user.id ? " · you" : ""}</td>
              <td>${row.points}</td>
              <td>${row.mastered}${row.tracks != null ? ` · ${row.tracks} tracks` : ""}</td>
            </tr>`
                  )
                  .join("")
              : `<tr><td colspan="4">No scores yet.</td></tr>`
          }
        </tbody>
      </table>
    </div>`;
  const apply = () => {
    const t = $("#track-filter").value;
    const w = $("#window-filter").value;
    const next = new URLSearchParams();
    if (t) next.set("trackId", t);
    if (w === "7d") next.set("window", "7d");
    location.hash = `#/leaderboard${next.toString() ? `?${next}` : ""}`;
  };
  $("#track-filter").addEventListener("change", apply);
  $("#window-filter").addEventListener("change", apply);
}

async function renderProgress() {
  setNav("progress");
  const data = await api("/api/me/progress");
  $("#my-points").textContent = `${data.user.total_points} pts`;
  app.innerHTML = `
    <div class="page-head">
      <div>
        <div class="kicker">Your ledger</div>
        <h1>${escapeHtml(data.user.name)}</h1>
        <p>${data.user.total_points} arena points · ${data.user.questions_mastered} questions mastered</p>
      </div>
    </div>
    <div class="grid">
      ${data.tracks
        .map((t) => {
          const pct = t.question_count ? Math.round((t.mastered_count / t.question_count) * 100) : 0;
          return `<article class="card track">
            <div class="track-icon">${ICONS[t.icon] || ICONS.path}</div>
            <h3>${escapeHtml(t.title)}</h3>
            <p>${t.mastered_count} / ${t.question_count} mastered · ${t.earned_points} / ${t.available_points} pts</p>
            <div class="bar"><span style="width:${pct}%"></span></div>
          </article>`;
        })
        .join("")}
    </div>
    <h2 style="margin:32px 0 12px">Recent attempts</h2>
    <div class="card" style="padding:8px 18px 18px">
      <table class="table">
        <thead><tr><th>When</th><th>Track</th><th>Score</th><th>Result</th></tr></thead>
        <tbody>
          ${
            data.attempts.length
              ? data.attempts
                  .map(
                    (a) => `<tr>
                      <td>${escapeHtml(a.finished_at)}</td>
                      <td>${escapeHtml(a.track_title)}</td>
                      <td>${a.score} / ${a.max_score}</td>
                      <td>${a.passed ? "Pass" : "Retry"}</td>
                    </tr>`
                  )
                  .join("")
              : `<tr><td colspan="4">No finished attempts yet.</td></tr>`
          }
        </tbody>
      </table>
    </div>
    <h2 style="margin:32px 0 12px">Points ledger</h2>
    <div class="card" style="padding:8px 18px 18px">
      <table class="table">
        <thead><tr><th>When</th><th>Reason</th><th>Track</th><th>Pts</th></tr></thead>
        <tbody>
          ${
            data.ledger.length
              ? data.ledger
                  .map(
                    (l) => `<tr>
                      <td>${escapeHtml(l.created_at)}</td>
                      <td>${escapeHtml(l.reason)}</td>
                      <td>${escapeHtml(l.track_title || "—")}</td>
                      <td>${l.points}</td>
                    </tr>`
                  )
                  .join("")
              : `<tr><td colspan="4">No points yet.</td></tr>`
          }
        </tbody>
      </table>
    </div>`;
}

async function renderAdmin() {
  setNav("admin");
  if (user.role !== "admin") {
    app.innerHTML = `<p>Admins only.</p>`;
    return;
  }
  const data = await api("/api/admin/questions");
  const people = await api("/api/admin/users");
  app.innerHTML = `
    <div class="page-head">
      <div>
        <div class="kicker">Question bank</div>
        <h1>Manage tracks</h1>
        <p>Add questions with points. The ledger still awards each question once per developer.</p>
      </div>
    </div>
    <div class="admin-grid">
      <form class="card" id="q-form" style="padding:22px">
        <h3>New question</h3>
        <label>Track</label>
        <select name="trackId" required>
          ${data.tracks.map((t) => `<option value="${t.id}">${escapeHtml(t.title)}</option>`).join("")}
        </select>
        <label>Question</label>
        <textarea name="text" required></textarea>
        <label>Type</label>
        <select name="type"><option value="single">Single</option><option value="multi">Multi</option></select>
        <label>Difficulty</label>
        <select name="difficulty">
          <option value="easy">Easy · 10</option>
          <option value="medium" selected>Medium · 15</option>
          <option value="hard">Hard · 25</option>
        </select>
        <label>Points</label>
        <input name="points" type="number" min="1" value="15" />
        <label>Explanation</label>
        <textarea name="explanation"></textarea>
        <label>Options (check the correct ones)</label>
        <div id="opt-box">
          ${[0, 1, 2, 3]
            .map(
              (i) => `<div class="option-row">
                <input name="opt-text-${i}" placeholder="Option ${i + 1}" />
                <label class="tiny"><input type="checkbox" name="opt-ok-${i}" /> correct</label>
              </div>`
            )
            .join("")}
        </div>
        <button class="btn full" type="submit">Save question</button>
        <div id="admin-msg" class="tiny"></div>
      </form>
      <div>
        <div class="card" style="padding:18px; margin-bottom:18px">
          <h3>Team</h3>
          <table class="table">
            ${people.users
              .map(
                (u) => `<tr><td>${escapeHtml(u.name)}</td><td>${escapeHtml(u.role)}</td><td>${u.total_points} pts</td></tr>`
              )
              .join("")}
          </table>
        </div>
        <div class="card" style="padding:18px; max-height: 520px; overflow:auto">
          <h3>Bank (${data.questions.length})</h3>
          ${data.questions
            .map(
              (q) => `<p class="tiny"><b>${escapeHtml(q.track_title)}</b> · ${q.points} pts<br>${escapeHtml(q.text)}</p>`
            )
            .join("")}
        </div>
      </div>
    </div>`;

  $("#q-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const difficulty = fd.get("difficulty");
    const defaultPts = difficulty === "easy" ? 10 : difficulty === "hard" ? 25 : 15;
    const options = [0, 1, 2, 3]
      .map((i) => ({
        text: String(fd.get(`opt-text-${i}`) || "").trim(),
        correct: fd.get(`opt-ok-${i}`) === "on"
      }))
      .filter((o) => o.text);
    try {
      await api("/api/admin/questions", {
        method: "POST",
        body: {
          trackId: Number(fd.get("trackId")),
          text: fd.get("text"),
          type: fd.get("type"),
          difficulty,
          points: Number(fd.get("points")) || defaultPts,
          explanation: fd.get("explanation"),
          options
        }
      });
      $("#admin-msg").textContent = "Saved.";
      renderAdmin();
    } catch (err) {
      $("#admin-msg").textContent = err.message;
    }
  });
}

window.addEventListener("hashchange", render);
await render();
