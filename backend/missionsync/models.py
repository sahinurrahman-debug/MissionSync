"""MissionSync core data model.

Single source of truth for everything that flows through the system:
surveillance signals, terrain, weather, resources, risk scores, and
command deployments. Everything is serializable so it can be pushed
straight to the dashboard over WebSocket.
"""
from __future__ import annotations

import enum
import time
import uuid
from datetime import datetime, timezone
from typing import Any, Literal, Optional

from pydantic import BaseModel, Field, field_validator


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:10]}"


# --------------------------------------------------------------------------
# Enums
# --------------------------------------------------------------------------

class IncidentType(str, enum.Enum):
    FIRE = "fire"
    FLOOD = "flood"
    STRUCTURAL_COLLAPSE = "structural_collapse"
    MEDICAL = "medical"
    HAZMAT = "hazmat"
    LANDSLIDE = "landslide"
    MISSING_PERSONS = "missing_persons"
    ROADSIDE_CASUALTIES = "roadside_casualties"


class Severity(str, enum.Enum):
    LOW = "low"
    MODERATE = "moderate"
    HIGH = "high"
    CRITICAL = "critical"


class IncidentStatus(str, enum.Enum):
    NEW = "new"
    TRIAGED = "triaged"
    UNITS_EN_ROUTE = "units_en_route"
    ON_SCENE = "on_scene"
    CONTAINED = "contained"
    CLOSED = "closed"


class ResourceType(str, enum.Enum):
    FIRE_UNIT = "fire_unit"
    AMBULANCE = "ambulance"
    RESCUE_TEAM = "rescue_team"
    SWIFT_WATER = "swift_water"
    ENGINEERING = "engineering"
    DRONE = "drone"
    HAZMAT_UNIT = "hazmat_unit"


# --------------------------------------------------------------------------
# Raw signals (the "different sources at different speeds" from the brief)
# --------------------------------------------------------------------------

class Signal(BaseModel):
    """A raw signal arriving from any source: drone feed, ground report, sensor."""
    id: str = Field(default_factory=lambda: new_id("sig"))
    source: Literal["drone", "ground_report", "sensor", "radio", "social"]
    incident_id: Optional[str] = None          # linked after surveillance triage
    lat: float
    lon: float
    observed_at: str = Field(default_factory=lambda: utcnow().isoformat())
    received_at: float = Field(default_factory=time.time)
    raw_text: str = ""
    confidence: float = Field(ge=0.0, le=1.0, default=0.8)
    meta: dict[str, Any] = Field(default_factory=dict)


class DroneFrame(BaseModel):
    """Metadata for one frame from a simulated drone feed ( imagery itself is text-described )."""
    drone_id: str
    lat: float
    lon: float
    heading_deg: float = 0.0
    battery: float = 1.0
    altitude_m: float = 120.0
    caption: str                      # textual description standing in for imagery
    detected_type: Optional[IncidentType] = None
    confidence: float = 0.7


# --------------------------------------------------------------------------
# Weather & terrain (context layers)
# --------------------------------------------------------------------------

class WeatherCell(BaseModel):
    zone: str
    lat: float
    lon: float
    wind_kph: float = 10.0
    wind_direction_deg: float = 0.0
    precipitation_mm_h: float = 0.0
    temperature_c: float = 22.0
    alert: Optional[str] = None       # e.g. "red_flag_wind", "flood_watch"
    forecast_note: str = ""


class TerrainCell(BaseModel):
    zone: str
    lat: float
    lon: float
    elevation_m: float = 50.0
    slope_deg: float = 0.0
    landcover: Literal["urban", "suburban", "forest", "water", "farmland", "industrial"] = "urban"
    road_access: Literal["good", "degraded", "blocked"] = "good"
    notes: str = ""


# --------------------------------------------------------------------------
# Resources
# --------------------------------------------------------------------------

class Resource(BaseModel):
    id: str = Field(default_factory=lambda: new_id("res"))
    type: ResourceType
    name: str
    base_lat: float
    base_lon: float
    current_lat: Optional[float] = None
    current_lon: Optional[float] = None
    personnel: int = 4
    capacity_note: str = ""
    status: Literal["available", "en_route", "on_scene", "returning"] = "available"
    assigned_incident: Optional[str] = None
    role: str = ""                    # assigned role, set by logistics agent
    speed_kph: float = 45.0
    capable_of: list[IncidentType] = Field(default_factory=list)


# --------------------------------------------------------------------------
# Incidents + risk
# --------------------------------------------------------------------------

class RiskBreakdown(BaseModel):
    """Transparent component scores, so judges can audit every ranking."""
    severity: float          # 0-100  how bad is the incident itself
    population: float        # 0-100  people affected / at risk
    spread: float            # 0-100  chance of escalation / spillover
    time_criticality: float  # 0-100  how fast does the window close
    confidence: float        # 0-100  how solid is our intel
    rationale: str = ""


class RiskScore(BaseModel):
    incident_id: str
    urgency: float           # 0-100 composite
    breakdown: RiskBreakdown
    tier: Literal["P1", "P2", "P3", "P4"]
    scored_at: str = Field(default_factory=lambda: utcnow().isoformat())
    scoring_latency_ms: int = 0
    source: Literal["llm", "rules", "cached"] = "rules"   # provenance of the components


class Incident(BaseModel):
    id: str = Field(default_factory=lambda: new_id("inc"))
    type: IncidentType
    title: str
    description: str = ""
    lat: float
    lon: float
    zone: str = ""
    status: IncidentStatus = IncidentStatus.NEW
    reported_at: str = Field(default_factory=lambda: utcnow().isoformat())
    updated_at: str = Field(default_factory=lambda: utcnow().isoformat())
    affected_population: int = 0
    injuries: int = 0
    confidence: float = 0.8
    signal_ids: list[str] = Field(default_factory=list)
    terrain: Optional[TerrainCell] = None
    weather: Optional[WeatherCell] = None
    risk: Optional[RiskScore] = None
    location_known: bool = True       # False ⇒ report gave no place; pinned to city centre
    merged_reports: int = 0
    provisional: bool = False         # scored by the rules just now; the LLM is refining it


# --------------------------------------------------------------------------
# Logistics / command output
# --------------------------------------------------------------------------

class Deployment(BaseModel):
    id: str = Field(default_factory=lambda: new_id("dep"))
    incident_id: str
    incident_title: str = ""
    resource_id: str
    resource_name: str
    resource_type: ResourceType
    eta_minutes: float = 0.0
    role: str = ""            # e.g. "primary suppression", "search", "triage"
    priority: int = 0         # rank of the incident this serves
    rationale: str = ""
    created_at: str = Field(default_factory=lambda: utcnow().isoformat())


class Proposal(BaseModel):
    """A recommended unit→incident assignment awaiting a human decision (PRD: the system
    recommends, a person commits). In auto-dispatch (demo) mode proposals are committed at once."""
    id: str
    incident_id: str
    incident_title: str = ""
    resource_id: str
    resource_name: str
    resource_type: ResourceType
    eta_minutes: float = 0.0
    role: str = ""
    priority: int = 0
    rationale: str = ""
    source: Literal["llm", "rules"] = "rules"


class RecommendedAction(BaseModel):
    """A coordinated recommendation for one incident, produced by the command agent."""
    incident_id: str
    incident_title: str = ""
    priority: int = 0
    urgency: float = 0.0
    headline: str
    details: list[str] = Field(default_factory=list)
    deployments: list[Deployment] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)
    generated_at: str = Field(default_factory=lambda: utcnow().isoformat())
    latency_ms: int = 0


# --------------------------------------------------------------------------
# World state pushed to dashboard
# --------------------------------------------------------------------------

class EventLine(BaseModel):
    seq: int
    t: str            # HH:MM:SSZ
    msg: str


class Pipeline(BaseModel):
    stage: Literal["idle", "surveillance", "terrain", "risk", "logistics", "command"] = "idle"
    origin: Literal["boot", "sim", "inject", "reset", "refine", "restore"] = "boot"


class WorldSnapshot(BaseModel):
    status: Literal["booting", "live", "ended"] = "booting"
    tick: int = 0
    sim_time: str = Field(default_factory=lambda: utcnow().isoformat())
    incidents: list[Incident] = Field(default_factory=list)
    resources: list[Resource] = Field(default_factory=list)
    weather: list[WeatherCell] = Field(default_factory=list)
    actions: list[RecommendedAction] = Field(default_factory=list)
    metrics: dict[str, Any] = Field(default_factory=dict)
    event_log: list[EventLine] = Field(default_factory=list)
    pipeline: Pipeline = Field(default_factory=Pipeline)
    proposals: list[Proposal] = Field(default_factory=list)
    settings: dict[str, Any] = Field(default_factory=dict)
    elapsed_s: int = 0


# --------------------------------------------------------------------------
# Incoming report (used by API + judge injector)
# --------------------------------------------------------------------------

MAX_REPORT_CHARS = 2000


class IncomingReport(BaseModel):
    """Free-text report injected mid-demo. Surveillance agent parses it."""
    text: str = Field(min_length=1, max_length=MAX_REPORT_CHARS)
    source: Literal["drone", "ground_report", "radio", "sensor", "social"] = "ground_report"
    lat: Optional[float] = Field(default=None, ge=-90.0, le=90.0)
    lon: Optional[float] = Field(default=None, ge=-180.0, le=180.0)
    confidence: float = Field(default=0.9, ge=0.0, le=1.0)
    # Idempotency key: a retried or double-clicked submit with the same nonce is processed once.
    client_nonce: Optional[str] = Field(default=None, max_length=64)

    @field_validator("text")
    @classmethod
    def _not_blank(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("Report text must not be blank")
        return v


class ReportOutcome(BaseModel):
    """What the pipeline did with an injected report (drives the intake toast)."""
    kind: Literal["created", "merged", "rejected"]
    incident_id: Optional[str] = None
    title: str = ""
    tier: Optional[Literal["P1", "P2", "P3", "P4"]] = None
    urgency: Optional[float] = None
    message: str = ""
    provisional: bool = False        # True ⇒ rule-scored now, the LLM refinement follows
