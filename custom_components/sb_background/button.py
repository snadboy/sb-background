"""button.<instance>_restart — stop this instance's run (only this one) and start it again now."""

from __future__ import annotations

from homeassistant.components.button import ButtonEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .entity import InstanceEntity


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry, add: AddEntitiesCallback) -> None:
    add([RestartButton(entry.runtime_data)])


class RestartButton(InstanceEntity, ButtonEntity):
    _attr_icon = "mdi:restart"

    def __init__(self, sup) -> None:
        super().__init__(sup, "restart", "Restart")

    async def async_press(self) -> None:
        await self._sup.restart_now()
