"""Synthetic disaster-response simulator.

Generates the operational picture: sectors with terrain, moving weather
cells, a resource inventory, and a stream of incidents/signals with *hidden
ground-truth urgency* so we can measure ranking accuracy honestly.

Incident scenarios are sourced from the xBD damage-assessment dataset
(``rayanhossain239/damageactu-xbd-full`` on Kaggle, loaded via kagglehub —
see ``xbd.py``), not hand-written: each seeded incident carries a real damage
grade from the dataset, converted to hidden ground-truth urgency.

The judge stress test injects extra signals via the API — the simulator
doesn't need to restart, and neither does the orchestrator.
"""
from __future__ import annotations

import random
from typing import Any, Optional

from . import xbd
from .models import (
    DroneFrame,
    Resource,
    ResourceType,
    TerrainCell,
    WeatherCell,
)

random.seed(42)

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

TERRAIN: dict[str, TerrainCell] = {
    "Downtown": TerrainCell(zone="Downtown", lat=34.0580, lon=-118.2450, elevation_m=85, slope_deg=2, landcover="urban", road_access="good", notes="dense high-rise, narrow alleys"),
    "Riverfront": TerrainCell(zone="Riverfront", lat=34.0430, lon=-118.2380, elevation_m=42, slope_deg=3, landcover="water", road_access="degraded", notes="river levee, flood-prone low ground"),
    "North Hills": TerrainCell(zone="North Hills", lat=34.0740, lon=-118.2550, elevation_m=310, slope_deg=18, landcover="forest", road_access="degraded", notes="single access road, dry brush"),
    "Industrial Park": TerrainCell(zone="Industrial Park", lat=34.0350, lon=-118.2590, elevation_m=55, slope_deg=1, landcover="industrial", road_access="good", notes="chemical storage depots, rail spur"),
    "Eastside": TerrainCell(zone="Eastside", lat=34.0520, lon=-118.2210, elevation_m=70, slope_deg=4, landcover="suburban", road_access="good", notes="schools and care homes in grid"),
    "University": TerrainCell(zone="University", lat=34.0660, lon=-118.2290, elevation_m=95, slope_deg=6, landcover="urban", road_access="good", notes="high daytime population, labs on campus"),
}

WEATHER: dict[str, WeatherCell] = {
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

# ---------------------------------------------------------------------------
# Scenario script: incidents seeded from the xBD dataset (hidden ground truth)
# ---------------------------------------------------------------------------

SEED_COUNT = 5    # incidents present at first paint
WAVE_COUNT = 5    # incidents the sim spawns mid-demo


def scenario_seeds() -> list[dict[str, Any]]:
    """Initial incident seeds drawn deterministically from the xBD dataset."""
    return xbd.pick_seeds(xbd.load_seeds(), SEED_COUNT, salt="seed")


def _wave_pool() -> list[dict[str, Any]]:
    """Later-wave seeds: a disjoint deterministic sample of the same dataset."""
    return xbd.pick_seeds(xbd.load_seeds(), WAVE_COUNT, salt="wave")


class Simulator:
    """Drives the synthetic world. tick() is called by the orchestrator."""

    def __init__(self) -> None:
        self.tick_count = 0
        self._wave_index = 0
        self._wave_seeds = _wave_pool()
        self.ground_truth: dict[str, float] = {}   # incident_id -> hidden urgency

    def seed_events(self) -> list[dict[str, Any]]:
        """Initial burst of incidents as signal dicts (with ground truth attached)."""
        events: list[dict[str, Any]] = []
        sector_names = list(SECTORS)
        for i, seed in enumerate(scenario_seeds()):
            # Dataset rows carry no zone; pin each seed to its own fictional
            # sector (cyclically) so same-type seeds can't geographically merge
            # and the demo picture spreads across the city.
            seed["zone"] = sector_names[i % len(sector_names)]
            zlat, zlon = SECTORS[seed["zone"]]
            # Exact sector centers: they are ≥1.7 km apart, so the 1.5 km
            # duplicate-merge guard can never collapse two seeds into one.
            events.append(self._signal_from_seed(seed, zlat, zlon, delay_s=0))
        return events

    def tick(self) -> tuple[list[dict[str, Any]], list[str]]:
        """Advance the world. Returns (new signal dicts, event log lines)."""
        self.tick_count += 1
        log: list[str] = []
        signals: list[dict[str, Any]] = []

        # 1. Weather drift (every tick, small)
        for cell in WEATHER.values():
            cell.wind_kph = max(2.0, cell.wind_kph + random.uniform(-3, 3))
            if cell.alert == "flood_watch":
                cell.precipitation_mm_h = max(0.0, cell.precipitation_mm_h + random.uniform(-1.5, 2.0))
        if self.tick_count == 4:
            WEATHER["North Hills"].wind_kph = 52.0
            WEATHER["North Hills"].forecast_note = "wind gusting to 65 kph — extreme fire behavior possible"
            log.append("⚠️ Weather: North Hills winds intensifying to 52 kph")

        # 2. New incidents from the xBD wave cohort
        if self.tick_count in (2, 3, 5) and self._wave_index < len(self._wave_seeds):
            seed = self._wave_seeds[self._wave_index]
            self._wave_index += 1
            # Offset cycle: same-type wave seeds always land in distinct sectors.
            sector_names = list(SECTORS)
            seed["zone"] = sector_names[(self._wave_index + 3) % len(sector_names)]
            zlat, zlon = SECTORS[seed["zone"]]
            signals.append(self._signal_from_seed(seed, zlat + random.uniform(-0.001, 0.001), zlon + random.uniform(-0.001, 0.001)))
            log.append(f"📡 New incoming signal from {seed['zone']}")

        # 3. Occasional follow-up on existing incidents (fold-in signals, no new incident)
        if self.tick_count == 3:
            signals.append({
                "source": "ground_report", "lat": SECTORS["Downtown"][0], "lon": SECTORS["Downtown"][1],
                "raw_text": "Update on Downtown scaffolding collapse: third victim located, now four workers trapped, one unconscious.",
                "confidence": 0.92,
            })
            log.append("📡 Follow-up report on Downtown collapse")

        return signals, log

    def _signal_from_seed(
        self, seed: dict[str, Any], lat: float, lon: float, delay_s: int = 0
    ) -> dict[str, Any]:
        sig: dict[str, Any] = {
            "source": "drone" if "drone" in seed["text"].lower() else ("radio" if "radio" in seed["text"].lower() else "ground_report"),
            "lat": lat, "lon": lon,
            "raw_text": seed["text"],
            "confidence": seed["confidence"],
            # Provenance: real xBD coordinates for context, hidden from agents.
            "_event": seed.get("event", ""),
            "_damage_grade": seed.get("grade"),
            "_dataset_lat": seed.get("lat"),
            "_dataset_lon": seed.get("lon"),
            # Hidden evaluation metadata — stripped before the LLM sees it
            "_ground_truth_urgency": seed["gt_urgency"],
            "_zone": seed.get("zone") or "",
            "_type_hint": seed["type"].value,
        }
        return sig

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
        return WEATHER[self.nearest_zone(lat, lon)]

    def drone_frames(self) -> list[DroneFrame]:
        frames = []
        for i, (zone, (lat, lon)) in enumerate(SECTORS.items()):
            frames.append(DroneFrame(
                drone_id=f"D{(i % 2) + 1}",
                lat=lat + random.uniform(-0.004, 0.004),
                lon=lon + random.uniform(-0.004, 0.004),
                heading_deg=random.uniform(0, 360),
                battery=max(0.35, 1.0 - self.tick_count * 0.03),
                caption=f"Circling {zone}: nominal",
            ))
        return frames
