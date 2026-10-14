"""switch.<instance>_enabled — off stops the run and keeps it stopped (stored in the entry)."""

from __future__ import annotations

from typing import Any

from homeassistant.components.switch import SwitchEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import CONF_ENABLED
from .entity import InstanceEntity


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry, add: AddEntitiesCallback) -> None:
    add([EnabledSwitch(entry.runtime_data)])


class EnabledSwitch(InstanceEntity, SwitchEntity):
    _attr_icon = "mdi:play-pause"

    def __init__(self, sup) -> None:
        super().__init__(sup, "enabled", "Enabled")

    @property
    def is_on(self) -> bool:
        return self._sup.enabled

    async def _set(self, on: bool) -> None:
        entry = self._sup.entry
        # the options update reloads the entry, which starts or stops the run
        self.hass.config_entries.async_update_entry(entry, options={**entry.options, CONF_ENABLED: on})

    async def async_turn_on(self, **kwargs: Any) -> None:
        await self._set(True)

    async def async_turn_off(self, **kwargs: Any) -> None:
        await self._set(False)
