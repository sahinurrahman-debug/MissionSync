# PRD — MissionSync

*Product Requirements Document · Journey to Mastery — Level 1 (Ronin)*

> One sentence: small volunteer emergency-response teams run their exercises on paper logs and group chats, and MissionSync gives them one live, ranked operational picture instead.

---

## 1. Problem statement

**Who has this problem.** Campus CERT clubs, amateur-radio (ARES/RACES) net teams, and small volunteer responder groups that run drills and community events. Their comms lead — usually one person with a handheld radio and a laptop — is the bottleneck: every situation report arrives as a radio call, a text message, or a shouted relay, and that person transcribes it onto a paper ICS-213/209-style log, decides which incident matters most in their head, and then re-briefs everyone else verbally.

**Why I believe it's real (not invented for this assignment):**

- The paperwork already exists as an industry standard. ICS-213 (General Message) and ICS-209 (Incident Status Summary) are formal FEMA forms precisely because incident status must be tracked, ranked, and shared — small teams currently do this with pen, paper, and memory.
- I have sat in campus emergency-prep drills where the net controller's entire "system" was a spiral notebook and a whiteboard. When two reports described the same incident from different corners, they became two entries; when the genuinely urgent report came in during a busy net, it waited behind a roll call.
- After-action reviews have no data: nobody can answer "how long from first report to first unit assigned?" because nothing was timestamped.
- The cost of getting it wrong is asymmetric. Mis-prioritizing a hazmat report below a parking complaint costs nothing in a drill — and everything in a real activation. Teams train precisely to get this ordering right, which is why they invest weekends in it.

**The gap MissionSync fills.** Professional incident-management platforms (CAD systems, WebEOC) assume paid dispatchers, dedicated hardware, and agency procurement. Group chats are fast but unstructured and unranked. Nothing serves the middle: volunteer teams who need a *shared, ranked, live* picture during a 2–4 hour exercise, without training or infrastructure.

---

## 2. Target user

**Primary:** The **net control lead** of a campus CERT or amateur-radio emergency team — a student or volunteer who, during a drill, simultaneously takes radio reports, keeps the incident log, assigns the 3–12 available responder teams, and briefs the exercise director. Concretely: someone juggling a handheld radio, a Discord voice channel, and a paper log across a 3-hour Saturday exercise with 15–40 participants.

**Secondary:** Drill participants — responder-team members who want to see the current incident ranking and their assignment without asking net control; and the **exercise director / club faculty advisor** who runs after-action review and wants the event log as evidence.

**Not a target user (for this project):** Professional 911 dispatchers, city EOC staff, or anyone with a paid CAD seat — their requirements (24/7 SLAs, records retention, interoperability mandates) would blow up scope.

---

## 3. Core features — MVP

The smallest version that is *actually useful in a drill*, not a toy demo:

1. **Ranked incident feed** — every open incident, ordered by a transparent urgency score (0–100, four auditable components: severity, population, spread, time-criticality, tiered P1–P4). Net control sees the next-most-important thing without re-deriving it mentally.
2. **Free-text report intake** — type a field report ("smoke from Building C, two people coughing"); the system parses it into a structured incident and **merges** it with an existing incident when it's a duplicate (same type, nearby location), so the picture stays one picture.
3. **Live incident map** — priority-colored markers sized by urgency; responder units shown as they move. The single screen the room looks at.
4. **Resource board** — teams/units with status (available / en route / on scene), current assignment, role, and ETA to their incident.
5. **Recommended deployments** — for the top-ranked incidents, suggested unit assignments honoring capability (swift-water to flooding, not to a fender-bender) with rationale — *recommendations a human approves, never automatic dispatch*.
6. **Live updates without refresh** — new reports and re-rankings push to every screen in seconds. This is the product's identity: the picture is never stale mid-drill.
7. **Drill session & event log** — one timestamped audit trail per exercise (report → parse → merge → rank → assign) that doubles as the after-action review artifact.

Each feature maps 1:1 to what net control already does on paper — adoption cost is reading a screen, not learning a methodology.

---

## 4. Out of scope (and why)

| Not building | Why not |
|---|---|
| **Real drone video / imagery ingestion** | Video pipelines are a project by themselves; MissionSync's insight is that *text descriptions* already carry most of the signal. Revisit post-Shogun. |
| **CAD / 911 / agency integrations** | Requires legal agreements and interoperability mandates; volunteers don't have these. |
| **Automatic dispatch (system sends orders to units)** | Legally and ethically wrong for volunteers; MissionSync recommends, humans commit. Hard product boundary. |
| **Native mobile apps** | A responsive web app covers drill use (phone browsers on scene, laptop at net control). App-store overhead buys nothing at 25 users. |
| **Offline / mesh networking mode** | Genuinely valuable in real disasters, but a research problem; drills have venue Wi-Fi or LTE. |
| **Real weather/terrain feeds at MVP** | Simulated layers prove the ranking logic; a real API is a post-Shogun enhancement, not a MVP dependency. |
| **Multi-tenant SaaS, billing, org admin panels** | 25 users across 3–5 known orgs need invitations, not subscription management. |
| **AI image recognition / voice transcription** | Nice future intake channels; text-first proves the core value with zero new risk. |
| **Non-English UI, accessibility beyond WCAG-AA basics** | Chosen community is English-speaking; committing to i18n before validation is waste. |

---

## 5. Success metrics

These are written to connect directly to the Shogun bar of **25 real users**:

| Metric | Target | Why it means "used and got value" |
|---|---|---|
| **Activated organizations** | ≥ 3 drill-running orgs with ≥ 25 total accounts by Shogun | Users = participants who logged in during a real exercise, not signups. |
| **Drill adoption** | ≥ 60% of a drill's participants view the board ≥ 3 times per session (event-tracked) | The board becomes the shared reference, not net control's private screen. |
| **Intake shift** | ≥ 50% of exercise reports entered via MissionSync rather than paper/chat (counted vs. exercise master scenario event list) | Core job-to-be-done is actually delegated to the product. |
| **Perceived value** | Post-drill 1-question survey ≥ 4/5 "the board improved our situational awareness"; ≥ 2 orgs run a *second* drill within 30 days | Second-drill retention is the only honest satisfaction signal volunteers give. |
| **Ranking trust** | In each drill, net control accepts ≥ 70% of recommended deployments without manual re-ordering | The ranking is trusted enough to act on — the product's central claim. |
| **Reliability during exercises** | ≥ 99% uptime during scheduled drill windows; p95 report-to-screen latency < 3 s | A tool that fails mid-drill is worse than paper, and teams will say so publicly. |

**Anti-vanity note:** account counts alone don't count as success. An org that registers and never runs a drill is a failure signal, and the retention metric exists to catch that.

---

## 6. Assumptions & risks (summary)

- Exercises are scheduled events with a known start/end — usage is bursty by nature, which shapes hosting and testing (see REQUIREMENTS.md).
- Volunteers will tolerate a short signup if the board pays for itself within the first 15 minutes of a drill.
- Biggest product risk: net control bypasses the tool under radio stress. Mitigation: the report-intake flow must be *one input box*, and the demo plan (Kenshi) must show the inject-a-report moment explicitly.

*User research detail and constraints: see [REQUIREMENTS.md](./REQUIREMENTS.md). Milestone mapping: see [ROADMAP.md](./ROADMAP.md).*
