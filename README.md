# MissionSync

> One live, ranked operational picture for volunteer emergency-response drills — built for the net control lead who is currently juggling a radio, a notebook, and a whiteboard.

[![Live Demo](https://img.shields.io/badge/Live-Demo-blue?style=for-the-badge)](LIVE_DEMO_URL)
[![Repo](https://img.shields.io/badge/GitHub-Repo-black?style=for-the-badge&logo=github)](https://github.com/sahinurrahman-debug/MissionSync)

<!-- ⚠️ BEFORE SUBMITTING: replace LIVE_DEMO_URL above with your Render frontend URL (https://<your-static-site>.onrender.com). Judges deduct for placeholders. -->

---

## Preview

**Tactical Night** (default) on a 1600×900 tactical monitor:

![Desktop, dark](./screenshots/desktop.png)

| Day mode (1366×768 field laptop) | Phone (bottom-tab layout) |
|---|---|
| ![Desktop, light](./screenshots/desktop-light.png) | ![Mobile](./screenshots/mobile.png) |

---

## What It Does

During a 3-hour drill, the net control lead of a campus CERT or amateur-radio team transcribes every radio call onto a paper log and decides in their head which incident matters most. MissionSync turns typed field reports into a structured, ranked operational picture: reports are parsed into incidents, duplicates are merged into one entry, every incident is scored on a transparent 0–100 urgency scale (four auditable components → P1–P4 tier), and available units are matched to incidents with capability-aware deployments and ETAs. It updates live — units drive to their assignments, work the scene, contain it, and return to base; unaddressed casualties get worse; the ranking re-orders itself as the drill evolves. A judge can open the site, type a mid-drill report, and watch the board re-rank.

---

## Two ways it runs

| | **Full stack** (the real thing) | **Demo engine** (static hosting) |
|---|---|---|
| Agents | 5 LLM agents on **Groq** (`gpt-oss`), JSON mode, validated by code | Rule-based twins of the same agents, in the browser |
| Scenarios | **Real xBD satellite damage surveys** (Kaggle), scored against hidden ground truth | 9 hand-authored, internally consistent incidents |
| Push | FastAPI + WebSocket, every pipeline stage streamed | In-process |
| Header badge | `AI · openai/gpt-oss-20b` | `DEMO ENGINE` (plus a banner) |

The app is honest about which one you're looking at. The header badge says **AI** (LLM running), **RULES · LLM off** (no key or provider failing), **AI QUOTA HIT** (Groq daily token quota spent — rule-based agents cover and a banner says when AI resumes), or **DEMO ENGINE**. Each incident card also carries a provenance tag (`AI` / `rules`).

---

## Features

- **Ranked incident feed** — transparent 0–100 urgency (severity / population / spread / time-criticality, weighted composite computed in plain code); click a card for the component breakdown and rationale.
- **Live incident map** — priority-colored markers sized by urgency (P1/P2 pulse), every responder unit drawn (idle at base, en route, on scene, returning). A dashed ring marks a report that named no place.
- **Free-text report intake** — type what is happening and where. The place words ("University lab block", "Industrial Park gate 3", "Riverfront levee") put it on the map; the same type within ~1.5 km merges into the existing incident; text that isn't an emergency is rejected instead of dispatching a unit.
- **Command recommendations** — imperative headline orders, action bullets, weather-aware warnings for the top four incidents, with the units *actually deployed* and their ETAs.
- **Incident lifecycle** — en route → on scene → worked → contained → units return to base and become available again. ↺ restarts the drill.
- **Resource board & event log** — all 12 units with status/assignment/ETA, plus a timestamped audit trail of every parse → merge → rank → deploy step.
- **After-action record** — with a database attached, every drill's audit trail and submitted reports are stored; ⬇ in the header downloads the CSV (`/api/drills/{id}/export.csv`).
- **Two engineered themes** (Tactical Night / high-contrast Day), skeletons sized to the real components, a radar empty state, an offline banner, and per-panel error boundaries — the board never blanks or shows a raw error.

---

## Tech Stack

| Technology | Purpose |
|---|---|
| React 18 + TypeScript + Vite | Dashboard |
| Tailwind CSS 3 | Design tokens as CSS variables → two themes, no per-theme class names |
| Lucide icons, Framer Motion | Icon set; layout animation when incidents re-rank |
| Leaflet + react-leaflet | Incident map on OpenStreetMap tiles (no API key), custom SVG pins |
| FastAPI + uvicorn + WebSocket | Backend, live push |
| Groq (`openai/gpt-oss-20b`, falling back to `-120b`) | LLM for the five agents |
| Pydantic | Typed models, and the validation gate for LLM output |
| kagglehub + xBD | Real scenario data |
| PostgreSQL (SQLAlchemy) | Optional: drill history, audit trail, submitted reports, CSV export |
| Vitest, pytest | 53 frontend + 91 backend tests, plus a WCAG contrast audit |

---

## Design system

Direction: *Tactical ops center meets Linear/Vercel* — utilitarian, high-contrast, calm under pressure, dense. The palette and component language were explored in Canva first ([design-system board](https://www.canva.com/d/dZFerA8Z6QapTVw)) and then implemented as tokens in [`frontend/src/index.css`](./frontend/src/index.css).

| Token | Tactical Night | Day | Used for |
|---|---|---|---|
| Surface / panel / raised | `#0E1113` / `#151A1D` / `#1C2226` | `#ECF0F1` / `#FFFFFF` / `#F3F6F7` | page, cards, hover |
| Text / secondary | `#EEF2F3` / `#93A1A8` | `#0E1417` / `#3F4C53` | body, telemetry |
| Accent | `#2DD4BF` teal | `#0D6862` deep teal | focus, primary action, links |
| Urgency P1 → P4 | `#EF4444` · `#F59E0B` · `#EAB308` · `#64748B` | darker equivalents | fixed across themes — they carry life-safety meaning |
| Unit status | `#10B981` available · `#60A5FA` en route · `#A78BFA` on scene · `#64748B` returning | darker equivalents | fleet board, map |

- **Type scale:** Inter for UI, JetBrains Mono (tabular numerals) for metrics, timers and logs. Titles, order headlines, checklist items, unit call-signs and the intake box are **16 px**; secondary text 14 px; only uppercase micro-labels and telemetry chips drop to 12 px. (The brief asked for high density; the rubric asks for ≥ 16 px typography — primary content is 16 px, and density comes from layout, not smaller type.)
- **Colour is never the only signal:** every urgency shows tier text *and* a numeric score (`#1 · P1 CRITICAL · 94/100`); every unit status is a labelled chip.
- **Contrast:** `npm run audit:contrast` checks all 48 text/background pairs in both themes against WCAG 4.5:1 — 0 failures.
- **Layout:** full-viewport, zero body scroll. 55/45 command grid on ≥ 1024 px (map + ranked feed | orders + intake + fleet/log tabs); on tablets and phones a thumb-reachable bottom tab bar (Map · Incidents · Orders · Report · Units) with a P1/P2 badge. Verified at 375, 768, 1366 and 1920 px with no horizontal overflow.
- **Motion (purposeful only):** pulsing rings on P1/P2 pins, spring layout animation when the ranking changes, a glowing active stage in the five-step pipeline stepper, animated score bars. All of it honours `prefers-reduced-motion`.

---

## Level 1 alignment & scope drift

Kenshi is judged on the frontend, so the core loop (report → merge → re-rank → recommend) runs fully in the browser via the demo engine, as the Roadmap's Milestone 1 committed. Deviations from the Level 1 plan, stated plainly:

1. **Scope added beyond Kenshi:** a real FastAPI backend with LLM agents, real xBD data, WebSocket push, and optional Postgres (Roadmap Milestone 2 material). It is optional — the deployed frontend works on its own — but it is in the repo and wired.
2. **Deferred, as planned:** auth, multi-org roles, human confirm/override of assignments, restoring a live drill after a restart (all Samurai).
3. **Changed from the Level 1 sketch:** the xBD Kaggle pull is real in the full stack (the Roadmap deferred it to Samurai); the demo engine uses a hand-authored scenario with damage grades on the same 0→10 … 3→90 scale.
4. **Urgency tiers** stay as the Level 1 docs define them (P1 ≥ 75, P2 ≥ 55, P3 ≥ 35, else P4), so the ranking you see matches the documented methodology.

---

## Run locally (full stack)

You need Python 3.11+ and Node 18+.

```bash
# 1. Backend  (terminal 1)
cd backend
python -m venv .venv
.venv/Scripts/python -m pip install -r requirements.txt     # macOS/Linux: .venv/bin/python
cp .env.example .env                                         # then fill in GROQ_API_KEY (+ KAGGLE_API_TOKEN, optional)
.venv/Scripts/python -m uvicorn missionsync.main:app --port 8000

# 2. Frontend (terminal 2)
cd frontend
npm install
npm run dev                                                  # http://localhost:5173
```

`npm run dev` proxies `/api` and `/ws` to the backend on `:8000`, so there is nothing else to configure. Open http://localhost:5173 — the header should read `LIVE` and `AI · openai/gpt-oss-20b`.

**Try the core loop:** type *"fire spreading near the University lab block, three students trapped"* and inject it. It parses, lands on the University sector, is scored and ranked, and units are dispatched — watch the pipeline chip step through the five agents.

**No backend?** Just run `npm run dev` on its own: the app detects there is no server and runs the in-browser demo engine, badged `DEMO ENGINE`. (`?engine=local` forces it.)

### Environment variables

| Variable | Where | Description |
|---|---|---|
| `GROQ_API_KEY` | backend | Groq key. Without it the agents run rule-based (badge: `RULES · LLM off`). |
| `GROQ_MODEL` / `GROQ_FALLBACK_MODEL` | backend | Optional. Defaults `openai/gpt-oss-20b` / `openai/gpt-oss-120b`. When one model's daily quota is spent the other is used automatically. |
| `KAGGLE_API_TOKEN` | backend | Optional. Downloads real xBD labels live. Without it the bundled snapshot of the same real records is used. |
| `XBD_FILE_PATH` | backend | Optional. Load one specific file from the Kaggle dataset instead. |
| `DATABASE_URL` | backend | Optional Postgres URL (Render injects it). Enables drill history + CSV export; without it everything runs in memory. |
| `CORS_ORIGINS` | backend | Comma-separated allowed origins. Defaults to the local dev origins; **set it to your frontend URL in production.** |
| `VITE_API_URL` | frontend | Backend base URL for production builds. Empty in dev. |
| `BACKEND_URL` | frontend dev | Where the dev proxy points (default `http://127.0.0.1:8000`). |

### Groq free-tier quota — read this

The free tier allows roughly **200,000 tokens per day per model**. MissionSync is built for that budget: terrain/risk results are cached until their inputs materially change, logistics is consulted only when an incident needs units, command is re-drafted only when the picture changes, and idle ticks cost **zero** calls. A full boot is about five agent calls. If both models are spent the badge turns to `AI QUOTA HIT`, a banner says when it resumes, and the rule-based twins keep the board running. For live demos on the free tier, restart the drill sparingly, or upgrade to Groq's Dev tier.

### Tests

```bash
cd backend  && .venv/Scripts/python -m pip install -r requirements-dev.txt && .venv/Scripts/python -m pytest
cd frontend && npm test && npm run typecheck && npm run audit:contrast
```

Backend tests never touch the network. A fake Groq client proves the whole pipeline runs in **pure LLM mode with zero rule-based fallbacks**, that bad LLM output (invalid types, unavailable or incapable units, out-of-range scores) never reaches world state, and that quota exhaustion degrades visibly.

---

## The data

Scenarios are **real xBD** building-damage annotations (`rayanhossain239/damageactu-xbd-full`, Gupta et al. 2019, CC BY-NC-SA 4.0) — 20 label files spanning volcano, flood, hurricane-wind and wildfire events. Each file becomes one incident:

- The agents read an **observable scene report** built from the per-building counts (*"Floodwater damage survey: 110 structures assessed — 74 severely damaged, 36 lightly damaged. Roughly 258 people in the affected footprint, 37 injured."*). Grade labels are never in the text.
- The **hidden ground truth** is the mean Joint Damage Scale urgency over the file's classified buildings (no-damage 10, minor 40, major 70, destroyed 90), used only to compute the Spearman ρ shown in the header. Typed reports have no ground truth, so they can never move it.
- xBD is mostly "no damage"; the sampler deals across hazard types and keeps at most four quiet scenes. `scripts/build_xbd_snapshot.py` rebuilds the bundled real-data snapshot (`backend/missionsync/data/xbd_seeds.json`) from Kaggle.

Load order: live Kaggle → bundled real snapshot → synthetic cohort (last resort, header notes it).

---

## Deploy on Render (database + API + frontend)

The repo ships a Blueprint, [`render.yaml`](./render.yaml), that creates all three pieces:

| Render service | What | Notes |
|---|---|---|
| `missionsync-db` | Postgres | Audit trail, reports, drill history. Free plan expires after 30 days. |
| `missionsync-api` | Python web service (`backend/`) | `uvicorn missionsync.main:app`, health check `/api/health`, WebSocket included. Free plan sleeps when idle (~1 min cold start). |
| `missionsync-web` | Static site (`frontend/`) | `npm ci && npm run build` → `dist`. |

1. Push the repo to GitHub (it already is: `sahinurrahman-debug/MissionSync`).
2. Render dashboard → **New → Blueprint** → select the repo → **Apply**.
3. When prompted, set the secrets: `GROQ_API_KEY` (and optionally `KAGGLE_API_TOKEN`). Leave `CORS_ORIGINS` and `VITE_API_URL` for now (put any placeholder, e.g. `https://x.onrender.com`).
4. Wait for the first deploy, then copy the two public URLs from the dashboard (e.g. `https://missionsync-api.onrender.com` and `https://missionsync-web.onrender.com`).
5. Set **`CORS_ORIGINS`** on `missionsync-api` = the *frontend* URL, and **`VITE_API_URL`** on `missionsync-web` = the *API* URL (no trailing slash). Then **Manual Deploy → Clear build cache & deploy** the frontend (Vite bakes `VITE_API_URL` in at build time) and redeploy the API.
6. Open the frontend URL. The header should read `LIVE` and `AI · openai/gpt-oss-20b`; `GET <api-url>/api/health` should show `"database": "postgresql"`.

State note: the live drill is in memory (one instance, one shared drill); the database is an append-only record for review. A sleeping free instance restarts the drill on wake-up — hit ↺ or wait for the scripted waves.

## Planning Docs

- [PRD](./docs/PRD.md) · [Architecture](./docs/ARCHITECTURE.md) · [Requirements](./docs/REQUIREMENTS.md) · [API spec](./docs/API_SPEC.md) · [Roadmap](./docs/ROADMAP.md)
- [Sketch](./docs/SKETCH.md) — live board: <https://excalidraw.com/#room=dc45f75888800794e0e6,kvfdLtfMVJnRXNi0TIiYJw> · static backup [`docs/sketch.png`](./docs/sketch.png)
- [Legacy prototype notes](./docs/LEGACY_MISSIONSYNC_NOTES.md)

**Scope notes.** Implemented: report intake, parse → merge → risk → logistics → command pipeline, live push, incident lifecycle, error envelope + rate limit, drill restart, audit endpoint. Postgres history + CSV export are in (optional). **Not yet (Samurai/Shogun):** Firebase auth and roles, restoring a live drill from the database after a restart, human commit controls (confirm/override an assignment), multi-tenant isolation. Until then the backend serves a single shared in-memory drill and `/api/report` is unauthenticated (rate-limited and length-capped).

---

## What I Learned

The hardest part was keeping "agents propose, code decides" true under a real LLM: every model output is validated and clamped before it can touch state — invented incident types are dropped, scores are clamped to 0–100, and an assignment must name an available, capable unit inside the crew cap, with a deterministic guard that no P1/P2 is left uncovered. The second lesson was that a free-tier token budget is an architectural constraint, not a footnote: caching by *material* change (not by time) took idle ticks from ~12 model calls each to none. The third was honesty in the UI — a badge that says which engine is running, a banner when the quota is spent, and a metric (ρ against real xBD ground truth) that typed reports cannot inflate.

---

*Submitted to Journey to Mastery — Level 2: Kenshi (frontend) on the Level 1 backend*
