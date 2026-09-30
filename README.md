# MissionSync

> One live, ranked operational picture for volunteer emergency-response drills — built for the net control lead who is currently juggling a radio, a notebook, and a whiteboard.

[![Live Demo](https://img.shields.io/badge/Live-Demo-blue?style=for-the-badge)](LIVE_DEMO_URL)
[![Repo](https://img.shields.io/badge/GitHub-Repo-black?style=for-the-badge&logo=github)](REPO_URL)

<!-- ⚠️ BEFORE SUBMITTING: replace LIVE_DEMO_URL and REPO_URL above with your real URLs. Judges deduct for placeholders. -->

---

## Preview

| Desktop | Mobile |
|---|---|
| ![desktop](./screenshots/desktop.png) | ![mobile](./screenshots/mobile.png) |

<em>Light mode:</em>

| Desktop (light) | — |
|---|---|
| ![desktop light](./screenshots/desktop-light.png) | |

---

## What It Does

During a 3-hour drill, the net control lead of a campus CERT or amateur-radio team transcribes every radio call onto a paper log and decides in their head which incident matters most. MissionSync turns typed field reports into a structured, ranked operational picture: reports are parsed into incidents, duplicates are merged into one entry, every incident is scored on a transparent 0–100 urgency scale (four auditable components → P1–P4 tier), and available units are matched to the top incidents with capability-aware deployments and ETAs. The whole thing updates live — units move toward their assignments, unaddressed incidents get worse, and the ranking legitimately re-orders itself as the drill evolves. A judge can open the site, type a mid-drill report, and watch the board re-rank without touching a key or a config file.

---

## Features

- **Ranked incident feed** — every open incident scored on transparent 0–100 urgency (severity / population / spread / time-criticality, weighted composite in plain code); click a card to see the auditable component breakdown and rationale.
- **Live incident map** — priority-colored markers sized by urgency (P1/P2 pulse), responder units shown moving toward their assignments, with a legend and a one-tap clear-selection control.
- **Free-text report intake with duplicate merging** — type a field report mid-drill (or pick a sample); the pipeline parses it, merges it into an existing incident when it's the same type within ~1.5 km, and refreshes ranking, deployments, and recommendations in place.
- **Command recommendations** — imperative headline orders, action bullets, and terrain/weather-aware warnings for the top four incidents, each with deployment chips (unit, role, ETA).
- **Resource board & live event log** — all 12 units with status (available / en route / on scene), current assignment and ETA, plus a timestamped audit trail of every parse → merge → rank → deploy step for after-action review.
- **Dark & light mode** with skeleton loaders, designed empty states, and graceful error handling — the board never blanks, crashes, or shows raw errors when something goes wrong.

---

## Planning Docs

- [PRD](./docs/PRD.md)
- [Architecture](./docs/ARCHITECTURE.md)
- [Roadmap](./docs/ROADMAP.md)

**Deviations from the plan:** The Roadmap's Kenshi milestone committed to the full three-pane board with the report → merge → re-rank → recommend loop running in the browser via a mock state layer — that's exactly what shipped. Three intentional changes: (1) the browser engine uses the prototype's deterministic fallback twins (the rule-based scoring/parsing/matching path) rather than porting the LLM calls — Kenshi is frontend-only, so the LLM moves to Samurai's server-side pipeline unchanged; (2) the xBD Kaggle dataset pull is replaced by a fixed, seeded cohort of incident scenarios with hidden ground-truth urgencies derived from the same damage-grade conversion — the Spearman ρ metric in the header is still computed against hidden ground truth, just from the offline cohort; (3) incidents are pinned to the six fictional sectors deterministically instead of cyclic sector assignment from dataset rows. Nothing was dropped: all seven PRD MVP features are present except multi-viewer WebSocket sync, which the Roadmap explicitly deferred to Samurai because it needs server state.

---

## Tech Stack

| Technology | Purpose |
|---|---|
| React 18 + TypeScript | UI framework, typed end to end |
| Vite | Build tool & dev server |
| Vanilla CSS (custom properties) | Design system: themes, tokens, responsive layout |
| Leaflet + react-leaflet | Free OpenStreetMap incident map (no API key) |
| Custom TS engine (`src/engine/`) | Deterministic agent pipeline: parse → merge → score → match → recommend |
| Mulberry32 seeded RNG | Reproducible drill scenarios |
| Vercel | Deployment |

---

## Run Locally

```bash
git clone REPO_URL
cd MissionSync
cd frontend
npm install
cp .env.example .env.local   # optional — no secrets required at Kenshi
npm run dev
```

Open http://localhost:5173. The drill starts immediately: five seeded incidents, units deploying on a 6-second tick, wave reports arriving mid-exercise.

**Try the core loop:** type a report like *"fire spreading near the University lab block, three students trapped"* into the intake box and inject it — watch it parse, merge or create an incident, and the whole board re-rank.

### Environment Variables

| Variable | Description |
|---|---|
| `VITE_APP_ENV` | Optional build tag. Empty at Kenshi — no runtime secrets needed; the engine runs fully client-side. |

---

## What I Learned

The hardest part was porting the backend's agent pipeline to the browser without it becoming fake: keeping the merge guard (same type within 1.5 km), the per-incident assignment caps, and the hidden-ground-truth Spearman ρ metric all genuinely computing, then proving it by injecting the follow-up collapse report and watching it merge instead of duplicate. The design decision I'm most proud of is the auditable breakdown: click any incident and animated bars show exactly how severity, population, spread, and time-criticality produced its urgency — the transparency that made the Level-1 ranking trustworthy, now *felt* instead of documented. I also learned that "loading states" matter most where judges land first: skeletons render during the boot cycle so the first paint is never a blank flash, and the theme restores before first paint to avoid a light-mode flash in dark mode. Finally, sizing markers by urgency and pulsing only P1/P2 taught me that the most purposeful animations are the ones that encode information — the eye is drawn to exactly the incident that needs it.

---

*Submitted to Journey to Mastery — Level 2: Kenshi*
