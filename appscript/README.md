# SFCC Skills Arena — Google Apps Script port

Everything in this folder is uploaded to a single Apps Script project. The
Node/Express build in the parent directory stays untouched; this is a parallel
deploy target.

## What's here

```
appscript/
├── appsscript.json        Manifest (scopes, webapp access, V8 runtime)
├── Code.gs                Server — routing, auth, Sheets-as-DB, seeding
├── Questions.gs           Embedded question bank (auto-generated)
├── Index.html             Single-file UI (landing + app shell, hash-routed)
├── .claspignore           Tells clasp which files NOT to upload
├── .clasp.json.example    Copy to .clasp.json and paste your scriptId
└── build_questions_gs.mjs Rebuilds Questions.gs from src/seed/questions.json
```

## How it maps to the original Node app

| Node                                  | Apps Script                                              |
| ------------------------------------- | -------------------------------------------------------- |
| Express routers under `/api/*`        | Single `api(route, payload)` in `Code.gs`, called via `google.script.run` |
| SQLite (`node:sqlite`)                | A Google Spreadsheet (one tab per table) autocreated on first run |
| bcrypt                                | PBKDF2(SHA-256, 100k) with a 16-byte salt                |
| HttpOnly cookie sessions              | Random token returned to the client; stored in `localStorage`; sent with every call |
| `src/seed/questions.json`             | Embedded as a string in `Questions.gs`                   |
| Three HTML pages + three JS modules   | Collapsed to `Index.html` (CSS + JS inlined)             |

The spreadsheet is created automatically the first time `doGet` or `api` runs.
Its ID is saved in `ScriptProperties` under `SHEET_ID`; subsequent runs reuse
it. To reset, delete the sheet from Drive and clear that property.

## One-time local setup

```bash
# 1. Install clasp
npm install -g @google/clasp@2.4.2

# 2. Enable the Apps Script API for your Google account (once per account)
#    https://script.google.com/home/usersettings  →  turn it ON

# 3. Sign in
clasp login

# 4. Create the Apps Script project (OR clone an existing one)
cd appscript
clasp create --type webapp --title "SFCC Skills Arena" --rootDir .
#   (creates .clasp.json for you)
#
# OR, if the project already exists:
#   cp .clasp.json.example .clasp.json
#   # edit the scriptId value from script.google.com → Project Settings

# 5. Push & deploy
clasp push
clasp deploy -d "first deployment"
clasp deployments           # copy the webapp URL
```

Open the URL → sign in with `admin@arena.local` / `ChangeMe!admin`.

### Regenerating Questions.gs locally

If you edit `src/seed/questions.json`, rebuild before pushing:

```bash
node appscript/build_questions_gs.mjs
clasp push --rootDir appscript   # or: cd appscript && clasp push
```

CI does this automatically.

## Automated deployment on PR merge

The workflow at `.github/workflows/deploy-appscript.yml` runs on every push
to `main` that touches `appscript/**` or `src/seed/questions.json`.

### GitHub Secrets to configure

Repository → **Settings → Secrets and variables → Actions → New repository secret**:

| Secret                       | What to put                                                                                     |
| ---------------------------- | ----------------------------------------------------------------------------------------------- |
| `CLASPRC_JSON`               | The **entire contents** of your local `~/.clasprc.json` after `clasp login` (OAuth refresh token). Treat like a password. |
| `APPS_SCRIPT_ID`             | The `scriptId` from your `.clasp.json` (same as the script URL `…/d/<ID>/edit`).                |
| `APPS_SCRIPT_DEPLOYMENT_ID`  | *(Optional but recommended.)* The deployment ID from `clasp deployments` — reusing it keeps the webapp URL **stable** across deploys. Omit to create a new deployment (and a new URL) each run. |

Get the deployment ID like this:

```bash
cd appscript
clasp deployments
# AKfyc...  @1  — ci abc1234     ← that AKfyc… is APPS_SCRIPT_DEPLOYMENT_ID
```

### What the workflow does

1. Checks out the repo.
2. Installs clasp.
3. Rebuilds `Questions.gs` from `src/seed/questions.json` so the question bank
   on prod always matches the one in git.
4. Writes `~/.clasprc.json` from the `CLASPRC_JSON` secret.
5. Writes `appscript/.clasp.json` from the `APPS_SCRIPT_ID` secret.
6. `clasp push -f` uploads every `.gs` / `.html` / `appsscript.json` in
   `appscript/`.
7. `clasp deploy -i <DEPLOYMENT_ID>` updates the stable webapp URL (or creates
   a fresh one if no deployment ID is set).

### Branch/PR workflow

- Open a PR → no deploy (workflow only runs on `push` to `main`).
- Merge the PR → push to `main` fires the workflow → prod updates in ~30 s.

If you also want **PR preview deployments** (separate URL per PR), extend the
workflow with a `pull_request` trigger that calls `clasp deploy` without `-i`;
each run returns a new URL. Not wired in by default to keep the mental model
simple.

### Rotating the refresh token

Google occasionally expires the refresh token in `~/.clasprc.json`. Symptoms
in CI: `clasp push` fails with "User has not enabled the Apps Script API" or
"Request had invalid authentication credentials." Fix:

```bash
clasp login                          # re-does OAuth locally
cat ~/.clasprc.json | pbcopy         # (macOS) copy to clipboard
# paste into the CLASPRC_JSON secret on GitHub, overwriting the old value
```

## Known trade-offs (vs. the Node version)

- **No real transactions.** Writes are a series of row appends/updates; a
  failure mid-operation can leave orphan rows. For this scoreboard that's
  acceptable — the ledger is append-only and the recompute is idempotent.
- **No per-request isolation.** Apps Script serializes executions per user; if
  two players finish at the exact same instant, one waits. Fine at team scale.
- **Point totals are computed by scanning the ledger sheet on every request.**
  OK up to a few thousand rows. If the ledger grows, cache totals in
  `ScriptProperties` or `CacheService`.
- **Quota.** Apps Script webapps are subject to Google's daily quotas (script
  runtime minutes, UrlFetch calls). This app uses neither heavily.
