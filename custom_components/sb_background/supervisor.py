"""One instance = one script + its field values, kept running.

The run is a BLOCKING call of `script.<unique_id>` made inside this instance's own
task, so the task lives exactly as long as the run (verified in HA 2026.10 source):

- the run ends normally   → the call returns (sequence finished, a top-level
                             condition failed, someone ran script.turn_off, the
                             script was reloaded or deleted)
- the run raises          → the call raises with the run's error
- the script refuses it   → the call returns at once (mode single already running,
                             max runs reached) — caught by check_mode up front, and
                             otherwise looks like a very short run
- we cancel our task      → helpers/script.py stops THAT run only (asyncio.shield +
                             run.async_stop), never the other instances of the script

A background script is meant to run forever, so every end is restarted: after 2 s,
doubling for each run in a row that lasted less than SHORT_RUN_SECONDS, capped at
5 min. Three short runs in a row = "failing" (still retried). An instance that cannot
run at all (script missing, required field empty, entity gone…) is "invalid" and is
checked again every 30 s.
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import Callable
from datetime import datetime, timedelta
from typing import Any

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import CALLBACK_TYPE, Context, HassJob, HomeAssistant, callback
from homeassistant.helpers import entity_registry as er
from homeassistant.helpers.event import async_call_later, async_track_time_interval
from homeassistant.util import dt as dt_util

from .alerts import Alerts
from .const import (
    BACKOFF_FIRST, BACKOFF_MAX, CHECK_SECONDS, CONF_ENABLED, CONF_FIELDS, CONF_NAME, CONF_SCRIPT, DOMAIN,
    FAILING_AFTER, PROBLEM_STATUSES, REVALIDATE_SECONDS, SHORT_RUN_SECONDS,
    ST_FAILING, ST_INVALID, ST_RESTARTING, ST_RUNNING, ST_STOPPED, ST_WAITING,
)
from .validate import check_fields, check_mode, next_delay

_LOGGER = logging.getLogger(__name__)


def plain(v: Any) -> Any:
    """Field definitions as JSON-safe plain data (selectors may be objects)."""
    if hasattr(v, "serialize") and callable(v.serialize):
        try:
            return plain(v.serialize().get("selector", v.serialize()))
        except Exception:  # noqa: BLE001
            return str(v)
    if isinstance(v, dict):
        return {str(k): plain(x) for k, x in v.items()}
    if isinstance(v, (list, tuple)):
        return [plain(x) for x in v]
    if v is None or isinstance(v, (str, int, float, bool)):
        return v
    return str(v)


def script_entity(hass: HomeAssistant, entity_id: str):
    component = hass.data.get("script")
    if component is None or not entity_id:
        return None
    try:
        return component.get_entity(entity_id)
    except Exception:  # noqa: BLE001
        return None


def script_fields(hass: HomeAssistant, entity_id: str) -> dict[str, dict] | None:
    ent = script_entity(hass, entity_id)
    if ent is None:
        return None
    return plain(dict(getattr(ent, "fields", None) or {}))


def state_lookup(hass: HomeAssistant) -> Callable[[str], str | None]:
    """state_of() for validate.check_fields: a registered entity with no state yet
    (its integration still loading, or disabled) reads 'unavailable', not missing."""
    reg = er.async_get(hass)

    def state_of(eid: str) -> str | None:
        if (st := hass.states.get(eid)) is not None:
            return st.state
        if (e := reg.async_get(eid)) is not None:
            return "unavailable" if not e.disabled_by else None
        return None

    return state_of


def enabled_instances_of(hass: HomeAssistant, script: str) -> int:
    return sum(1 for e in hass.config_entries.async_entries(DOMAIN)
               if e.options.get(CONF_SCRIPT) == script and e.options.get(CONF_ENABLED, True))


class InstanceSupervisor:
    def __init__(self, hass: HomeAssistant, entry: ConfigEntry, settings: Callable[[], dict]) -> None:
        o = entry.options
        self.hass = hass
        self.entry = entry
        self.name: str = o.get(CONF_NAME) or entry.title
        self.script: str = o.get(CONF_SCRIPT, "")
        self.fields: dict[str, Any] = dict(o.get(CONF_FIELDS) or {})
        self.enabled: bool = o.get(CONF_ENABLED, True)
        self.status = ST_WAITING if self.enabled else ST_STOPPED
        self.errors: list[str] = []
        self.warnings: list[str] = []
        self.runs = 0
        self.consecutive_short = 0
        self.last_start: datetime | None = None
        self.last_end: datetime | None = None
        self.last_end_reason: str | None = None
        self.last_error: str | None = None
        self.next_start: datetime | None = None
        self._run_t0: float | None = None
        self._task: asyncio.Task | None = None
        self._wake = asyncio.Event()
        self._listeners: list[Callable[[], None]] = []
        self._unsubs: list[CALLBACK_TYPE] = []
        self._settled_unsub: CALLBACK_TYPE | None = None
        self.alerts = Alerts(hass, entry.entry_id, self.name, settings)

    # ---- listeners ---------------------------------------------------------------
    def add_listener(self, cb: Callable[[], None]) -> CALLBACK_TYPE:
        self._listeners.append(cb)
        return lambda: self._listeners.remove(cb) if cb in self._listeners else None

    @callback
    def _changed(self) -> None:
        for cb in list(self._listeners):
            cb()
        self.alerts.update(self.problem, self.reason)

    @property
    def problem(self) -> bool:
        return self.status in PROBLEM_STATUSES or bool(self.errors)

    @property
    def reason(self) -> str:
        if self.status == ST_INVALID or self.errors:
            return " ".join(self.errors) or "Cannot run."
        if self.status == ST_FAILING:
            why = f" Last error: {self.last_error}" if self.last_end_reason == "error" and self.last_error else ""
            return f"{self.consecutive_short} runs in a row ended within {SHORT_RUN_SECONDS} s; retrying with back-off.{why}"
        return ""

    def snapshot(self) -> dict[str, Any]:
        iso = lambda d: d.isoformat() if d else None  # noqa: E731
        st = self.hass.states.get(self.script)
        return {
            "sb_background": True,
            "entry_id": self.entry.entry_id,
            "instance": self.name,
            "script": self.script,
            "script_name": st.attributes.get("friendly_name") if st else None,
            "fields": self.fields,
            "enabled": self.enabled,
            "errors": self.errors,
            "warnings": self.warnings,
            "runs": self.runs,
            "consecutive_short": self.consecutive_short,
            "running_since": iso(self.last_start) if self.status in (ST_RUNNING, ST_FAILING) and self._run_t0 is not None else None,
            "last_start": iso(self.last_start),
            "last_end": iso(self.last_end),
            "last_end_reason": self.last_end_reason,
            "last_error": self.last_error,
            "next_start": iso(self.next_start) if self.status in (ST_RESTARTING, ST_FAILING, ST_INVALID) and self._run_t0 is None else None,
        }

    # ---- checks --------------------------------------------------------------------
    def check(self) -> tuple[list[str], list[str]]:
        defs = script_fields(self.hass, self.script)
        if defs is None:
            return [f"Script {self.script} does not exist (or has not loaded)."], []
        errors, warnings = check_fields(defs, self.fields, state_lookup(self.hass))
        st = self.hass.states.get(self.script)
        if st is not None:
            errors += check_mode(st.attributes.get("mode"), st.attributes.get("max"), enabled_instances_of(self.hass, self.script))
        return errors, warnings

    @callback
    def _periodic(self, _now=None) -> None:
        if self.status == ST_STOPPED:
            return
        self.errors, self.warnings = self.check()
        self._changed()

    # ---- lifecycle -----------------------------------------------------------------
    @callback
    def start(self) -> None:
        if not self.enabled:
            self.status = ST_STOPPED
            self._changed()
            return
        if self._task is None or self._task.done():
            self._task = self.entry.async_create_background_task(
                self.hass, self._main(), f"sb_background {self.name}")
        if not self._unsubs:
            self._unsubs.append(async_track_time_interval(self.hass, self._periodic, timedelta(seconds=CHECK_SECONDS)))

    async def stop(self) -> None:
        for u in self._unsubs:
            u()
        self._unsubs.clear()
        if self._settled_unsub:
            self._settled_unsub()
            self._settled_unsub = None
        if self._task and not self._task.done():
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            except Exception:  # noqa: BLE001
                _LOGGER.exception("SB Background: %s ended badly while stopping", self.name)
        self._task = None
        self.alerts.cancel()

    async def restart_now(self) -> None:
        """The Restart button: stop this run (only this one) and start again at once."""
        if not self.enabled:
            return
        self.consecutive_short = 0
        if self._task and not self._task.done():
            self._task.cancel()
            try:
                await self._task
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass
        self._task = None
        self.start()

    async def _sleep(self, seconds: float) -> None:
        self._wake.clear()
        try:
            await asyncio.wait_for(self._wake.wait(), timeout=seconds)
        except TimeoutError:
            pass

    @callback
    def wake(self) -> None:
        self._wake.set()

    @callback
    def _settled(self, _now=None) -> None:
        """A run has lasted SHORT_RUN_SECONDS: it is healthy, whatever came before."""
        self._settled_unsub = None
        if self._run_t0 is not None:
            self.consecutive_short = 0
            self.status = ST_RUNNING
            self._changed()

    async def _main(self) -> None:
        while True:
            self.errors, self.warnings = self.check()
            if self.errors:
                self.status = ST_INVALID
                self.next_start = dt_util.utcnow() + timedelta(seconds=REVALIDATE_SECONDS)
                self._changed()
                await self._sleep(REVALIDATE_SECONDS)
                continue
            ent = script_entity(self.hass, self.script)
            service = ent.unique_id if ent is not None else None
            if not service or not self.hass.services.has_service("script", service):
                self.errors = [f"Script {self.script} has no action to call (reloading?)."]
                self.status = ST_INVALID
                self._changed()
                await self._sleep(5)
                continue

            self.runs += 1
            self.last_start = dt_util.utcnow()
            self.next_start = None
            self._run_t0 = time.monotonic()
            self.status = ST_FAILING if self.consecutive_short >= FAILING_AFTER else ST_RUNNING
            self._settled_unsub = async_call_later(self.hass, SHORT_RUN_SECONDS, HassJob(self._settled, cancel_on_shutdown=True))
            self._changed()
            _LOGGER.info("SB Background: starting %s (%s, run %d)", self.name, self.script, self.runs)

            reason, err = "ended", None
            try:
                await self.hass.services.async_call(
                    "script", service, dict(self.fields), blocking=True, context=Context())
            except asyncio.CancelledError:
                self._run_t0 = None
                raise
            except Exception as ex:  # noqa: BLE001 — anything the run raises is the report
                reason, err = "error", (str(ex) or type(ex).__name__)
            finally:
                if self._settled_unsub:
                    self._settled_unsub()
                    self._settled_unsub = None

            lasted = time.monotonic() - (self._run_t0 or time.monotonic())
            self._run_t0 = None
            if self.hass.is_stopping:
                return
            self.last_end = dt_util.utcnow()
            self.last_end_reason = reason
            if err:
                self.last_error = err
            self.consecutive_short = self.consecutive_short + 1 if lasted < SHORT_RUN_SECONDS else 0
            delay = next_delay(self.consecutive_short, BACKOFF_FIRST, BACKOFF_MAX)
            self.next_start = dt_util.utcnow() + timedelta(seconds=delay)
            self.status = ST_FAILING if self.consecutive_short >= FAILING_AFTER else ST_RESTARTING
            log = _LOGGER.warning if (err or self.consecutive_short) else _LOGGER.info
            log("SB Background: %s %s after %.0f s%s; next run in %d s", self.name,
                "failed" if err else "ended", lasted, f": {err}" if err else "", delay)
            self._changed()
            await self._sleep(delay)
