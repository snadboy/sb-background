"""Config + options flow.

Add (Integrations → SB Background → Add entry):
  1. user   — instance name + the script
  2. fields — one control per script field, built from the script's own selectors

Configure (options): the instance name + the same field controls.

A flow form labels a control by its schema KEY when no translation exists, and a
script's fields cannot have translations here — so the key IS the field's display
name ("Occupancy sensors", not "occupancy_sensors") and is mapped back on submit.

The card and the sidebar panel do not use these forms: they save through the
sb_background/save WebSocket command, which creates entries via the `import` step.
"""

from __future__ import annotations

from typing import Any

import voluptuous as vol

from homeassistant import config_entries
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers import selector

from .const import CONF_ENABLED, CONF_FIELDS, CONF_NAME, CONF_SCRIPT, DOMAIN
from .supervisor import script_entity, script_fields, state_lookup
from .validate import blank, check_fields

INSTANCE_NAME = "Instance name"      # options form; cannot collide with a field labelled "Name"


def field_labels(defs: dict[str, dict], reserved: set[str] | None = None) -> dict[str, str]:
    """field key → a unique form label (its name; the key added when two names collide)."""
    out: dict[str, str] = {}
    used = set(reserved or ())
    for key, fdef in defs.items():
        label = str((fdef or {}).get("name") or key)
        if label in used:
            label = f"{label} ({key})"
        used.add(label)
        out[key] = label
    return out


def _selector(fdef: dict):
    sel = (fdef or {}).get("selector")
    if sel:
        try:
            return selector.selector(sel)
        except Exception:  # noqa: BLE001 — an unknown selector type: take any value
            pass
    return selector.ObjectSelector()


def fields_schema(defs: dict[str, dict], labels: dict[str, str], current: dict[str, Any]) -> dict:
    schema: dict = {}
    for key, fdef in defs.items():
        label = labels[key]
        cur = current.get(key, (fdef or {}).get("default"))
        if (fdef or {}).get("required"):
            k = vol.Required(label) if blank(cur) else vol.Required(label, default=cur)
        else:
            k = vol.Optional(label) if cur is None else vol.Optional(label, description={"suggested_value": cur})
        schema[k] = _selector(fdef)
    return schema


def values_from_form(user_input: dict[str, Any], labels: dict[str, str]) -> dict[str, Any]:
    return {key: user_input[label] for key, label in labels.items() if not blank(user_input.get(label))}


def field_problems(hass: HomeAssistant, defs: dict[str, dict], values: dict[str, Any]) -> str:
    errors, _ = check_fields(defs, values, state_lookup(hass))
    return "\n".join(f"- {e}" for e in errors)


class SbBackgroundConfigFlow(config_entries.ConfigFlow, domain=DOMAIN):
    VERSION = 1

    def __init__(self) -> None:
        self._name = ""
        self._script = ""

    async def async_step_user(self, user_input: dict[str, Any] | None = None):
        errors: dict[str, str] = {}
        if user_input is not None:
            self._name = str(user_input.get(CONF_NAME, "")).strip()
            self._script = user_input.get(CONF_SCRIPT, "")
            if not self._name:
                errors[CONF_NAME] = "name_required"
            elif script_entity(self.hass, self._script) is None:
                errors[CONF_SCRIPT] = "script_missing"
            else:
                return await self.async_step_fields()
        return self.async_show_form(step_id="user", errors=errors, data_schema=vol.Schema({
            vol.Required(CONF_NAME, default=self._name): selector.TextSelector(),
            vol.Required(CONF_SCRIPT, default=self._script or vol.UNDEFINED): selector.EntitySelector(
                selector.EntitySelectorConfig(domain="script")),
        }))

    async def async_step_fields(self, user_input: dict[str, Any] | None = None):
        defs = script_fields(self.hass, self._script) or {}
        labels = field_labels(defs)
        errors: dict[str, str] = {}
        problems = ""
        current: dict[str, Any] = {}
        if user_input is not None:
            current = values_from_form(user_input, labels)
            problems = field_problems(self.hass, defs, current)
            if problems:
                errors["base"] = "invalid_fields"
            else:
                return self.async_create_entry(title=self._name, data={}, options={
                    CONF_NAME: self._name, CONF_SCRIPT: self._script, CONF_FIELDS: current, CONF_ENABLED: True})
        st = self.hass.states.get(self._script)
        return self.async_show_form(
            step_id="fields", errors=errors, data_schema=vol.Schema(fields_schema(defs, labels, current)),
            description_placeholders={"script": st.name if st else self._script, "problems": problems})

    async def async_step_import(self, data: dict[str, Any]):
        """From the card / panel (sb_background/save), already checked there."""
        return self.async_create_entry(title=data[CONF_NAME], data={}, options={
            CONF_NAME: data[CONF_NAME], CONF_SCRIPT: data[CONF_SCRIPT],
            CONF_FIELDS: dict(data.get(CONF_FIELDS) or {}), CONF_ENABLED: data.get(CONF_ENABLED, True)})

    @staticmethod
    @callback
    def async_get_options_flow(config_entry: config_entries.ConfigEntry) -> "SbBackgroundOptionsFlow":
        return SbBackgroundOptionsFlow()


class SbBackgroundOptionsFlow(config_entries.OptionsFlow):
    async def async_step_init(self, user_input: dict[str, Any] | None = None):
        opts = dict(self.config_entry.options)
        script = opts.get(CONF_SCRIPT, "")
        defs = script_fields(self.hass, script) or {}
        labels = field_labels(defs, {INSTANCE_NAME})
        errors: dict[str, str] = {}
        problems = ""
        current = dict(opts.get(CONF_FIELDS) or {})
        name = opts.get(CONF_NAME) or self.config_entry.title
        if user_input is not None:
            name = str(user_input.get(INSTANCE_NAME, "")).strip() or name
            current = values_from_form(user_input, labels)
            problems = field_problems(self.hass, defs, current)
            if problems:
                errors["base"] = "invalid_fields"
            else:
                if name != self.config_entry.title:
                    self.hass.config_entries.async_update_entry(self.config_entry, title=name)
                return self.async_create_entry(data={**opts, CONF_NAME: name, CONF_FIELDS: current})
        st = self.hass.states.get(script)
        schema = {vol.Required(INSTANCE_NAME, default=name): selector.TextSelector(), **fields_schema(defs, labels, current)}
        return self.async_show_form(
            step_id="init", errors=errors, data_schema=vol.Schema(schema),
            description_placeholders={"script": st.name if st else script, "problems": problems})
