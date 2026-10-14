"""binary_sensor.<instance>_problem — on while the instance cannot run, keeps failing, or has errors."""

from __future__ import annotations

from homeassistant.components.binary_sensor import BinarySensorDeviceClass, BinarySensorEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .entity import InstanceEntity


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry, add: AddEntitiesCallback) -> None:
    add([ProblemSensor(entry.runtime_data)])


class ProblemSensor(InstanceEntity, BinarySensorEntity):
    _attr_device_class = BinarySensorDeviceClass.PROBLEM

    def __init__(self, sup) -> None:
        super().__init__(sup, "problem", "Problem")

    @property
    def is_on(self) -> bool:
        return self._sup.problem

    @property
    def extra_state_attributes(self) -> dict:
        return {"reason": self._sup.reason or None, "warnings": self._sup.warnings}
