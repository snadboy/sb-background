"""sensor.<instance>_status — the instance's state, with everything the card shows as attributes."""

from __future__ import annotations

from homeassistant.components.sensor import SensorDeviceClass, SensorEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import STATUSES
from .entity import InstanceEntity


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry, add: AddEntitiesCallback) -> None:
    add([StatusSensor(entry.runtime_data)])


class StatusSensor(InstanceEntity, SensorEntity):
    _attr_device_class = SensorDeviceClass.ENUM
    _attr_options = STATUSES
    _attr_icon = "mdi:progress-wrench"
    _attr_translation_key = "status"

    def __init__(self, sup) -> None:
        super().__init__(sup, "status", "Status")

    @property
    def native_value(self) -> str:
        return self._sup.status

    @property
    def extra_state_attributes(self) -> dict:
        return self._sup.snapshot()
