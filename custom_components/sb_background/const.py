"""Constants for SB Background."""

DOMAIN = "sb_background"

CONF_NAME = "name"
CONF_SCRIPT = "script"            # the script's entity id, e.g. script.vacancy_window
CONF_FIELDS = "fields"            # {field key: value} passed to every run
CONF_ENABLED = "enabled"

# Status of an instance (the Status sensor's state).
ST_WAITING = "waiting"            # HA still starting; first run after the settle period
ST_RUNNING = "running"
ST_RESTARTING = "restarting"      # the run ended; waiting out the back-off before the next one
ST_FAILING = "failing"            # several runs in a row ended quickly; still retrying, slower
ST_INVALID = "invalid"            # cannot run: script missing, required field empty, entity gone…
ST_STOPPED = "stopped"            # disabled by the user
STATUSES = [ST_WAITING, ST_RUNNING, ST_RESTARTING, ST_FAILING, ST_INVALID, ST_STOPPED]
PROBLEM_STATUSES = (ST_FAILING, ST_INVALID)

STARTUP_SETTLE_SECONDS = 20       # after EVENT_HOMEASSISTANT_STARTED, before the first runs
SHORT_RUN_SECONDS = 60            # a run that ends sooner than this counts against the instance
FAILING_AFTER = 3                 # consecutive short runs before the status says "failing"
BACKOFF_FIRST = 2                 # seconds before restarting after a run ends
BACKOFF_MAX = 300
REVALIDATE_SECONDS = 30           # how often an invalid instance is checked again
CHECK_SECONDS = 60                # how often a running instance's fields are checked
ALERT_GRACE_SECONDS = 120         # a problem must last this long before Repairs + push

DEFAULT_NOTIFY = "notify.mobile_app_pixel_snadboy"
SETTINGS_KEY = f"{DOMAIN}.settings"
SETTINGS_VERSION = 1

PANEL_URL = "sb-background"
STATIC_URL = "/sb_background_static"
