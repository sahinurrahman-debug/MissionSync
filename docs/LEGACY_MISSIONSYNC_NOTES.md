# MissionSync

**Multi-agent disaster-response coordination** — fuse live incident reports, terrain, weather, and resource status into one operational picture; rank incidents by risk; recommend coordinated deployments; and refresh everything in place as new information arrives. No restart, ever.

Built for the Defence & Emergency Response / Multi-Agent Coordination problem statement.

---

## Quickstart (2 terminals)

```bash
# 1. Backend (creates venv, installs deps, starts API on :8000)
./scripts/run_backend.sh

# 2. Frontend dashboard on :5173
cd frontend && npm install && npm run dev
```

Add your key to `backend/.env` (copy from `.env.example`):

```
GROQ_API_KEY=gsk_...
```

Without a key the system still runs end-to-end in deterministic **fallback mode** — every agent has a rule-based twin — so the demo never dies.

**Judge stress test (mid-demo):**

- Dashboard: type a report in the injector panel → **Inject report**, or
- CLI: `./scripts/inject.sh "Ammonia vapor cloud at Industrial Park gate 3, workers down"`

Ranking and recommendations refresh in place within seconds. Nothing restarts.

---

## Round 1 deliverables

### 1. Incident data model & agent architecture

`backend/missionsync/models.py` is the single typed source of truth:

| Model | Purpose |
|---|---|
| `Signal`, `DroneFrame` | raw inputs from drones / radio / ground reports / sensors (the "different sources at different speeds") |
| `Incident` | fused operational object: type, location, population, injuries, confidence, linked terrain + weather + risk |
| `TerrainCell`, `WeatherCell` | context layers (zone-indexed) |
| `Resource` | teams/units: type, personnel, position, speed, status, assignment |
| `RiskScore`, `RiskBreakdown` | auditable 4-component scoring with rationale |
| `Deployment`, `RecommendedAction` | logistics output & command orders |
| `WorldSnapshot` | everything the dashboard renders, pushed over WebSocket |

**Agent architecture** (each agent = 1 Groq LLM call in JSON mode + deterministic fallback twin):

```
 raw signals ──► ┌───────────────┐
                 │ SURVEILLANCE  │  parse free text → structured incidents,
                 └──────┬────────┘  merge duplicates into existing incidents
                        ▼
                 ┌───────────────┐
                 │   TERRAIN     │  access difficulty, escalation risk, hazards
                 └──────┬────────┘  (slope, roads, wind/rain, landcover)
                        ▼
                 ┌───────────────┐
                 │ RISK-SCORING  │  4 components 0–100 → weighted composite
                 └──────┬────────┘  urgency + P1–P4 tier  (▼ full ranking)
                        ▼
   ┌───────────────────┴───────────────────┐
   ▼                                       ▼
┌───────────────┐                 ┌─────────────────┐
│   LOGISTICS   │                 │     COMMAND     │
│ match ranked  │  deployments    │ imperative      │
│ incidents ↔   ├────────────────►│ orders, action  │
│ free units    │                 │ bullets, warning│
└───────────────┘                 └─────────────────┘
```

- **Surveillance** parses incoming raw signals into typed incident records and decides "new vs merge" (explicit `linked_incident_id`, with a geospatial fuzzy-match safety net: same type within 1.5 km ⇒ same incident).
- **Terrain** turns zone terrain + live weather into `access_difficulty` and `escalation_risk` (0–100) plus hazard notes.
- **Risk-scoring** consumes those to produce the four components (below). The **composite is computed deterministically in code** from the LLM's components — agents propose, math decides.
- **Logistics** matches ranked incidents to free units, honoring capability requirements and one-unit-one-incident.
- **Command** writes the operational recommendation for the top incidents: headline order, action bullets, warnings, referencing planned deployments and weather alerts.

**Orchestrator** (`orchestrator.py`) owns state and the pipeline; runs concurrently (`asyncio.gather`) across incidents; pushes a `WorldSnapshot` to all dashboards after every cycle.

### 2. Simulation dataset (`simulator.py` + `xbd.py`)

Incident scenarios are sourced from the **xBD damage-assessment dataset** — `rayanhossain239/damageactu-xbd-full` on Kaggle (xBD: building damage from pre/post-disaster satellite imagery, Gupta et al. 2019), loaded at runtime via **kagglehub**:

```python
df = kagglehub.load_dataset(
  KaggleDatasetAdapter.PANDAS,
  "rayanhossain239/damageactu-xbd-full",
  file_path,  # override with the XBD_FILE_PATH env var
)
```

- Each record carries a disaster event, an ordinal **damage grade** (0 no damage → 3 destroyed, the Joint Damage Scale) and coordinates. `xbd.py` converts grade → **hidden ground-truth urgency** (0→10, 1→40, 2→70, 3→90) and event name → incident type (earthquake → structural collapse, wildfire → fire, flood/hurricane/typhoon → flood, volcano/landslide → landslide).
- **Scenario seed**: 5 initial incidents sampled deterministically from the dataset (same demo every run).
- **Wave pool**: 5 more incidents spawn on sim ticks 2/3/5 from a disjoint deterministic sample so the picture evolves during the demo.
- **Offline fallback**: if kagglehub, Kaggle credentials, or the network are unavailable, a deterministic fallback cohort built by the same conversion rules keeps every feature demoable — the same no-single-point-of-failure philosophy as the LLM fallback twins.
- Real dataset coordinates ride along as hidden provenance metadata (`_dataset_lat/_lon`, `_event`, `_damage_grade`); the map pins incidents to the fictional sector grid so the demo stays legible.

The world the incidents land in is unchanged — fictional city **Riverton**, six sectors with distinct terrain/thermal signatures:

| Sector | Terrain | Built-in weather alert |
|---|---|---|
| Downtown | dense urban, good roads | — |
| Riverfront | levee, flood-prone low ground | `flood_watch` (rain intensifying) |
| North Hills | steep forest, single access road | `red_flag_wind` (38→52 kph) |
| Industrial Park | chemical depots, rail spur | — |
| Eastside | suburban grid, schools/care homes | — |
| University | high daytime population, labs | — |

Streams produced:

- **12 resources** across 7 types (fire units, ambulances, USAR, swift-water, engineering, drones, hazmat) with real positions and speeds.
- **Follow-up reports** (e.g. "third victim located") exercise the *merge* path.
- **Weather drift** every tick; North Hills winds spike on tick 4, which legitimately raises fire risk.
- Drones generate per-sector frames with battery/heading, standing in for feeds.

### 3. Risk-ranking & recommendation methodology

Every incident is scored on four 0–100 components:

| Component | Weight | Answers |
|---|---|---|
| `severity` | 0.35 | How bad is it itself (life safety, property, environment)? |
| `population` | 0.25 | How many people are affected / immediately at risk? |
| `spread` | 0.20 | Probability of escalation/spillover in the next hour? |
| `time_criticality` | 0.20 | How fast does the response window close? |

```
urgency = 0.35·severity + 0.25·population + 0.20·spread + 0.20·time_criticality
```

- Tiers: **P1 ≥ 75**, P2 ≥ 55, P3 ≥ 35, else P4.
- The LLM scores components; the weighted composite, tiering, and final ordering are **deterministic code** — identical inputs give identical rankings (consistency judges can verify).
- Each score carries a **rationale** (≤ 40 words) shown on the card and map tooltip — every ranking is auditable.
- Ranking updates whenever inputs change: follow-up reports merge (population/injuries rise), weather drifts (escalation ↑), unresolved incidents decay (affected population grows ~8%/tick), all feeding the next scoring pass.

**Deployment methodology:** capability matrix per incident type (e.g. collapse ⇒ USAR + ambulance; hazmat ⇒ hazmat unit + fire unit), one resource per incident, priority-ordered assignment, ETA = haversine distance ÷ unit speed. The LLM proposes role + rationale; the fallback twin is a greedy nearest-capable matcher.

### 4. Evaluation metrics (live in the dashboard header + `/api/snapshot`)

| Metric | Definition | Where |
|---|---|---|
| **Ranking accuracy** | Spearman ρ between system urgency and ground-truth urgency derived from xBD damage grades (hidden from agents) | `metrics.ranking_accuracy` |
| **Response latency** | End-to-end pipeline cycle ms; per-stage (surveillance/terrain/risk/logistics/command) ms; LLM avg latency & success rate | `metrics.latency` |
| **Recommendation quality** | P1/P2 coverage (% of P1/P2 incidents with a unit assigned), capability-match rate (% of deployments whose unit type is in the incident's capability matrix), best ETA to the #1 incident | `metrics.recommendation_quality` |
| Injection resilience | Count of injected reports processed with zero restarts | header chip |

---

## Round 2 deliverables

### Simulated operations dashboard (`frontend/`)

- **Incident map** (Leaflet): incidents as priority-colored, urgency-scaled markers; response units live-moving; legend + tooltips.
- **Ranked feed**: every incident with rank, tier chip, urgency, breakdown rationale; P1/P2 counters.
- **Command recommendations**: headline order, action bullets, warnings, deployment chips with roles & ETAs.
- **Header metrics strip**: LLM mode, tick, last cycle ms, ranking ρ, P1/P2 coverage, injections processed.
- **Live event log**: surveillance merges, deployments, ETAs, weather warnings — the audit trail judges can follow.

### Live update pipeline

- WebSocket push (`/ws`) of full snapshots after **every** pipeline cycle — no polling, no restart.
- Ingestion API `POST /api/report` accepts arbitrary free text **any time**; the orchestrator runs the same pipeline as any other signal and merges results in place.
- The sim loop refreshes rankings continuously (resource movement, weather drift, follow-up reports), so the picture is never stale even with no injections.
- Robustness: LLM call retry + stronger-model repair pass; 25 s timeout; if Groq fails mid-demo the deterministic twins take over and the dashboard keeps running; broadcast/loop errors are contained per cycle.

### Judge stress test runbook

1. Dashboard is live; point out current ranking and the #1 recommendation.
2. Mid-demo, inject (dashboard panel or `./scripts/inject.sh "..."`) something designed to jump the queue, e.g. *"Ammonia vapor cloud at Industrial Park gate 3, three workers down, cloud drifting toward Eastside"*.
3. Narrate: surveillance parses it → terrain scores escalation → risk stamps it (expect P1, ~85+) → the ranked feed **re-orders in place**, logistics re-assigns units (watch the event log + units move on the map), command issues a new headline order.
4. Header shows `injections N+1`, cycle latency in ms, coverage recomputed. Zero restarts.
