"""Offline checks for validate.py.   python3 tests/test_validate.py   (or pytest)"""

import importlib.util
import pathlib

_p = pathlib.Path(__file__).resolve().parents[1] / "custom_components" / "sb_background" / "validate.py"
_spec = importlib.util.spec_from_file_location("validate", _p)
V = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(V)

STATES = {
    "binary_sensor.kitchen_occ": "off",
    "binary_sensor.dead": "unavailable",
    "scene.dark": "2026-10-14T00:00:00",
    "light.kitchen_ceiling": "off",
    "light.kitchen_aux_sink": "on",
}
state_of = STATES.get

FIELDS = {
    "occupancy_sensors": {"name": "Occupancy sensors", "required": True,
                          "selector": {"entity": {"domain": ["binary_sensor", "input_boolean"], "multiple": True}}},
    "vacant_scene": {"name": "Vacant scene", "required": True, "selector": {"entity": {"domain": "scene"}}},
    "vacancy_minutes": {"name": "Vacancy time", "required": True, "selector": {"number": {"min": 1}}},
    "occupied_scene": {"name": "Occupied scene", "selector": {"entity": {"domain": "scene"}}},
    "lights": {"name": "Lights", "selector": {"entity": {"multiple": True}}},
    "free": {"name": "No selector"},
}

GOOD = {
    "occupancy_sensors": ["binary_sensor.kitchen_occ"],
    "vacant_scene": "scene.dark",
    "vacancy_minutes": 10,
    "lights": ["light.kitchen_ceiling", "light.kitchen_aux_sink"],
}


def test_good():
    assert V.check_fields(FIELDS, GOOD, state_of) == ([], [])


def test_required_empty():
    e, _ = V.check_fields(FIELDS, {**GOOD, "vacant_scene": "", "occupancy_sensors": []}, state_of)
    assert e == ["“Occupancy sensors” is required but empty.", "“Vacant scene” is required but empty."], e


def test_optional_empty_is_fine():
    assert V.check_fields(FIELDS, {**GOOD, "occupied_scene": None}, state_of) == ([], [])


def test_missing_entity_and_wrong_domain():
    e, _ = V.check_fields(FIELDS, {**GOOD, "vacant_scene": "light.kitchen_ceiling",
                                   "occupancy_sensors": ["binary_sensor.gone"]}, state_of)
    assert e == ["“Occupancy sensors”: binary_sensor.gone does not exist.",
                 "“Vacant scene”: light.kitchen_ceiling is not a scene entity."], e


def test_unavailable_is_a_warning():
    e, w = V.check_fields(FIELDS, {**GOOD, "occupancy_sensors": ["binary_sensor.dead"]}, state_of)
    assert e == [] and w == ["“Occupancy sensors”: binary_sensor.dead is unavailable."], (e, w)


def test_single_field_with_list():
    e, _ = V.check_fields(FIELDS, {**GOOD, "vacant_scene": ["scene.dark"]}, state_of)
    assert e == [], e          # a one-item list is accepted for a single field
    e, _ = V.check_fields(FIELDS, {**GOOD, "vacant_scene": ["scene.dark", "scene.dark"]}, state_of)
    assert e == ["“Vacant scene” takes one entity but holds 2."], e


def test_multiple_field_with_string():
    assert V.check_fields(FIELDS, {**GOOD, "lights": "light.kitchen_ceiling"}, state_of) == ([], [])


def test_unknown_field_is_a_warning():
    _, w = V.check_fields(FIELDS, {**GOOD, "old_field": 1}, state_of)
    assert w == ["Field “old_field” is no longer in the script (still passed to it)."], w


def test_label_falls_back_to_key():
    e, _ = V.check_fields({"x": {"required": True}}, {}, state_of)
    assert e == ["“x” is required but empty."], e


def test_domains_from_filter():
    assert V.allowed_domains({"filter": [{"domain": "light"}, {"domain": ["switch"]}]}) == ["light", "switch"]
    assert V.allowed_domains({"filter": [{"domain": "light"}, {"integration": "hue"}]}) == []
    assert V.allowed_domains({}) == []


def test_mode():
    assert V.check_mode("single", None, 1) == []
    assert V.check_mode("single", None, 2)[0].startswith("The script's mode is “single”")
    assert V.check_mode("parallel", 10, 3) == []
    assert V.check_mode("parallel", 2, 3)[0].startswith("The script allows 2 parallel runs")


def test_backoff():
    assert [V.next_delay(n, 2, 300) for n in range(0, 10)] == [2, 4, 8, 16, 32, 64, 128, 256, 300, 300]


if __name__ == "__main__":
    n = 0
    for name, fn in list(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            n += 1
    print(f"{n} checks passed")
