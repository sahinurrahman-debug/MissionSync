# Roadmap — MissionSync

*Milestones mapped to the program levels · Journey to Mastery — Level 1 (Ronin)*

> Written before building. These are commitments the later levels are judged against: the Kenshi milestone below is exactly the PRD's MVP feature list, minus anything requiring a backend — moved, not dropped.

---

## Milestone 1 — "The drill board you can watch" → ships at **Kenshi** (frontend)

**What exists, visually and functionally, with no backend of its own:**

- The full three-pane dashboard deployed as a static site: live map with priority-colored, urgency-scaled incident markers and a legend; ranked incident feed with tier chips, urgency, and the auditable rationale line; command recommendation cards with action bullets, warnings, and deployment chips; resource board with unit states; timestamped event log.
- The **report → merge → re-rank → recommend loop runs live in the browser**: a mock state layer (small TS module standing in for the API) seeds a fictional multi-sector city, streams simulated radio traffic on a timer, and accepts typed free-text reports. Ranking math, tiering, capability matching, and ETAs are real code, not video fakery.
- Deployed to a public URL, so the judge experience is "open the link, type a report, watch the board re-order," identical to the eventual production flow.
- **Deliberately absent:** login, persistence across reload, multiple viewers seeing each other, and any human-commit control — units move on the simulator's own timer, but nobody can confirm or override an assignment yet. All of those need state on a server, and pretending otherwise would just move Samurai work into a worse medium.

**Target dates:** scaffold + mock layer + map + ranked feed in week 1; recommendations, event log, polish, deploy in week 2. **Ready by Oct 11, 2026.**

---

## Milestone 2 — "Real drills, real people" → added at **Samurai** (full-stack)

**What gets added once there's a database and auth:**

- **Firebase auth + Postgres persistence:** accounts, orgs (CERT club / radio team), per-org roles (owner/admin/net_control/responder/viewer), and drill sessions. A drill's incidents, reports, units, and assignments survive reloads, servers, and weeks — after-action review becomes possible because the data is real.
- **The agent pipeline moves server-side behind the planned REST API:** report intake (`POST /drills/{id}/reports`) runs surveillance → terrain → risk → logistics → command in FastAPI, with WebSocket snapshot push to every signed-in viewer of that drill — so net control's screen and responders' phones show the same picture.
- **Human-commit controls:** net control marks incidents contained/closed and confirms unit assignments (the system still never auto-dispatches); recommendations become suggestions awaiting a person.
- **Ground-truth scoring harness:** seeded drills carry hidden expected urgency so ranking accuracy is measured, not vibes — feeding the PRD's ranking-trust metric.
- Also in this window: measure and hit the p95 report-to-screen < 3 s budget; run two friendly-org drills as dogfooding.

**Target dates:** data model + auth + drill sessions first month; server pipeline + live push second month; dogfood drills in month three. **Ready by Dec 6, 2026.**

---

## Milestone 3 — "Done and used by real people" → at **Shogun** (production)

**What "done" looks like for this idea:**

- **≥ 3 real drill-running organizations and ≥ 25 accounts that were used during live exercises** (the PRD's activated-orgs metric) — recruited from campus CERT, amateur-radio nets, and one student emergency-prep group, onboarded with a one-page runbook rather than hand-holding.
- **Deployed like something people depend on:** HTTPS everywhere, production + staging, CI running backend/frontend checks on every PR, automated DB backups with a tested restore, structured logs + basic uptime/alerting on `/api/health` — because a board that dies mid-drill is worse than the paper it replaced.
- **Hardened for the bursty drill reality:** LLM-outage fallback verified end-to-end in production, rate limiting on intake, audit trail complete enough to answer "when did report #12 arrive and who assigned what" after the exercise.
- **Evidence loop closed:** post-drill survey wired in, adoption + intake-shift + coverage metrics visible to me (not to users), second-drill retention tracked per org.
- Explicitly still out of scope (unchanged from the PRD): automatic dispatch, real agency integrations, mobile apps, offline mesh mode.

**Target dates:** hardening + backups + CI in the first month; the remaining window is recruiting orgs and running drills, because users are the deliverable. **Ready by Jan 24, 2027.**

---

## Consistency notes

- Kenshi's feature list ⇔ PRD §3: items 1–7 map to map / ranked feed / recommendations / resource board / event log / live updates (via mock stream) / intake; drill *session persistence* moves to Samurai because it requires a database.
- Stack here ⇔ ARCHITECTURE.md §2 ⇔ README stack table (same choices, same justifications).
- Success metrics here ⇔ PRD §5; the 25-user bar is Milestone 3's headline.

*Success measures: [PRD.md](./PRD.md) · What each piece costs technically: [ARCHITECTURE.md](./ARCHITECTURE.md)*
