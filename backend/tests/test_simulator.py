from missionsync import simulator as sim
from missionsync import xbd
from missionsync.models import IncidentType


def test_locate_text_places_reports_by_the_first_place_word() -> None:
    assert sim.locate_text("fire spreading near the University lab block")[0] == "University"
    assert sim.locate_text("Ammonia vapor cloud at Industrial Park gate 3")[0] == "Industrial Park"
    assert sim.locate_text("Missing child near the Riverfront levee")[0] == "Riverfront"
    assert sim.locate_text("Second collapse report from Downtown: storefront awning gave way")[0] == "Downtown"
    zone, lat, lon = sim.locate_text("brush fire on the North Hills ridge")
    assert (lat, lon) == sim.SECTORS[zone] and zone == "North Hills"
    assert sim.locate_text("smoke from Building C, two people coughing") is None
    assert sim.locate_text("") is None


def _sim_with_snapshot():
    s = sim.Simulator()
    s.configure_dataset(xbd.load_snapshot())
    return s


def test_seeds_land_in_distinct_sectors_per_type_and_carry_their_zone_in_the_text() -> None:
    s = _sim_with_snapshot()
    events = s.seed_events()
    assert len(events) == sim.SEED_COUNT
    seen = set()
    for ev in events:
        zone = next(z for z, (lat, lon) in sim.SECTORS.items() if (lat, lon) == (ev["lat"], ev["lon"]))
        assert ev["raw_text"].startswith(f"{zone} sector")                       # text and map agree
        assert (ev["_type_hint"], zone) not in seen                              # can't geo-merge with a twin
        seen.add((ev["_type_hint"], zone))
        assert ev["_ground_truth_urgency"] is not None


def test_waves_and_followup_arrive_on_schedule_and_follow_up_targets_a_real_incident() -> None:
    s = _sim_with_snapshot()
    seeds = s.seed_events()
    arrivals = {}
    for _ in range(10):
        signals, _log = s.tick()
        arrivals[s.tick_count] = signals
    assert [t for t, sigs in arrivals.items() if any("_ground_truth_urgency" in x for x in sigs)] == list(sim.WAVE_TICKS)
    followup = [x for x in arrivals[sim.FOLLOWUP_TICK] if "_ground_truth_urgency" not in x][0]
    worst = max(seeds, key=lambda e: e["_ground_truth_urgency"])
    assert (followup["lat"], followup["lon"]) == (worst["lat"], worst["lon"])
    assert followup["_type_hint"] == worst["_type_hint"] and "update" in followup["raw_text"].lower()


def test_weather_is_owned_per_simulator_and_drifts_deterministically() -> None:
    a, b = sim.Simulator(), sim.Simulator()
    for _ in range(4):
        a.tick(), b.tick()
    assert a.weather["North Hills"].wind_kph == 52.0
    assert a.weather["Downtown"].wind_kph == b.weather["Downtown"].wind_kph        # seeded RNG
    assert sim.Simulator().weather["North Hills"].wind_kph == 38                    # not shared / not leaked


def test_build_resources_inventory() -> None:
    res = sim.build_resources()
    assert len(res) == 12 and len({r.id for r in res}) == 12
    assert {r.type.value for r in res} == {"fire_unit", "ambulance", "rescue_team", "swift_water",
                                            "engineering", "drone", "hazmat_unit"}
    assert IncidentType.FIRE in IncidentType
