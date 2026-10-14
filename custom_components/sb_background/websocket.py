"""WebSocket API for the card and the sidebar panel (admins only for writes).

  sb_background/script_fields {script}                       → the script's fields, mode, max
  sb_background/check   {script, fields, entry_id?}          → errors / warnings, as the instance would see them
  sb_background/save    {entry_id?, name, script, fields, enabled?}
                                                             → creates (no entry_id) or updates an instance;
                                                               refused while there are errors
  sb_background/delete  {entry_id}
  sb_background/settings {notify_service?, persistent?}      → the settings (set when given)

Instances themselves are read from the Status sensors' attributes (`sb_background: true`),
so the card updates live with no subscription of its own.
"""

from __future__ import annotations

from typing import Any

import voluptuous as vol

from homeassistant.components import websocket_api
from homeassistant.config_entries import SOURCE_IMPORT
from homeassistant.core import HomeAssistant, callback

from .const import CONF_ENABLED, CONF_FIELDS, CONF_NAME, CONF_SCRIPT, DOMAIN
from .supervisor import enabled_instances_of, script_entity, script_fields, state_lookup
from .validate import blank, check_fields, check_mode


def _check(hass: HomeAssistant, script: str, fields: dict, entry_id: str | None, enabled: bool = True) -> dict:
    defs = script_fields(hass, script)
    if defs is None:
        return {"errors": [f"Script {script} does not exist."], "warnings": []}
    errors, warnings = check_fields(defs, fields, state_lookup(hass))
    st = hass.states.get(script)
    if st is not None and enabled:
        # count this instance as using the script, whether it is new or moving to it
        others = enabled_instances_of(hass, script)
        if entry_id:
            e = hass.config_entries.async_get_entry(entry_id)
            if e and e.options.get(CONF_SCRIPT) == script and e.options.get(CONF_ENABLED, True):
                others -= 1
        errors += check_mode(st.attributes.get("mode"), st.attributes.get("max"), others + 1)
    return {"errors": errors, "warnings": warnings}


@websocket_api.websocket_command({vol.Required("type"): "sb_background/script_fields", vol.Required("script"): str})
@callback
def ws_script_fields(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict) -> None:
    defs = script_fields(hass, msg["script"])
    if defs is None:
        connection.send_error(msg["id"], "not_found", f"Script {msg['script']} does not exist.")
        return
    st = hass.states.get(msg["script"])
    connection.send_result(msg["id"], {
        "script": msg["script"],
        "name": st.name if st else msg["script"],
        "mode": st.attributes.get("mode") if st else None,
        "max": st.attributes.get("max") if st else None,
        "fields": [{"key": k, **(v or {})} for k, v in defs.items()],
    })


@websocket_api.websocket_command({vol.Required("type"): "sb_background/check", vol.Required("script"): str,
                                  vol.Optional("fields", default={}): dict, vol.Optional("entry_id"): str,
                                  vol.Optional("enabled", default=True): bool})
@callback
def ws_check(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict) -> None:
    connection.send_result(msg["id"], _check(hass, msg["script"], _clean(msg["fields"]), msg.get("entry_id"), msg["enabled"]))


def _clean(fields: dict[str, Any]) -> dict[str, Any]:
    return {k: v for k, v in (fields or {}).items() if not blank(v)}


@websocket_api.websocket_command({vol.Required("type"): "sb_background/save", vol.Optional("entry_id"): str,
                                  vol.Required("name"): str, vol.Required("script"): str,
                                  vol.Optional("fields", default={}): dict, vol.Optional("enabled"): bool})
@websocket_api.require_admin
@websocket_api.async_response
async def ws_save(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict) -> None:
    name = msg["name"].strip()
    script = msg["script"]
    fields = _clean(msg["fields"])
    entry = hass.config_entries.async_get_entry(msg["entry_id"]) if msg.get("entry_id") else None
    if msg.get("entry_id") and (entry is None or entry.domain != DOMAIN):
        connection.send_error(msg["id"], "not_found", "That instance no longer exists.")
        return
    if not name:
        connection.send_error(msg["id"], "invalid", "Give the instance a name.")
        return
    if script_entity(hass, script) is None:
        connection.send_error(msg["id"], "invalid", f"Script {script} does not exist.")
        return
    enabled = msg.get("enabled", entry.options.get(CONF_ENABLED, True) if entry else True)
    res = _check(hass, script, fields, msg.get("entry_id"), enabled)
    if res["errors"]:
        connection.send_error(msg["id"], "invalid", " ".join(res["errors"]))
        return
    if entry is None:
        result = await hass.config_entries.flow.async_init(
            DOMAIN, context={"source": SOURCE_IMPORT},
            data={CONF_NAME: name, CONF_SCRIPT: script, CONF_FIELDS: fields, CONF_ENABLED: enabled})
        new = result.get("result")
        connection.send_result(msg["id"], {"entry_id": new.entry_id if new else None, "warnings": res["warnings"]})
        return
    hass.config_entries.async_update_entry(entry, title=name, options={
        **entry.options, CONF_NAME: name, CONF_SCRIPT: script, CONF_FIELDS: fields, CONF_ENABLED: enabled})
    connection.send_result(msg["id"], {"entry_id": entry.entry_id, "warnings": res["warnings"]})


@websocket_api.websocket_command({vol.Required("type"): "sb_background/delete", vol.Required("entry_id"): str})
@websocket_api.require_admin
@websocket_api.async_response
async def ws_delete(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict) -> None:
    entry = hass.config_entries.async_get_entry(msg["entry_id"])
    if entry is None or entry.domain != DOMAIN:
        connection.send_error(msg["id"], "not_found", "That instance no longer exists.")
        return
    await hass.config_entries.async_remove(entry.entry_id)
    connection.send_result(msg["id"], {})


@websocket_api.websocket_command({vol.Required("type"): "sb_background/settings", vol.Optional("notify_service"): str,
                                  vol.Optional("persistent"): bool})
@websocket_api.async_response
async def ws_settings(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict) -> None:
    data = hass.data[DOMAIN]
    if "notify_service" in msg or "persistent" in msg:
        if not connection.user.is_admin:
            connection.send_error(msg["id"], "unauthorized", "Only an admin can change the settings.")
            return
        svc = msg.get("notify_service", data["settings"].get("notify_service", "")).strip()
        if svc and not (svc.startswith("notify.") and hass.services.has_service("notify", svc.split(".", 1)[1])):
            connection.send_error(msg["id"], "invalid", f"{svc} is not a notify action.")
            return
        data["settings"]["notify_service"] = svc
        if "persistent" in msg:
            data["settings"]["persistent"] = msg["persistent"]
        await data["store"].async_save(data["settings"])
    notify = sorted(f"notify.{s}" for s in hass.services.async_services_for_domain("notify")
                    if s not in ("send_message", "persistent_notification", "notify"))
    connection.send_result(msg["id"], {"persistent": True, **data["settings"], "notify_services": notify})


@callback
def async_register(hass: HomeAssistant) -> None:
    for cmd in (ws_script_fields, ws_check, ws_save, ws_delete, ws_settings):
        websocket_api.async_register_command(hass, cmd)
