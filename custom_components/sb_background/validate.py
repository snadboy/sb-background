"""Can an instance run? Pure checks — no Home Assistant imports, tested offline.

ERRORS stop the instance from running (or are reported against a running one):
a required field is empty, a picked entity does not exist or is of a domain the
field does not allow, a single-entity field holds a list, or the script's mode
cannot hold all of its instances.

WARNINGS are reported but do not stop it: a picked entity is unavailable right
now, a field is no longer in the script.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

UNAVAILABLE = ("unavailable", "unknown")


def blank(v: Any) -> bool:
    return v is None or v == "" or (isinstance(v, (list, tuple, dict)) and not v)


def field_label(key: str, fdef: dict | None) -> str:
    return str((fdef or {}).get("name") or key)


def entity_selector(fdef: dict | None) -> dict | None:
    """The field's entity selector config ({} counts), or None for any other selector."""
    sel = (fdef or {}).get("selector") or {}
    if "entity" not in sel:
        return None
    return sel.get("entity") or {}


def allowed_domains(ent: dict) -> list[str]:
    """Domains an entity selector allows; [] = any. A filter entry without a domain lifts it."""
    out = list(_as_list(ent.get("domain")))
    filters = _as_list(ent.get("filter"))
    if filters and any(not (f or {}).get("domain") for f in filters):
        return []
    for f in filters:
        out += _as_list(f.get("domain"))
    return sorted(set(out))


def _as_list(v: Any) -> list:
    if v is None:
        return []
    return list(v) if isinstance(v, (list, tuple)) else [v]


def check_fields(
    field_defs: dict[str, dict],
    values: dict[str, Any],
    state_of: Callable[[str], str | None],
) -> tuple[list[str], list[str]]:
    """(errors, warnings) for one instance's field values.

    state_of(entity_id) → its state, or None when the entity does not exist.
    """
    errors: list[str] = []
    warnings: list[str] = []
    for key, fdef in field_defs.items():
        label = field_label(key, fdef)
        v = values.get(key)
        if blank(v):
            if (fdef or {}).get("required"):
                errors.append(f"“{label}” is required but empty.")
            continue
        ent = entity_selector(fdef)
        if ent is None:
            continue
        multiple = bool(ent.get("multiple"))
        if not multiple and isinstance(v, (list, tuple)):
            if len(v) == 1:
                v = v[0]
            else:
                errors.append(f"“{label}” takes one entity but holds {len(v)}.")
                continue
        ids = list(v) if isinstance(v, (list, tuple)) else [v]
        doms = allowed_domains(ent)
        for eid in ids:
            if not isinstance(eid, str) or "." not in eid:
                errors.append(f"“{label}”: {eid!r} is not an entity id.")
                continue
            if doms and eid.split(".", 1)[0] not in doms:
                errors.append(f"“{label}”: {eid} is not a {' / '.join(doms)} entity.")
                continue
            st = state_of(eid)
            if st is None:
                errors.append(f"“{label}”: {eid} does not exist.")
            elif st in UNAVAILABLE:
                warnings.append(f"“{label}”: {eid} is {st}.")
    for key in values:
        if key not in field_defs:
            warnings.append(f"Field “{key}” is no longer in the script (still passed to it).")
    return errors, warnings


def check_mode(mode: str | None, max_runs: int | None, instances: int) -> list[str]:
    """The script must be able to hold one run per enabled instance at the same time."""
    if instances <= 1 or mode is None:
        return []
    if mode != "parallel":
        return [f"The script's mode is “{mode}”, but {instances} instances use it — set mode: parallel (max ≥ {instances})."]
    if max_runs is not None and max_runs < instances:
        return [f"The script allows {max_runs} parallel runs, but {instances} instances use it — raise its max to at least {instances}."]
    return []


def next_delay(consecutive_short: int, first: int, cap: int) -> int:
    """Seconds to wait before the next run: `first` after a normal end, doubling per short run."""
    if consecutive_short <= 0:
        return first
    return min(cap, first * 2 ** consecutive_short)
