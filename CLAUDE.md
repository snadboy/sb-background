# sb-background — session notes

| | |
|---|---|
| Repo | github.com/snadboy/sb-background (public, created 2026-10-14) — local `~/projects/git/sb-background`, branch `main` |
| Domain | `sb_background` (MIT) |
| HACS | custom repository id **1419814359** (category integration), installed v0.2.0 on 2026-10-14 |
| Release | bump `manifest.json` version AND `VERSION` in `frontend/sb-background.js` (it is the `?v=` cache-buster) → commit, push → `gh release create vX.Y.Z` → HACS `update_information` + `download` → FULL restart for Python changes (a reload does not re-import); JS-only changes need just a browser reload |
| Quick test deploy | `tar czf - --exclude=__pycache__ -C custom_components sb_background \| ssh snadboy@homeassistant "cd /config/custom_components && sudo tar xzf -"` (sudo: HACS-written files may be root-owned) |
| Tests | `python3 tests/test_validate.py` (offline, 12 checks) |

## Why it exists (2026-10-14)

User: one place to add nightlight/vacancy "pairs" instead of one blueprint automation per
room. "Room" is the wrong unit (kitchen/dining use aux areas), so instances list entities.
The user generalised it: the integration is "simply a bookkeeper" for ANY script with
fields; instances run always; it reports viability. Name chosen by the user.

## Design

- **Instance = config entry** (options: name, script entity id, fields, enabled), device
  with Status (enum sensor; attributes carry everything the card shows, incl.
  `sb_background: true`), Problem, Enabled (writes options → reload), Restart.
- **Run tracking** (`supervisor.py`): `hass.services.async_call("script", <unique_id>,
  fields, blocking=True)` inside the instance's own task. Verified in HA 2026.10 source:
  blocking calls await the run in the caller's task; cancelling it stops THAT run only
  (`helpers/script.py` asyncio.shield + `run.async_stop`); errors re-raise; `single`
  already running returns at once; reload removes only changed scripts.
- Service name is the script's **unique_id** (its key), not the entity object id.
- Fields come from `hass.data["script"].get_entity(eid).fields` (→ `plain()`).
- `validate.py` is pure (offline tests). Errors block a start (status invalid, re-check
  30 s) or flag a running instance (periodic 60 s check); warnings never block.
  A registered entity with no state yet reads "unavailable" (boot race), not missing.
- Restart policy: 2 s after an end, ×2 per consecutive run < 60 s, cap 300 s; ≥3 = failing.
  A run that lasts 60 s resets the count (`_settled`). Restart button resets it too.
- Alerts (`alerts.py`): after 120 s of problem → Repairs issue (always) + HA Notifications
  entry (setting `persistent`, default on; id `sb_background_<entry_id>`, text kept current)
  + ONE device push per episode (setting `notify_service`, optional; `alert_once`, same tag);
  all cleared on recovery (`clear_notification` only for `notify.mobile_app_*`). Settings in
  a Store (`sb_background.settings`), default phone `notify.mobile_app_pixel_snadboy`.
- Startup: first runs after EVENT_HOMEASSISTANT_STARTED + 20 s.
- **UI = one JS module** served by the integration and loaded on every page with
  `add_extra_js_url` (card `custom:sb-background-card`) + `panel_custom` (`/sb-background`,
  admin, `?edit=<entry_id>` / `?add=1`). No card repo, no build step (deliberately simpler
  than sb-watch's card→panel build). Editor = HA's `ha-form` with the script's selectors
  (`loadHaForm` from sb-watch-card), native `<dialog>` + wheel guard + dirty check.
- Integrations-page flows label a field by its SCHEMA KEY, so the key is the field's
  display name, mapped back on submit (`field_labels`).

## Verified live 2026-10-14 (throwaways zz_*)

Flow add ✓ · run does the work (context matches) ✓ · Restart stops only its run ✓ ·
panel list/settings/editor (labels = names, defaults seeded, live check) ✓ · save refused
with errors ✓ · failing after short runs + back-off ✓ · deleted entity flagged on a running
instance ✓ · Repairs + push after grace ✓ · recovery clears both ✓ · mode guard ✓ ·
script edit → run restarted, not counted short ✓ · Enabled off stops the run ✓ ·
HA restart: waiting → running after settle, disabled stays stopped ✓.
Found + fixed: a new row missed its switch/button (hass.entities arrives later → in the
render signature); a push per reason change (now one per episode).

## 0.2.0 (2026-10-14)

User: "I click Edit, the popup appears and a minute or so later it is magically
dismissed". Cause: `_render()` replaced the WHOLE shadow root — the editor `<dialog>`
included — on the 30 s tick and on status changes. Now the list renders into `.body` only
and the dialog is a sibling of `<ha-card>`. Verified: editor open 75 s, all 7 fields intact.
Also: HA Notifications channel + its setting; device push optional ("— no device —").
Script renamed `vacancy_window` → **`area_nightlight`** (copy, move Kitchen, delete old).

## 0.2.1 (2026-10-14) — the card's visual editor

User: "Shouldn't the SB Background card have a visual editor similar to the SB Scheduler
card". `getConfigElement()` → `sb-background-card-editor` (ha-form): Title (as SB Scheduler)
+ "Only instances of these scripts" (`scripts:` — empty/absent = all; exactly one also
preselects it in + Add). Verified headless: labels, config-changed with/without `scripts`,
filter 3/3/0 + empty message. Also confirmed the module really loads on dashboards via
add_extra_js_url (a test's request interception had hidden it).

## Migration — DONE 2026-10-14

Kitchen, Dining Room and Living Room overnight are SB Background instances of
`script.area_nightlight` with the blueprint's exact inputs. The three
`automation.vacancy_scene_*_overnight` automations and the `vacancy-scene-window.yaml`
blueprint are deleted (YAML in docker-homelab git history, commit 7d4c31c).

## Ideas, not started

- Rename the "Lights that must be off" field to say what it does ("Skip the nightlight
  while any of these are on") — offered to the user, not asked for yet.
