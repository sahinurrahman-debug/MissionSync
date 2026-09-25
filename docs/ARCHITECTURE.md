# Architecture — MissionSync

*Planned system architecture · Journey to Mastery — Level 1 (Ronin)*

> Principle: **agents propose, deterministic code decides.** LLM components parse and draft; scoring, tiering, ranking, and assignment caps are plain code so identical inputs produce identical rankings. A judge (or net control) can audit any ranking.

---

## 1. System diagram

```
                          DRILL SESSION — SHARED LIVE PICTURE
 ┌──────────────────────────────────────────────────────────────────────────────┐
 │                                                                              │
 │  ┌──────────────┐   typed/parsed     ┌──────────────┐  ranked incidents      │
 │  │ BROWSER(S)   │   reports (REST)   │  FASTAPI      │  ┌────────────────┐   │
 │  │ React+Vite   │ ─────────────────► │  backend      │  │ AGENT PIPELINE │   │
 │  │ Leaflet map  │                    │  (uvicorn)    │  │ (per cycle)    │   │
 │  │ ranked feed  │ ◄───────────────── │               │  └────────────────┘   │
 │  └──────────────┘   WorldSnapshot    │  Orchestrator │                       │
 │        ▲         (WebSocket push)    │  owns state   │                       │
 │        │                             └──────┬───────┘                       │
 │        │ every screen shows                 │                               │
 │        │ the same picture                   ▼                               │
 │  ┌─────┴────────┐                    ┌──────────────┐   ┌──────────────────┐ │
 │  │ Net control  │                    │ Surveillance │──►│ Terrain/Weather  │ │
 │  │ types report │                    │ parse+merge  │   │ context scoring  │ │
 │  └──────────────┘                    └──────────────┘   └────────┬─────────┘ │
 │  ┌──────────────┐                           ▲                    ▼           │
 │  │ Responders   │            ┌──────────────┴───…  ┌─────────────────────┐   │
 │  │ view ranking │            │  Groq LLM (JSON     │ │ Risk scoring: 4     │   │
 │  │ + assignment │            │  mode) + rule-based │ │ components 0–100 →  │   │
 │  └──────────────┘            │  fallback twins     │ │ composite (determin.│   │
 │                              └─────────────────────┘ │ code) → P1–P4 tier  │   │
 │                                                      └──────────┬──────────┘   │
 │                                                                 ▼              │
 │                              ┌──────────────┐        ┌─────────────────────┐   │
 │                              │ Logistics    │◄───────│ Ranked feed + free  │   │
 │                              │ unit↔incident│        │ units + capability  │   │
 │                              │ matching     │        │ matrix (code)       │   │
 │                              └──────┬───────┘        └─────────────────────┘   │
 │                                     ▼                                          │
 │                              ┌──────────────┐                                  │
 │                              │ Command      │  headline orders, action         │
 │                              │ drafts recs  │  bullets, warnings               │
 │                              └──────────────┘                                  │
 └──────────────────────────────────────────────────────────────────────────────┘
                                        │
                                        ▼ (Samurai+)
                              ┌──────────────────┐
                              │ PostgreSQL       │  users, orgs, drill sessions,
                              │ (persistent)     │  incidents, resources, reports,
                              └──────────────────┘  assignments, audit events
```

**Deployment shape (Shogun):** static React build on Netlify/Vercel → FastAPI on Railway → managed Postgres (Railway add-on) → Groq API outbound. One region, one deploy pipeline, no exotic infrastructure.

---

## 2. Planned tech stack (and why)

| Layer | Choice | Why (one sentence) |
|---|---|---|
| **Frontend framework** | React 18 + TypeScript + Vite | Already proven in this repo (the dashboard exists), and the drill UI is a live-state problem — component re-render on WebSocket push is exactly React's model. |
| **Mapping** | Leaflet + react-leaflet | Free OpenStreetMap tiles, no API key, tiny bundle — right size for "markers on a campus map" without paying for Mapbox. |
| **Backend framework** | FastAPI (Python) + uvicorn | First-class async + native WebSocket support for push updates, Pydantic models give typed API contracts shared with the frontend, and the LLM/agent ecosystem is Python-native. |
| **Realtime** | Single WebSocket (`/ws`) pushing full `WorldSnapshot`s | Drill screens must show identical state within seconds; snapshot-on-cycle is simple, debuggable, and good enough at ≤ 50 concurrent viewers — no CRDT/OT complexity. |
| **Database** | PostgreSQL | Incident/assignment state is relational (orgs → drills → incidents → assignments), and PostgreSQL's JSONB stores the flexible LLM-extracted incident fields without schema gymnastics. |
| **ORM** | SQLAlchemy 2.0 (async) | Standard, typed, async-native access to Postgres; avoids inventing a data layer. |
| **Auth provider** | Firebase Authentication (email/password + Google) | Free tier, managed email verification and password reset (the boring parts I shouldn't hand-roll), and Org membership stays in Postgres keyed by Firebase UID. |
| **LLM provider** | Groq (JSON-mode) + deterministic fallback twins | Sub-second JSON-structured completions keep the pipeline within cycle budget, and the fallback twins guarantee the board works even if the LLM is down mid-drill. |
| **Hosting** | Railway (API + Postgres), Netlify or Vercel (frontend) | Cheapest path to HTTPS + managed Postgres with `git push` deploys; both have free/low tiers sufficient for 25 users. |
| **Simulator** | In-repo Python module (`simulator.py`) + xBD dataset via kagglehub (`xbd.py`) | Incident scenarios come from real damage-assessment records (`rayanhossain239/damageactu-xbd-full`), so hidden ground-truth urgency is derived from actual damage grades; an offline fallback cohort keeps every demo alive without Kaggle credentials. |

---

## 3. Data flow — one report's journey

```
 1. Responder types a report in the dashboard (or net control pastes a radio call — simulator incidents are seeded from the xBD Kaggle dataset)
      │  POST /api/drills/{drill_id}/reports  { text, lat?, lon? }  (JWT)
      ▼
 2. FastAPI validates JWT → resolves org + active drill session → persists RawReport
      ▼
 3. Orchestrator enqueues the signal into the current pipeline cycle
      ▼
 4. SURVEILLANCE (LLM, JSON mode): parse text → structured incident fields
      (type, title, zone, population, injuries, confidence)
      new-vs-merge decision → verified in code by a geospatial guard
      (same type within ~1.5 km ⇒ merge; explicit ID link also accepted)
      ▼
 5. TERRAIN/WEATHER agent (LLM + static zone layers): access difficulty,
      escalation risk, hazards for the incident's zone
      ▼
 6. RISK SCORING: LLM proposes four 0–100 components; the weighted composite
      urgency = .35·severity + .25·population + .20·spread + .20·time
      and the P1–P4 tier are computed in code (deterministic, auditable)
      ▼
 7. LOGISTICS agent: match ranked incidents ↔ free units honoring capability
      matrix + one-unit-one-incident; ETAs = haversine ÷ unit speed; caps in code
      ▼
 8. COMMAND agent: headline order + action bullets + warnings for top incidents
      ▼
 9. Orchestrator writes results (Incident, RiskScore, Assignment, CommandRec,
      AuditEvent) and broadcasts a fresh WorldSnapshot over /ws
      ▼
10. Every connected dashboard re-renders: map markers, ranked feed, unit states,
      recommendation cards — within seconds of step 1, no refresh
```

**Read path:** all dashboard data arrives via the `/ws` snapshot push (with an initial `GET /api/snapshot` fallback on connect). No client polling.

**Failure path:** if a Groq call fails or times out (25 s cap, one retry, stronger-model repair pass), the rule-based twin for that agent produces the step's output, the event log records the degraded mode, and the cycle completes. A drill never stalls waiting on an LLM.

---

## 4. Key entities (rough data model)

Nouns the app cares about and how they relate — full schema lands at Samurai.

```
Org          1 ─── * Member        (an org = a CERT club / radio team)
Member       * ─── 1 User         (auth identity via Firebase UID)
Org          1 ─── * DrillSession  (one exercise: start/end, status, roster)
DrillSession 1 ─── * Resource      (units fielded in THIS drill)
DrillSession 1 ─── * Incident      (everything that happens in this drill)
User         1 ─── * RawReport     (who submitted which free-text report)
RawReport    * ─── 1 Incident      (a report parses into; duplicates MERGE —
                                     multiple reports may point at one incident)
Incident     1 ─── 1 RiskScore     (4 components + composite + tier + rationale)
Incident     1 ─── * Assignment    (unit ↔ incident, with role, ETA, status)
Resource     1 ─── * Assignment
DrillSession 1 ─── * AuditEvent    (timestamped pipeline trail for after-action)
TerrainCell / WeatherCell          (static zone layers keyed by zone, not FKs)
```

Notes:

- **Incident** carries type, title, description, lat/lon, zone, status (new → triaged → units en route → on scene → contained → closed), affected population, injuries, confidence.
- **Resource** carries type (fire unit, ambulance, rescue, swift-water, engineering, drone, hazmat), personnel count, position, speed, status, current assignment.
- **RiskScore** is deliberately embedded per incident rather than versioned separately at MVP; its `rationale` field is what makes rankings auditable.
- LLM-extracted free-form fields (e.g. `description` fragments from merged reports) live in a JSONB column so schema doesn't fight prose.

---

*Roadmap of what ships when: [ROADMAP.md](./ROADMAP.md) · Endpoints and error contract: [API_SPEC.md](./API_SPEC.md) · Commitments and constraints: [REQUIREMENTS.md](./REQUIREMENTS.md)*
