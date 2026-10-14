"""Shared base: one SERVICE device per instance; entities carry only their own noun."""

from __future__ import annotations

from homeassistant.core import callback
from homeassistant.helpers.device_registry import DeviceEntryType, DeviceInfo
from homeassistant.helpers.entity import Entity

from .const import DOMAIN
from .supervisor import InstanceSupervisor


class InstanceEntity(Entity):
    _attr_has_entity_name = True
    _attr_should_poll = False

    def __init__(self, sup: InstanceSupervisor, key: str, name: str) -> None:
        self._sup = sup
        self._attr_name = name
        self._attr_unique_id = f"{sup.entry.entry_id}_{key}"
        self._attr_device_info = DeviceInfo(
            identifiers={(DOMAIN, sup.entry.entry_id)},
            entry_type=DeviceEntryType.SERVICE,
            name=sup.name,
            manufacturer="snadboy",
            model="SB Background instance",
            sw_version=sup.hass.data.get(DOMAIN, {}).get("version"),
        )

    async def async_added_to_hass(self) -> None:
        self.async_on_remove(self._sup.add_listener(self._changed))

    @callback
    def _changed(self) -> None:
        self.async_write_ha_state()
