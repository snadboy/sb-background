"""Telling the user an instance is not running: a Repairs issue and a phone push.

Both wait ALERT_GRACE_SECONDS, so a boot race (an entity whose integration is still
loading) or one quick restart does not page anyone. The push is replace-in-place
(tag sb_background_<entry_id>) and is cleared when the instance recovers; so is the
Repairs issue.
"""

from __future__ import annotations

import logging
from collections.abc import Callable

from homeassistant.core import CALLBACK_TYPE, HassJob, HomeAssistant, callback
from homeassistant.helpers import issue_registry as ir
from homeassistant.helpers.event import async_call_later

from .const import ALERT_GRACE_SECONDS, DOMAIN, PANEL_URL

_LOGGER = logging.getLogger(__name__)


def issue_id(entry_id: str) -> str:
    return f"instance_{entry_id}"


class Alerts:
    def __init__(self, hass: HomeAssistant, entry_id: str, name: str, settings: Callable[[], dict]) -> None:
        self.hass = hass
        self.entry_id = entry_id
        self.name = name
        self._settings = settings
        self._pending: CALLBACK_TYPE | None = None
        self._raised = False
        self._reason = ""

    @callback
    def update(self, problem: bool, reason: str) -> None:
        self._reason = reason
        if problem:
            if self._raised:
                self._issue()              # keep the Repairs text current; ONE push per episode
            elif self._pending is None:
                self._pending = async_call_later(self.hass, ALERT_GRACE_SECONDS, HassJob(self._grace_over, cancel_on_shutdown=True))
            return
        self.cancel()
        if self._raised:
            self._raised = False
            self.clear()

    @callback
    def cancel(self) -> None:
        if self._pending is not None:
            self._pending()
            self._pending = None

    @callback
    def _grace_over(self, _now=None) -> None:
        self._pending = None
        self._raised = True
        self._raise()

    @callback
    def _raise(self) -> None:
        self._issue()
        self._push(self._reason or "Not running.")

    @callback
    def _issue(self) -> None:
        ir.async_create_issue(
            self.hass, DOMAIN, issue_id(self.entry_id), is_fixable=False, is_persistent=False,
            severity=ir.IssueSeverity.WARNING, translation_key="instance_problem",
            translation_placeholders={"name": self.name, "reason": self._reason or "—"},
            learn_more_url=f"/{PANEL_URL}",
        )

    @callback
    def clear(self) -> None:
        ir.async_delete_issue(self.hass, DOMAIN, issue_id(self.entry_id))
        svc = self._service()
        if svc and svc.startswith("mobile_app_"):
            self._call(svc, {"message": "clear_notification", "data": {"tag": self._tag()}})

    def _tag(self) -> str:
        return f"sb_background_{self.entry_id}"

    def _service(self) -> str | None:
        svc = (self._settings() or {}).get("notify_service") or ""
        if not svc.startswith("notify."):
            return None
        svc = svc.split(".", 1)[1]
        return svc if self.hass.services.has_service("notify", svc) else None

    @callback
    def _push(self, message: str) -> None:
        svc = self._service()
        if not svc:
            return
        self._call(svc, {
            "title": f"SB Background: {self.name} needs attention",
            "message": message,
            "data": {"tag": self._tag(), "alert_once": True, "clickAction": f"/{PANEL_URL}", "url": f"/{PANEL_URL}"},
        })

    @callback
    def _call(self, service: str, data: dict) -> None:
        async def _go() -> None:
            try:
                await self.hass.services.async_call("notify", service, data, blocking=True)
            except Exception:  # noqa: BLE001 — an alert that cannot be sent must not break the instance
                _LOGGER.exception("SB Background: could not notify via notify.%s", service)

        self.hass.async_create_task(_go(), f"sb_background notify {self.name}")
