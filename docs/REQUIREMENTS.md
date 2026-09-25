# Requirements — MissionSync

*Functional & non-functional requirements, assumptions, constraints · Journey to Mastery — Level 1 (Ronin)*

---

## 1. Functional requirements

The system shall:

1. **FR-1 Report intake** — accept a free-text field report (≤ 2000 chars) from any authenticated member of a drill's org, with optional lat/lon and source tag; reject only on validation errors.
2. **FR-2 Parse & structure** — convert each report into a structured incident record: type, title, zone, affected population, injuries, confidence, location.
3. **FR-3 Merge duplicates** — decide new-vs-merge per report (explicit link by the parser, plus a deterministic safety net: same type within ~1.5 km ⇒ same incident) so the board shows one entry per real-world incident.
4. **FR-4 Context scoring** — attach terrain and weather context (access difficulty, escalation risk, hazards) to every incident, sourced from per-zone layers.
5. **FR-5 Risk ranking** — score every open incident on four 0–100 components (severity, population, spread, time-criticality), combine them with fixed weights (.35/.25/.20/.20) in code, and tier P1–P4 (≥75 / ≥55 / ≥35 / else). Identical inputs must always produce identical rankings.
6. **FR-6 Auditability** — attach a ≤ 40-word rationale to every score and a timestamped event-log entry to every pipeline step (report → parse → merge → rank → assign).
7. **FR-7 Capability-aware recommendations** — propose unit↔incident assignments honoring a capability matrix per incident type (e.g. collapse ⇒ rescue + ambulance), one-unit-one-incident, per-incident assignment caps, and haversine ETAs. Recommendations always require human confirmation; the system never dispatches autonomously.
8. **FR-8 Human commit actions** — let net control mark incidents contained/closed and confirm or override unit assignments and roles.
9. **FR-9 Live push** — broadcast the full world snapshot to every connected dashboard of a drill within the latency budget of NFR-1, with an initial-snapshot REST fallback on connect.
10. **FR-10 Multi-org isolation** — scope every drill, incident, unit, and report to its owning org; no cross-org data is ever readable or writable.
11. **FR-11 Drill sessions** — support creating, running, and ending a drill; all state persists per drill for after-action review, including the full audit trail.
12. **FR-12 Graceful degradation** — if the LLM provider fails or times out (25 s cap, retry + repair pass), rule-based fallback twins produce each pipeline step's output, the board displays a degraded-mode banner, and no drill ever stalls.
13. **FR-13 Simulated exercise mode** — provide a built-in simulator (fictional city, incidents seeded from the xBD damage-assessment dataset on Kaggle — `rayanhossain239/damageactu-xbd-full` via kagglehub — with a deterministic offline fallback, streamed radio traffic, weather drift) so every feature is demoable and testable without a real drill, and so ranking accuracy can be measured against hidden ground truth derived from the dataset's damage grades.
14. **FR-14 Post-drill export** — let an org admin export a drill's audit log and final incident list (CSV) for after-action review.

## 2. Non-functional requirements

**Performance**

- **NFR-1 Ranking freshness:** report accepted → re-ranked picture visible: **p95 < 3 s** (pipeline cycle budget: surveillance+terrain+risk ≤ 1.5 s, logistics+command ≤ 1 s, broadcast < 0.5 s).
- **NFR-2 Concurrency:** support **50 concurrent dashboard viewers** per drill and a burst of 10 reports/minute without dropped updates.
- **NFR-3 Board interactivity:** client interactions (select incident, filter feed) respond < 100 ms; map with 40 incidents + 15 units renders without jank on a 3-year-old laptop.

**Security**

- **NFR-4 Auth:** all drill data requires a verified Firebase identity; server-side token verification on every request, including WebSocket upgrade; short-lived tokens.
- **NFR-5 Authorization:** role checks enforced server-side per endpoint (owner/admin/net_control/responder/viewer per org); org isolation tested with negative tests.
- **NFR-6 Secrets:** API keys (Groq, Firebase admin, DB URL) only in environment variables; no secrets in the repo, logs, or client bundle.
- **NFR-7 Input safety:** all LLM output validated against JSON schemas before touching state; report text length-capped; rate-limited intake.

**Accessibility**

- **NFR-8 WCAG 2.1 AA:** color is never the sole carrier of meaning (tier chips carry P1–P4 text), keyboard-operable feed and intake, focus states visible, contrast ≥ 4.5:1.
- **NFR-9 Readability under stress:** ≥ 16 px base font, high-contrast priority colors tested for the most common color-vision deficiency — net control reads this at arm's length while holding a radio.

**Reliability & operability**

- **NFR-10 Drill-window uptime ≥ 99%** (scheduled drills are known in advance; deploys are frozen during live drills).
- **NFR-11 Observability:** structured logs with request ids, `/api/health` uptime checks, cycle-latency and LLM-success metrics visible in the dashboard header.
- **NFR-12 Recovery:** daily automated DB backups; a documented, *tested* restore procedure.

## 3. Assumptions & constraints

**Assumptions**

- Drills are scheduled, 2–4 hour events with venue Wi-Fi or LTE — bursty usage, not 24/7 load; this is why "drill-window uptime," not global uptime, is the committed metric.
- One person acts as net control per drill; participants join read-mostly.
- The community (campus CERT, amateur-radio clubs) is English-speaking and accepts email/password + Google sign-in.
- Simulated terrain/weather layers are acceptable at MVP; real feeds are a post-Shogun enhancement.
- Volunteer teams accept recommendations-with-human-approval; no stakeholder expects auto-dispatch (it's out of scope by design).

**Constraints**

- **Time budget:** ~8–10 hours/week alongside full-time coursework; single builder. This is why Samurai's data model is small and why Firebase (managed auth) is chosen over self-hosting identity.
- **Budget:** $0/month until Shogun; free tiers of Railway/Netlify/Firebase/Groq must suffice at 25 users.
- **Skills already proven:** React/TypeScript, FastAPI, Pydantic, async Python, Leaflet, WebSocket push — all exercised by the prototype in this repo.
- **Skills to learn (planned, with mitigation):** SQLAlchemy 2.0 async + Alembic migrations (small schema, learn by building Samurai's five-table model first); firebase-admin verification (well-documented path, isolated in one auth dependency); CI/CD pipelines (GitHub Actions templates, keep the pipeline trivial: lint + typecheck + tests).
- **LLM dependency:** Groq free-tier rate limits shape the cycle budget; the deterministic fallback twins exist precisely so this dependency can never take a drill down.

---

*Milestones and dates: [ROADMAP.md](./ROADMAP.md) · Endpoints/auth/error shape: [API_SPEC.md](./API_SPEC.md) · Stack choices: [ARCHITECTURE.md](./ARCHITECTURE.md)*
