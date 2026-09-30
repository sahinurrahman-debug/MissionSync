"""Synthetic disaster-response simulator.

Generates the operational picture: sectors with terrain, drifting weather
cells, a resource inventory, and a stream of incidents/signals with *hidden
ground-truth urgency* so we can measure ranking accuracy honestly.

Incident scenarios come from the xBD damage-assessment dataset
(``rayanhossain239/damageactu-xbd-full`` on Kaggle — see ``xbd.py``), not
hand-written: each seeded incident is a real satellite damage survey whose
observable counts the agents read and whose hidden urgency they are scored
against.

The judge stress test injects extra signals via the API — the simulator
doesn't need to restart, and neither does the orchestrator.
"""
from __future__ import annotations

import random
import re
from typing import Any, Optional

from . import xbd
from .models import IncidentType, Resource, ResourceType, TerrainCell, WeatherCell

# ---------------------------------------------------------------------------
# Fictional city: "Riverton" — six operational sectors
# ---------------------------------------------------------------------------

SECTORS: dict[str, tuple[float, float]] = {
    "Downtown": (34.0580, -118.2450),
    "Riverfront": (34.0430, -118.2380),
    "North Hills": (34.0740, -118.2550),
    "Industrial Park": (34.0350, -118.2590),
    "Eastside": (34.0520, -118.2210),
    "University": (34.0660, -118.2290),
}
CITY_CENTER: tuple[float, float] = (34.0555, -118.2400)

# Words that place a free-text report in a sector (first match in the text wins).
ZONE_ALIASES: dict[str, tuple[str, ...]] = {
    "Downtown": ("downtown", "transit mall", "city center", "city centre", "high-rise", "storefront"),
    "Riverfront": ("riverfront", "marina", "levee", "footbridge", "houseboat", "river"),
    "North Hills": ("north hills", "hillside", "ridge", "hills", "brush"),
    "Industrial Park": ("industrial park", "industrial", "rail", "depot", "warehouse", "refinery", "chemical plant"),
    "Eastside": ("eastside", "east side", "arterial", "care home", "suburb"),
    "University": ("university", "campus", "lab block", "chemistry", "dorm", "students"),
}

TERRAIN: dict[str, TerrainCell] = {
    "Downtown": TerrainCell(zone="Downtown", lat=34.0580, lon=-118.2450, elevation_m=85, slope_deg=2, landcover="urban", road_access="good", notes="dense high-rise, narrow alleys"),
    "Riverfront": TerrainCell(zone="Riverfront", lat=34.0430, lon=-118.2380, elevation_m=42, slope_deg=3, landcover="water", road_access="degraded", notes="river levee, flood-prone low ground"),
    "North Hills": TerrainCell(zone="North Hills", lat=34.0740, lon=-118.2550, elevation_m=310, slope_deg=18, landcover="forest", road_access="degraded", notes="single access road, dry brush"),
    "Industrial Park": TerrainCell(zone="Industrial Park", lat=34.0350, lon=-118.2590, elevation_m=55, slope_deg=1, landcover="industrial", road_access="good", notes="chemical storage depots, rail spur"),
    "Eastside": TerrainCell(zone="Eastside", lat=34.0520, lon=-118.2210, elevation_m=70, slope_deg=4, landcover="suburban", road_access="good", notes="schools and care homes in grid"),
    "University": TerrainCell(zone="University", lat=34.0660, lon=-118.2290, elevation_m=95, slope_deg=6, landcover="urban", road_access="good", notes="high daytime population, labs on campus"),
}


def initial_weather() -> dict[str, WeatherCell]:
    return {
        "North Hills": WeatherCell(zone="North Hills", lat=34.0740, lon=-118.2550, wind_kph=38, wind_direction_deg=210, precipitation_mm_h=0, temperature_c=34, alert="red_flag_wind", forecast_note="gusting to 50 kph by hour 2"),
        "Riverfront": WeatherCell(zone="Riverfront", lat=34.0430, lon=-118.2380, wind_kph=14, wind_direction_deg=180, precipitation_mm_h=12, temperature_c=19, alert="flood_watch", forecast_note="rain intensifying, river at 85% capacity"),
        "Downtown": WeatherCell(zone="Downtown", lat=34.0580, lon=-118.2450, wind_kph=16, wind_direction_deg=200, precipitation_mm_h=2, temperature_c=24),
        "Industrial Park": WeatherCell(zone="Industrial Park", lat=34.0350, lon=-118.2590, wind_kph=18, wind_direction_deg=230, precipitation_mm_h=1, temperature_c=23),
        "Eastside": WeatherCell(zone="Eastside", lat=34.0520, lon=-118.2210, wind_kph=12, wind_direction_deg=190, precipitation_mm_h=3, temperature_c=25),
        "University": WeatherCell(zone="University", lat=34.0660, lon=-118.2290, wind_kph=15, wind_direction_deg=200, precipitation_mm_h=2, temperature_c=24),
    }


def _res(rid: str, rtype: ResourceType, name: str, zone: str, personnel: int, speed: float = 45.0, note: str = "") -> Resource:
    lat, lon = SECTORS[zone]
    return Resource(id=rid, type=rtype, name=name, base_lat=lat, base_lon=lon, personnel=personnel, speed_kph=speed, capacity_note=note, capable_of=[])


def build_resources() -> list[Resource]:
    return [
        _res("res_fire1", ResourceType.FIRE_UNIT, "Engine 1", "Downtown", 6, 50, "class-A pump, 1000L foam"),
        _res("res_fire2", ResourceType.FIRE_UNIT, "Engine 2", "Industrial Park", 6, 50, "wildland-capable"),
        _res("res_amb1", ResourceType.AMBULANCE, "Ambulance A1", "Downtown", 3, 55),
        _res("res_amb2", ResourceType.AMBULANCE, "Ambulance A2", "Eastside", 3, 55),
        _res("res_amb3", ResourceType.AMBULANCE, "Ambulance A3", "University", 3, 55),
        _res("res_res1", ResourceType.RESCUE_TEAM, "USAR Team 1", "Downtown", 12, 40, "heavy rescue, concrete cutting"),
        _res("res_res2", ResourceType.RESCUE_TEAM, "Rescue 2", "Eastside", 8, 40, "rope + confined space"),
        _res("res_sw1", ResourceType.SWIFT_WATER, "Swift Water 1", "Riverfront", 6, 45, "boat + 6 swimmers"),
        _res("res_eng1", ResourceType.ENGINEERING, "Engineering Squad", "Industrial Park", 10, 35, "crane + shoring"),
        _res("res_dr1", ResourceType.DRONE, "Drone D1", "Downtown", 2, 90, "thermal camera"),
        _res("res_dr2", ResourceType.DRONE, "Drone D2", "North Hills", 2, 90, "IR + zoom"),
        _res("res_haz1", ResourceType.HAZMAT_UNIT, "Hazmat 1", "Industrial Park", 8, 40),
    ]


def locate_text(text: str) -> Optional[tuple[str, float, float]]:
    """Place a free-text report in a sector by the first place-word it uses.

    Returns (zone, lat, lon) or None when the text names no known place.
    """
    low = text.lower()
    best: Optional[tuple[int, int, str]] = None   # (position, -alias length, zone)
    for zone, aliases in ZONE_ALIASES.items():
        for alias in aliases:
            m = re.search(r"\b" + re.escape(alias), low)
            if m and (best is None or (m.start(), -len(alias)) < (best[0], best[1])):
                best = (m.start(), -len(alias), zone)
    if best is None:
        return None
    lat, lon = SECTORS[best[2]]
    return best[2], lat, lon


# ---------------------------------------------------------------------------
# Scenario script: incidents seeded from the xBD dataset (hidden ground truth)
# ---------------------------------------------------------------------------

SEED_COUNT = 5            # incidents present at first paint
WAVE_COUNT = 4            # incidents the sim spawns mid-demo
WAVE_TICKS = (2, 4, 6, 8)
FOLLOWUP_TICK = 3
_SOURCE_FOR_TYPE = {
    IncidentType.FIRE: "drone",
    IncidentType.FLOOD: "radio",
    IncidentType.LANDSLIDE: "drone",
}


def _scenario_cohorts(records: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    selected = xbd.pick_seeds(records, SEED_COUNT + WAVE_COUNT, salt="scenario")
    return selected[:SEED_COUNT], selected[SEED_COUNT:SEED_COUNT + WAVE_COUNT]


class Simulator:
    """Drives the synthetic world. tick() is called by the orchestrator."""

    def __init__(self) -> None:
        self.tick_count = 0
        self._wave_index = 0
        self._scenario_seeds: list[dict[str, Any]] = []
        self._wave_seeds: list[dict[str, Any]] = []
        self._occupied: dict[str, set[str]] = {}     # incident type -> sectors already used
        self.rng = random.Random(42)
        self.weather: dict[str, WeatherCell] = initial_weather()
        self.ground_truth: dict[str, float] = {}     # incident_id -> hidden urgency

    def configure_dataset(self, records: list[dict[str, Any]]) -> None:
        """Prepare fixed, disjoint seed and wave cohorts from loaded xBD rows."""
        self._scenario_seeds, self._wave_seeds = _scenario_cohorts(records)

    def _choose_sector(self, itype: IncidentType, preferred: int) -> str:
        """A sector with no same-type seed yet, so two seeds can't geo-merge."""
        names = list(SECTORS)
        used = self._occupied.setdefault(itype.value, set())
        for offset in range(len(names)):
            name = names[(preferred + offset) % len(names)]
            if name not in used:
                used.add(name)
                return name
        return names[preferred % len(names)]

    def seed_events(self) -> list[dict[str, Any]]:
        """Initial burst of incidents as signal dicts (with ground truth attached)."""
        if not self._scenario_seeds:
            self.configure_dataset(xbd.load_seeds())
        events: list[dict[str, Any]] = []
        for i, seed in enumerate(self._scenario_seeds):
            seed["zone"] = self._choose_sector(seed["type"], i)
            zlat, zlon = SECTORS[seed["zone"]]
            events.append(self._signal_from_seed(seed, zlat, zlon))
        return events

    def tick(self) -> tuple[list[dict[str, Any]], list[str]]:
        """Advance the world. Returns (new signal dicts, event log lines)."""
        self.tick_count += 1
        log: list[str] = []
        signals: list[dict[str, Any]] = []

        # 1. Weather drift (every tick, small)
        for cell in self.weather.values():
            cell.wind_kph = max(2.0, cell.wind_kph + self.rng.uniform(-3, 3))
            if cell.alert == "flood_watch":
                cell.precipitation_mm_h = max(0.0, cell.precipitation_mm_h + self.rng.uniform(-1.5, 2.0))
        if self.tick_count == 4:
            self.weather["North Hills"].wind_kph = 52.0
            self.weather["North Hills"].forecast_note = "wind gusting to 65 kph — extreme fire behavior possible"
            log.append("⚠️ Weather: North Hills winds intensifying to 52 kph")

        # 2. New incidents from the xBD wave cohort
        if self.tick_count in WAVE_TICKS and self._wave_index < len(self._wave_seeds):
            seed = self._wave_seeds[self._wave_index]
            preferred = self._wave_index + 3
            self._wave_index += 1
            seed["zone"] = self._choose_sector(seed["type"], preferred)
            zlat, zlon = SECTORS[seed["zone"]]
            signals.append(self._signal_from_seed(
                seed, zlat + self.rng.uniform(-0.001, 0.001), zlon + self.rng.uniform(-0.001, 0.001)))
            log.append(f"📡 New incoming signal from {seed['zone']}")

        # 3. Follow-up on the worst seeded incident (folds in, must MERGE not duplicate)
        if self.tick_count == FOLLOWUP_TICK and self._scenario_seeds:
            target = max(self._scenario_seeds, key=lambda s: s.get("gt_urgency", 0))
            zlat, zlon = SECTORS[target["zone"]]
            pop = int(target.get("population", 10))
            inj = int(target.get("injuries", 0))
            signals.append({
                "source": "ground_report", "lat": zlat, "lon": zlon,
                "raw_text": (
                    f"{target['zone']} sector — update on the {_SURVEY_NAME.get(target['type'], 'damage')} incident: "
                    f"situation worsening, now roughly {max(pop + 8, int(pop * 1.5))} people affected, "
                    f"{inj + 2} injured, more casualties being reported."
                ),
                "confidence": 0.92,
                "_type_hint": target["type"].value,
            })
            log.append(f"📡 Follow-up report on {target['zone']} incident")

        return signals, log

    def _signal_from_seed(self, seed: dict[str, Any], lat: float, lon: float) -> dict[str, Any]:
        itype: IncidentType = seed["type"]
        return {
            "source": _SOURCE_FOR_TYPE.get(itype, "ground_report"),
            "lat": lat, "lon": lon,
            "raw_text": f"{seed['zone']} sector — {seed['text']}",
            "confidence": seed["confidence"],
            # Provenance: real xBD coordinates for context, hidden from agents.
            "_event": seed.get("event", ""),
            "_damage_grade": seed.get("grade"),
            "_dataset_lat": seed.get("lat"),
            "_dataset_lon": seed.get("lon"),
            # Hidden evaluation metadata — stripped before the LLM sees it
            "_ground_truth_urgency": seed["gt_urgency"],
            "_zone": seed.get("zone") or "",
            "_type_hint": itype.value,
        }

    def register_ground_truth(self, incident_id: str, urgency: float) -> None:
        self.ground_truth[incident_id] = urgency

    def nearest_zone(self, lat: float, lon: float) -> str:
        best, bestd = None, 1e9
        for zone, (zlat, zlon) in SECTORS.items():
            d = (zlat - lat) ** 2 + (zlon - lon) ** 2
            if d < bestd:
                best, bestd = zone, d
        return best or "Downtown"

    def terrain_for(self, lat: float, lon: float) -> TerrainCell:
        return TERRAIN[self.nearest_zone(lat, lon)]

    def weather_for(self, lat: float, lon: float) -> WeatherCell:
        return self.weather[self.nearest_zone(lat, lon)]


_SURVEY_NAME = {
    IncidentType.LANDSLIDE: "landslide",
    IncidentType.FLOOD: "flood",
    IncidentType.STRUCTURAL_COLLAPSE: "structural",
    IncidentType.FIRE: "fire",
}
