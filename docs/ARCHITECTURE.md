# Architecture — MissionSync

*System architecture · written at Level 1 (Ronin), updated at Level 3 (Samurai) — the first section is what is built today; §1–4 are the original plan with notes on what changed*

> Principle: **agents propose, deterministic code decides.** LLM components parse and draft; scoring, tiering, ranking, and assignment caps are plain code so identical inputs produce identical rankings. A judge (or net control) can audit any ranking.

---

## 0. As built at Level 3 (Samurai)

```
 Browser (React + Vite, Leaflet map)
   │  one origin — same host serves the page, the API and the WebSocket
   ▼
 FastAPI service  (Docker, Render)  ──────────────►  Neon PostgreSQL
   ├─ /                       the built dashboard (SPA fallback)              users · sessions · drills
   ├─ /api/auth/*             sign up / in / out, session cookie (httpOnly)     audit_events · reports · kv
   ├─ /api/drills[/{id}]      CRUD of YOUR drills                               (Alembic migrations)
   ├─ /api/drills/{id}/...    run a drill: report, approve, reject, dispatch…
   ├─ /ws/drills/{id}         live snapshots of that one drill
   └─ DrillManager ── one Orchestrator + WebSocket hub PER OPEN DRILL
                          └─ 5 agents (Groq LLM, rule-based fallbacks) ──► Groq API
```

**Data flow in three sentences.** The browser loads the app, asks `/api/auth/me` who it is (the session cookie is verified against the `sessions` table on every request), and lists the signed-in user's drills. Opening a drill makes the `DrillManager` restore that drill's saved world state from the database (or boot a fresh scenario), start its agent loop, and attach a WebSocket hub; every action a person takes (a report, an approval) goes over REST, is checked against the owner in SQL, mutates only that drill's orchestrator, and the resulting snapshot is pushed to that drill's viewers. State is saved back to the `drills` row after each cycle, so a restart or a sleeping free-tier instance resumes where it left off, and idle drills are saved and unloaded to keep memory small.

**Why one origin?** The session cookie is `httpOnly` + `SameSite=Lax`. Two different `*.onrender.com` hosts count as *cross-site*, and browsers (private windows especially) block third-party cookies, so a split static-site + API deployment would silently fail to sign you in. Serving the compiled dashboard from the API removes CORS, cookie tricks and a second deploy.

### Data model as built

```
users 1──* sessions        sessions.id = SHA-256(cookie token)  (a stolen DB cannot be replayed as logins)
users 1──* drills          drills.owner_id → users.id  ON DELETE CASCADE   ← every drill query filters on it
drills 1──* audit_events   the pipeline trail of one drill      (ON DELETE CASCADE)
drills 1──* reports        every submitted field report         (ON DELETE CASCADE)
drills.state               JSON world state (incidents, units, proposals…) used to resume a drill
kv                         shared, non-personal LLM score cache keyed by report content
```

### Known limits (by design, and what would change them)

| Limit | Why | What would change it |
|---|---|---|
| **One server instance.** Live drills, their sockets and the rate-limit counters live in the process. | A drill is one asyncio task with its own world; sharing it across instances needs a worker queue and a shared limiter. | A separate simulation worker plus Redis for limits and pub/sub for snapshots. |
| **No password reset or email verification.** | There is no mail service; a reset link needs one. | Add a provider (Resend, Postmark) and a reset-token table. Until then *Delete Account* and demo accounts cover "start over". |
| **Sign-up says when an email is taken** (`409`). | Friendlier than a silent failure; it is the usual trade-off without email verification. Sign-in never reveals it, and the per-address limits slow enumeration. | Email verification. |
| **One shared AI quota.** All drills use one Groq key; per-account and per-drill limits stop one person draining it, but the free tier is still small. | Cost. | Per-user keys or a paid tier. |
| **`TRUSTED_PROXY_HOPS` must match the host.** If it is too low every visitor appears as the proxy (one shared limit); too high lets a client choose its own address. | The app cannot know how many proxies sit in front of it. | `1` on Render (set in `render.yaml`); check one request's `X-Forwarded-For` after deploying. |
| **An unwatched drill pauses** (no ticks, AI calls or writes) and its clock stops; it resumes where it was. | Keeps a free database asleep and the AI quota unspent. | – |

### Deviations from the Level 1 plan (and why)

| Level 1 plan | Built | Why |
|---|---|---|
| Firebase Authentication | Email + password with argon2id hashes and server-side sessions | One less external service and account to configure; the session logic is small, testable and fully server-side. |
| Orgs, members, roles (`owner/admin/net_control/responder/viewer`) | Each account owns private drills | The Samurai rubric needs per-user isolation and CRUD; org roles are a Shogun concern. |
| `DrillSession` per org | `drills` per user | Same idea, one level simpler. |
| Static site + API as two Render services | One Docker service | Cookie sessions need a single origin (see above). |
| Render Postgres | Neon PostgreSQL via `DATABASE_URL` | Free tier that does not expire; the code is unchanged because it is plain Postgres. |
| `POST /api/drills/{id}/reports` + JWT | Same route shape, session cookie instead of a JWT | Matches the plan; the cookie replaces the token. |

*Sections 1–4 below are the original Level 1 design, kept for the record.*

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

**Deployment shape (Shogun):** static React build (Render static site) → FastAPI (Render web service) → managed Postgres (Render) → Groq API outbound, all declared in `render.yaml`. One region, one deploy pipeline, no exotic infrastructure.

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
| **Hosting** | Render (API + Postgres + static frontend, via a Blueprint) | One platform, HTTPS + managed Postgres with `git push` deploys and WebSocket support; free/low tiers sufficient for 25 users. |
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
