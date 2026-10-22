"""SB Background — keep script instances running, and say when they are not.

An INSTANCE is a script + the values for its fields. Each instance is a config entry
with a device page: Status (sensor), Problem (binary sensor), Enabled (switch) and
Restart (button). The integration is only the bookkeeper: what an instance does is
entirely its script, which is an ordinary HA script you edit as usual.

The card (custom:sb-background-card) and the sidebar page (/sb-background) are one
JS module served by this integration and loaded on every page, so there is no
separate card repo or Lovelace resource to keep in step.
"""

from __future__ import annotations

import logging
from pathlib import Path

from homeassistant.components import panel_custom
from homeassistant.components.frontend import add_extra_js_url
from homeassistant.components.http import StaticPathConfig
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import EVENT_HOMEASSISTANT_STARTED, Platform
from homeassistant.core import CoreState, HassJob, HomeAssistant, callback
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers import issue_registry as ir
from homeassistant.helpers.event import async_call_later
from homeassistant.helpers.storage import Store
from homeassistant.helpers.typing import ConfigType
from homeassistant.loader import async_get_integration

from . import websocket
from .alerts import Alerts, issue_id
from .const import (
    CONF_NAME, DEFAULT_NOTIFY, DOMAIN, PANEL_URL, SETTINGS_KEY, SETTINGS_VERSION, STARTUP_SETTLE_SECONDS, STATIC_URL,
)
from .supervisor import InstanceSupervisor

_LOGGER = logging.getLogger(__name__)
PLATFORMS = [Platform.SENSOR, Platform.BINARY_SENSOR, Platform.SWITCH, Platform.BUTTON]
# `sb_background:` in configuration.yaml (no options) loads the integration — the card, the
# sidebar page and "+ Add" — even with no instances: a config-flow integration with no
# entries is otherwise never set up, and the card shows "Configuration error" (2026-10-21).
CONFIG_SCHEMA = cv.empty_config_schema(DOMAIN)


async def async_setup(hass: HomeAssistant, config: ConfigType) -> bool:
    integration = await async_get_integration(hass, DOMAIN)
    version = str(integration.version) if integration.version else "0"
    store = Store(hass, SETTINGS_VERSION, SETTINGS_KEY)
    settings = await store.async_load() or {"notify_service": DEFAULT_NOTIFY, "persistent": True}
    hass.data[DOMAIN] = {"version": version, "store": store, "settings": settings, "instances": {}}
    websocket.async_register(hass)
    try:
        await hass.http.async_register_static_paths(
            [StaticPathConfig(STATIC_URL, str(Path(__file__).parent / "frontend"), False)])
        url = f"{STATIC_URL}/sb-background.js?v={version}"
        add_extra_js_url(hass, url)          # the card, on every dashboard
        if PANEL_URL not in hass.data.get("frontend_panels", {}):
            await panel_custom.async_register_panel(
                hass, frontend_url_path=PANEL_URL, webcomponent_name="sb-background-panel",
                sidebar_title="SB Background", sidebar_icon="mdi:cog-play-outline", module_url=url,
                embed_iframe=False, require_admin=True)
    except Exception:  # noqa: BLE001 — the UI is a convenience; the instances must run without it
        _LOGGER.exception("SB Background: could not register the card / sidebar page")
    return True


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    sup = InstanceSupervisor(hass, entry, lambda: hass.data[DOMAIN]["settings"])
    entry.runtime_data = sup
    hass.data[DOMAIN]["instances"][entry.entry_id] = sup
    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)

    # On a cold start the scripts and the entities in the fields are still loading:
    # start once HA is up plus a settle period (the Status reads "waiting" meanwhile).
    if hass.state is CoreState.running:
        sup.start()
    else:
        fired = False

        @callback
        def _settled(_now) -> None:
            sup.start()

        @callback
        def _started(_event) -> None:
            nonlocal fired
            fired = True
            entry.async_on_unload(async_call_later(hass, STARTUP_SETTLE_SECONDS, HassJob(_settled, cancel_on_shutdown=True)))

        unsub = hass.bus.async_listen_once(EVENT_HOMEASSISTANT_STARTED, _started)
        entry.async_on_unload(lambda: None if fired else unsub())

    entry.async_on_unload(entry.add_update_listener(_options_updated))
    _wake_others(hass, entry.entry_id)
    return True


@callback
def _wake_others(hass: HomeAssistant, entry_id: str) -> None:
    """Instance counts per script changed: let invalid siblings re-check now (mode errors)."""
    for eid, sup in hass.data[DOMAIN]["instances"].items():
        if eid != entry_id:
            sup.wake()


async def _options_updated(hass: HomeAssistant, entry: ConfigEntry) -> None:
    await hass.config_entries.async_reload(entry.entry_id)


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    sup: InstanceSupervisor = entry.runtime_data
    await sup.stop()
    hass.data[DOMAIN]["instances"].pop(entry.entry_id, None)
    ok = await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
    _wake_others(hass, entry.entry_id)
    return ok


async def async_remove_entry(hass: HomeAssistant, entry: ConfigEntry) -> None:
    """Deleted (not reloaded): take its Repairs issue and push down with it."""
    ir.async_delete_issue(hass, DOMAIN, issue_id(entry.entry_id))
    Alerts(hass, entry.entry_id, entry.options.get(CONF_NAME, entry.title), lambda: hass.data[DOMAIN]["settings"]).clear()
