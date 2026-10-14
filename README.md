# SB Background

A Home Assistant integration that keeps **scripts running in the background** — one
run per *instance* — and tells you when one cannot run.

An **instance** is a script plus the values for its fields. SB Background:

- starts every enabled instance once Home Assistant has started;
- restarts it whenever its run ends (2 s, doubling for each run in a row that lasted
  under a minute, capped at 5 min — "failing" after three);
- checks continuously that it *can* run: the script exists, required fields are
  filled, every entity in a field exists and is of an allowed domain, and the
  script's `mode` can hold all its instances (`parallel`, `max` ≥ instances);
- when an instance cannot run or keeps failing for two minutes: always a **Repairs**
  issue, plus (each optional) an entry in HA's **Notifications** and a **push to a chosen
  device** (replace-in-place, one per episode); all cleared on recovery.

What an instance *does* is entirely its script — an ordinary HA script you edit as
usual. Editing it is safe: HA stops the runs of a changed script, and SB Background
starts them again.

## Using it

- **Sidebar → SB Background**: every instance with its status, an Enabled switch,
  Restart, Edit, Duplicate and Delete; **+ Add**; the alert settings (Notifications on/off,
  which device gets a push).
- **Card**: `type: custom:sb-background-card` (loaded by the integration — no resource
  to add).
- **Integrations → SB Background → Add entry** works too.

Each instance is a device with `sensor.<name>_status`, `binary_sensor.<name>_problem`,
`switch.<name>_enabled` and `button.<name>_restart`.

## Writing a background script

- `mode: parallel` with `max` at least the number of instances.
- Loop forever (`repeat: while: "{{ true }}"`) around a `wait_for_trigger`. A field
  cannot be a state trigger's `entity_id` (HA rejects the template); use a
  **template** trigger (fires on false → true) or an **event** trigger on
  `state_changed` filtered by `event_data: {entity_id: "{{ field }}"}` (any change).
- On start, check the current state: a restart cannot resume a wait that was in
  progress.

`script.area_nightlight` (the first one) applies a scene once occupancy sensors have
been off for N minutes inside a daily window, and an optional nightlight scene when
someone arrives with every listed light off.
