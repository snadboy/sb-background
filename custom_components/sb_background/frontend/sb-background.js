/* SB Background — the card (custom:sb-background-card) and the sidebar page
 * (sb-background-panel), one module served by the integration and loaded on every
 * page (add_extra_js_url), so there is no Lovelace resource to keep in step.
 *
 * Instances are READ from their Status sensors (attribute sb_background: true) —
 * live with no subscription. Writes go through the integration's WebSocket API
 * (sb_background/save | delete | check | script_fields | settings) and the
 * instance's own Enabled switch and Restart button.
 *
 * The field editor is HA's own <ha-form>, fed the script's field selectors, so an
 * entity field gets HA's entity picker and a `multiple` one a list — the same
 * controls as HA's "run script" dialog.
 */
const VERSION = "0.3.0";
const CARD = "sb-background-card";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const ago = (iso, now = Date.now()) => {
  if (!iso) return "";
  let s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  return dur(s);
};
const until = (iso, now = Date.now()) => (iso ? dur(Math.max(0, Math.round((new Date(iso).getTime() - now) / 1000))) : "");
const dur = (s) => {
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h ${m % 60} min`;
  return `${Math.floor(h / 24)} d ${h % 24} h`;
};

// A field's selector, normalised: `text: null` in a script's YAML arrives as null config.
const normSelector = (sel) => {
  if (!sel || typeof sel !== "object") return { object: {} };
  const [type] = Object.keys(sel);
  return type ? { [type]: sel[type] || {} } : { object: {} };
};

// HA lazy-loads ha-form with the card editors; force it in before showing the editor.
// (Same approach as sb-watch-card: on a sidebar page opened cold, Lovelace — and with it
// window.loadCardHelpers — is not loaded yet; HA's own panel resolver can load it.)
const loadHaForm = async () => {
  if (customElements.get("ha-form")) return true;
  try {
    if (!window.loadCardHelpers) {
      await customElements.whenDefined("partial-panel-resolver");
      const ppr = document.createElement("partial-panel-resolver");
      ppr.hass = { panels: [{ url_path: "tmp", component_name: "lovelace" }] };
      ppr._updateRoutes();
      await ppr.routerOptions.routes.tmp.load();
    }
    const helpers = await window.loadCardHelpers();
    helpers.createCardElement({ type: "entities", entities: [] });
    await Promise.race([customElements.whenDefined("hui-entities-card"), new Promise((r) => setTimeout(r, 5000))]);
    const C = customElements.get("hui-entities-card");
    if (C?.getConfigElement) await C.getConfigElement();
  } catch (e) { /* reported by the caller */ }
  return !!customElements.get("ha-form");
};

// ---- the SB row kit — the SAME markup and CSS in sb-scheduler-card, sb-watch-card and here
// (agreed mockup 2026-10-14: header = title · count · + Add · ⋮; row = status icon · name ·
// one summary line (chip + what it is doing now) · enabled toggle · ⋮; tap the row = edit;
// Duplicate / Run now|Restart / Delete… live in ⋮; delete confirms inline; a third line
// only for a warning or a problem). Theme variables only, so light and dark themes both work.
const KIT_CSS = `
ha-card { overflow: visible; }
.sbk-head { display: flex; align-items: center; gap: 8px; padding: 12px 4px 8px 16px; }
.sbk-head h2 { margin: 0; font-size: 20px; font-weight: 500; line-height: 1.2; }
.sbk-count { flex: 1; font-size: 13px; color: var(--secondary-text-color); }
.sbk-add { display: inline-flex; align-items: center; gap: 4px; height: 36px; padding: 0 14px 0 10px; border-radius: 18px; border: none;
           background: color-mix(in srgb, var(--primary-color) 16%, transparent); color: var(--primary-color);
           font: inherit; font-size: 14px; font-weight: 500; cursor: pointer; --mdc-icon-size: 18px; }
.sbk-kb { width: 44px; height: 44px; display: inline-flex; align-items: center; justify-content: center; border: none; background: none; padding: 0;
          color: var(--secondary-text-color); border-radius: 22px; cursor: pointer; flex: 0 0 44px; --mdc-icon-size: 20px; }
.sbk-kb:hover, .sbk-kb.on { background: color-mix(in srgb, var(--primary-text-color) 10%, transparent); }
.sbk-row { position: relative; display: flex; align-items: center; gap: 4px; padding: 0 4px 0 12px; border-top: 1px solid var(--divider-color); min-height: 68px; }
.sbk-row.off .sbk-open { opacity: .5; }
.sbk-open { flex: 1; min-width: 0; display: flex; align-items: center; gap: 12px; padding: 10px 0; border: none; background: none;
            text-align: left; color: inherit; font: inherit; cursor: pointer; border-radius: 8px; }
.sbk-ico { width: 40px; height: 40px; border-radius: 20px; display: flex; align-items: center; justify-content: center; flex: 0 0 40px; --mdc-icon-size: 22px; }
.sbk-ico.armed { background: color-mix(in srgb, var(--primary-color) 16%, transparent); color: var(--primary-color); }
.sbk-ico.run { background: color-mix(in srgb, var(--success-color, #43a047) 20%, transparent); color: var(--success-color, #43a047); }
.sbk-ico.idle { background: color-mix(in srgb, var(--primary-text-color) 7%, transparent); color: var(--secondary-text-color); }
.sbk-ico.warn { background: color-mix(in srgb, var(--warning-color, #ffa600) 18%, transparent); color: var(--warning-color, #ffa600); }
.sbk-ico.bad { background: color-mix(in srgb, var(--error-color, #db4437) 20%, transparent); color: var(--error-color, #db4437); }
.sbk-txt { min-width: 0; display: flex; flex-direction: column; gap: 4px; }
.sbk-t { font-size: 15px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: var(--primary-text-color); }
.sbk-s { display: flex; align-items: center; gap: 6px; font-size: 13px; color: var(--secondary-text-color); white-space: nowrap; overflow: hidden; }
.sbk-chip { font-size: 12px; font-weight: 600; padding: 2px 8px; border-radius: 10px; flex: 0 0 auto;
            background: color-mix(in srgb, var(--primary-color) 16%, transparent); color: var(--primary-color); }
.sbk-dot { width: 3px; height: 3px; border-radius: 2px; background: var(--secondary-text-color); opacity: .7; flex: 0 0 3px; }
.sbk-m { font-size: 12.5px; line-height: 1.35; white-space: normal; }
.sbk-m.bad { color: var(--error-color, #db4437); }
.sbk-m.warn { color: var(--warning-color, #ffa600); }
.sbk-sw { position: relative; width: 40px; height: 24px; flex: 0 0 40px; margin: 0 4px; }
.sbk-sw input { position: absolute; inset: 0; margin: 0; opacity: 0; cursor: pointer; z-index: 1; }
.sbk-sw span { position: absolute; inset: 0; border-radius: 12px; background: var(--disabled-color, #9e9e9e); pointer-events: none; transition: background .15s; }
.sbk-sw span::after { content: ""; position: absolute; width: 18px; height: 18px; left: 3px; top: 3px; border-radius: 9px; background: #fff; transition: left .15s; }
.sbk-sw input:checked + span { background: var(--primary-color); }
.sbk-sw input:checked + span::after { left: 19px; }
.sbk-sw input:focus-visible + span { outline: 2px solid var(--primary-color); outline-offset: 2px; }
.sbk-menu { position: absolute; right: 8px; top: 52px; z-index: 5; min-width: 196px; padding: 6px 0; display: flex; flex-direction: column;
            background: var(--card-background-color, #fff); border: 1px solid var(--divider-color); border-radius: 10px; box-shadow: 0 8px 24px rgba(0,0,0,.4); }
.sbk-menu button { display: flex; align-items: center; gap: 12px; height: 44px; padding: 0 16px; border: none; border-radius: 0; background: none;
                   color: var(--primary-text-color); font: inherit; font-size: 14px; text-align: left; cursor: pointer; --mdc-icon-size: 18px; }
.sbk-menu button:hover { background: color-mix(in srgb, var(--primary-text-color) 8%, transparent); }
.sbk-menu button:disabled { opacity: .45; cursor: default; }
.sbk-menu .del { color: var(--error-color, #db4437); }
.sbk-menu hr { border: none; border-top: 1px solid var(--divider-color); margin: 4px 0; }
.sbk-head .sbk-menu { top: 50px; }
.sbk-hwrap { position: relative; }
.sbk-confirm { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 12px 12px 12px 16px; min-height: 68px; box-sizing: border-box;
               border-top: 1px solid var(--divider-color); background: color-mix(in srgb, var(--error-color, #db4437) 10%, transparent); }
.sbk-confirm p { margin: 0; flex: 1 1 180px; font-size: 14px; }
.sbk-btn { height: 36px; padding: 0 16px; border-radius: 18px; border: 1px solid var(--divider-color); background: none;
           color: var(--primary-text-color); font: inherit; font-size: 14px; font-weight: 500; cursor: pointer; }
.sbk-btn.danger { background: var(--error-color, #db4437); border-color: var(--error-color, #db4437); color: #fff; }
.sbk-empty { color: var(--secondary-text-color); padding: 12px 16px 16px; border-top: 1px solid var(--divider-color); }
.sbk-note { color: var(--secondary-text-color); font-size: 13px; padding: 8px 16px 12px; border-top: 1px solid var(--divider-color); }
`;
const KB_ICON = `<ha-icon icon="mdi:dots-vertical"></ha-icon>`;
const kitMenu = (label, items) => `<div class="sbk-menu" role="menu" aria-label="${esc(label)}">${items.map((it) => it === "-" ? "<hr>"
  : `<button role="menuitem" data-act="${esc(it.act)}" class="${it.danger ? "del" : ""}" ${it.disabled ? "disabled" : ""}><ha-icon icon="${esc(it.icon)}"></ha-icon>${esc(it.label)}</button>`).join("")}</div>`;

const STYLE = KIT_CSS + `
:host { display: block; }
.ash { padding-bottom: 4px; }
dialog.sbbg button { font: inherit; cursor: pointer; border-radius: 16px; border: 1px solid var(--divider-color); background: none;
                     color: var(--primary-text-color); padding: 4px 12px; }
dialog.sbbg button:hover { background: rgba(127,127,127,.12); }
dialog.sbbg button.primary { background: var(--primary-color); color: var(--text-primary-color, #fff); border-color: transparent; }
dialog.sbbg button.danger { color: var(--error-color); border-color: var(--error-color); }
dialog.sbbg button:disabled { opacity: .5; cursor: default; }
.msg { font-size: .85em; margin-top: 3px; }
.msg.err { color: var(--error-color); }
.msg.warn { color: var(--warning-color, #ffa000); }

dialog.sbbg { border: none; border-radius: 12px; padding: 0; width: min(560px, calc(100vw - 32px)); max-height: calc(100vh - 48px);
              background: var(--card-background-color, #fff); color: var(--primary-text-color); box-shadow: 0 8px 32px rgba(0,0,0,.4); }
dialog.sbbg::backdrop { background: rgba(0,0,0,.45); }
.dbody { padding: 16px 20px; overflow-y: auto; max-height: calc(100vh - 48px); box-sizing: border-box; }
.dtitle { display: flex; align-items: center; font-size: 1.2em; font-weight: 500; margin-bottom: 12px; }
.dtitle span { flex: 1; }
.dtitle button { border: none; font-size: 1.2em; padding: 2px 8px; }
label.f { display: flex; flex-direction: column; gap: 4px; margin: 10px 0; }
label.f > span { color: var(--secondary-text-color); font-size: .85em; }
input.txt, select { font: inherit; padding: 8px; border-radius: 6px; border: 1px solid var(--divider-color);
                    background: var(--card-background-color, #fff); color: var(--primary-text-color); color-scheme: light dark; }
select option { background: var(--card-background-color, #fff); color: var(--primary-text-color); }
.fields { margin-top: 6px; }
.fields .hint { color: var(--secondary-text-color); font-size: .85em; margin: 4px 0 8px; }
.check { margin-top: 10px; }
.buttons { display: flex; gap: 8px; margin-top: 16px; align-items: center; }
.buttons .spacer { flex: 1; }
.derr { color: var(--error-color); font-size: .9em; margin-top: 8px; white-space: pre-wrap; }
`;

class SbBackgroundCard extends HTMLElement {
  constructor() {
    super();
    // The list re-renders (every 30 s, and on every status change) into .body ONLY.
    // The editor <dialog> is a sibling of the card: rendering into the whole shadow root
    // destroyed an open editor within 30 s (0.1.0 — "the popup is magically dismissed").
    this.attachShadow({ mode: "open" }).innerHTML = `<style>${STYLE}</style><ha-card><div class="body"></div></ha-card>`;
    this._confirm = null;     // entry_id whose delete is being confirmed
    this._sig = "";
    this._busy = {};
  }

  static getStubConfig() { return { title: "Background" }; }
  static getConfigElement() { return document.createElement(`${CARD}-editor`); }
  setConfig(config) { this._config = { title: "Background", ...(config || {}) }; this._sig = ""; this._render(); }
  getCardSize() { return 2 + this._instances().length; }

  connectedCallback() { this._tick = setInterval(() => { this._sig = ""; this._render(); }, 30000); }
  disconnectedCallback() { clearInterval(this._tick); this._unguard?.(); this._unMenu?.(); }

  set hass(h) {
    this._hass = h;
    // the sibling entities are part of the signature: a NEW instance's switch / button reach
    // hass.entities after its Status sensor does, and the row must redraw when they arrive
    const sig = JSON.stringify(this._instances().map((i) => [i.statusEntity, i.status, i.attr, i.switchEntity, i.buttonEntity]));
    if (sig !== this._sig) { this._sig = sig; this._render(); }
    if (this._form) this._form.hass = h;
  }

  _instances() {
    const h = this._hass;
    if (!h) return [];
    const out = [];
    for (const [id, st] of Object.entries(h.states)) {
      if (!id.startsWith("sensor.") || !st.attributes?.sb_background) continue;
      const only = this._config?.scripts || [];
      if (only.length && !only.includes(st.attributes.script)) continue;
      const devId = h.entities?.[id]?.device_id;
      const sib = (dom) => Object.values(h.entities || {}).find((e) => e.device_id === devId && e.platform === "sb_background" && e.entity_id.startsWith(dom + "."))?.entity_id;
      out.push({ statusEntity: id, status: st.state, attr: st.attributes, entryId: st.attributes.entry_id,
                 name: st.attributes.instance, switchEntity: sib("switch"), buttonEntity: sib("button"), problemEntity: sib("binary_sensor") });
    }
    return out.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  }

  // What the row's icon, summary and third line say for one instance.
  _view(i, now) {
    const a = i.attr, st = i.status;
    const warn = (a.warnings || [])[0], err = (a.errors || [])[0];
    let tint = { running: "run", waiting: "armed", restarting: "armed", failing: "bad", invalid: "bad", stopped: "idle" }[st] || "idle";
    let doing = {
      running: `Running ${a.running_since ? ago(a.running_since, now) : ""}`.trim(),
      waiting: "Waiting for start-up",
      restarting: `Restarting${a.next_start ? ` in ${until(a.next_start, now)}` : ""}`,
      failing: a.running_since ? `Running ${ago(a.running_since, now)} · after ${a.consecutive_short} short runs` : `Failing · next try in ${until(a.next_start, now)}`,
      invalid: `Cannot run${a.next_start ? ` · retry in ${until(a.next_start, now)}` : ""}`,
      stopped: "Off",
    }[st] || st;
    let third = "";
    if (err) third = `<span class="sbk-m bad">${esc(err)}${a.errors.length > 1 ? ` (+${a.errors.length - 1} more)` : ""}</span>`;
    else if (st === "failing") third = `<span class="sbk-m bad">${esc(a.last_error ? `Last error: ${a.last_error}` : `${a.consecutive_short} runs in a row ended within a minute.`)}</span>`;
    else if (warn && st !== "stopped") { third = `<span class="sbk-m warn">${esc(warn)}${a.warnings.length > 1 ? ` (+${a.warnings.length - 1} more)` : ""}</span>`; if (tint === "run" || tint === "armed") tint = "warn"; }
    if (err) tint = "bad";
    return { tint, doing, third };
  }

  _render() {
    if (!this._config) return;
    const list = this._instances();
    const now = Date.now();
    const h = this._hass;
    const rows = list.map((i) => {
      const a = i.attr, v = this._view(i, now);
      if (this._confirm === i.entryId) {
        return `<div class="sbk-confirm" data-e="${esc(i.entryId)}"><p>Delete <b>${esc(i.name)}</b>? Its run stops; the script itself is not touched.</p>
          <button class="sbk-btn nodel">Keep</button><button class="sbk-btn danger dodel">Delete</button></div>`;
      }
      const icon = h?.states[a.script]?.attributes?.icon || "mdi:cog-play-outline";
      const menu = this._menu === i.entryId ? kitMenu(`${i.name} actions`, [
        { act: "edit", icon: "mdi:pencil", label: "Edit" },
        { act: "dup", icon: "mdi:content-copy", label: "Duplicate" },
        { act: "restart", icon: "mdi:restart", label: "Restart", disabled: !a.enabled || !i.buttonEntity || this._busy[i.entryId] },
        "-",
        { act: "del", icon: "mdi:delete-outline", label: "Delete…", danger: true },
      ]) : "";
      return `<div class="sbk-row ${a.enabled ? "" : "off"}" data-e="${esc(i.entryId)}">
        <button class="sbk-open" aria-label="Edit ${esc(i.name)}">
          <span class="sbk-ico ${v.tint}"><ha-icon icon="${esc(icon)}"></ha-icon></span>
          <span class="sbk-txt"><span class="sbk-t">${esc(i.name)}</span>
            <span class="sbk-s"><span class="sbk-chip">${esc(a.script_name || a.script)}</span>${esc(v.doing)}</span>${v.third}</span>
        </button>
        ${i.switchEntity ? `<label class="sbk-sw"><input type="checkbox" role="switch" class="en" ${a.enabled ? "checked" : ""} aria-label="${esc(i.name)} enabled"><span></span></label>` : ""}
        <button class="sbk-kb ${menu ? "on" : ""}" aria-label="More actions for ${esc(i.name)}" aria-expanded="${menu ? "true" : "false"}">${KB_ICON}</button>
        ${menu}
      </div>`;
    }).join("");
    const only = this._config.scripts || [];
    const headMenu = !this._config.panel && this._menu === "__head" ? kitMenu("Card actions", [{ act: "page", icon: "mdi:open-in-app", label: "Open the SB Background page" }]) : "";
    this.shadowRoot.querySelector(".body").innerHTML = `
      <div class="sbk-head sbk-hwrap"><h2>${esc(this._config.title)}</h2>
        <span class="sbk-count">${list.length} instance${list.length === 1 ? "" : "s"}</span>
        <button class="sbk-add add"><ha-icon icon="mdi:plus"></ha-icon>Add</button>
        ${this._config.panel ? "" : `<button class="sbk-kb hkb ${headMenu ? "on" : ""}" aria-label="More" aria-expanded="${headMenu ? "true" : "false"}">${KB_ICON}</button>${headMenu}`}
      </div>
      ${rows || `<div class="sbk-empty">${only.length
        ? `No instances of ${esc(only.map((x) => h?.states[x]?.attributes?.friendly_name || x).join(", "))} yet.`
        : "No background instances yet. Add one: pick a script and fill in its fields."}</div>`}
      ${this._msg ? `<div class="sbk-note">${esc(this._msg)}</div>` : ""}`;
    this._wire();
  }

  _setMenu(id) {
    this._menu = id;
    // one outside click / Escape closes it; installed only while a menu is open
    this._unMenu?.();
    if (id) {
      const away = (e) => { if (!e.composedPath().some((n) => n.classList?.contains("sbk-menu") || n.classList?.contains("sbk-kb"))) this._setMenu(null); };
      const esc_ = (e) => { if (e.key === "Escape") this._setMenu(null); };
      setTimeout(() => { window.addEventListener("click", away, true); window.addEventListener("keydown", esc_, true); });
      this._unMenu = () => { window.removeEventListener("click", away, true); window.removeEventListener("keydown", esc_, true); this._unMenu = null; };
    }
    this._render();
  }

  _wire() {
    const root = this.shadowRoot.querySelector(".body");
    const byRow = (el) => this._instances().find((i) => i.entryId === el.closest("[data-e]")?.dataset.e);
    root.querySelector("button.add")?.addEventListener("click", () => this._openEditor(null));
    root.querySelector("button.hkb")?.addEventListener("click", () => this._setMenu(this._menu === "__head" ? null : "__head"));
    root.querySelectorAll(".sbk-row .sbk-open").forEach((b) => b.addEventListener("click", () => this._openEditor(byRow(b))));
    root.querySelectorAll(".sbk-row .sbk-kb").forEach((b) => b.addEventListener("click", () => {
      const id = byRow(b).entryId; this._setMenu(this._menu === id ? null : id);
    }));
    root.querySelectorAll("input.en").forEach((el) => el.addEventListener("change", () => {
      const i = byRow(el);
      this._hass.callService("switch", el.checked ? "turn_on" : "turn_off", { entity_id: i.switchEntity });
    }));
    root.querySelectorAll(".sbk-menu button").forEach((b) => b.addEventListener("click", async () => {
      const act = b.dataset.act;
      if (act === "page") { this._setMenu(null); history.pushState(null, "", "/sb-background"); window.dispatchEvent(new CustomEvent("location-changed")); return; }
      const i = byRow(b);
      this._setMenu(null);
      if (act === "edit") this._openEditor(i);
      else if (act === "dup") this._openEditor(i, { copy: true });
      else if (act === "del") { this._confirm = i.entryId; this._render(); }
      else if (act === "restart") {
        this._busy[i.entryId] = true; this._render();
        try { await this._hass.callService("button", "press", { entity_id: i.buttonEntity }); }
        finally { delete this._busy[i.entryId]; this._sig = ""; this._render(); }
      }
    }));
    root.querySelector("button.nodel")?.addEventListener("click", () => { this._confirm = null; this._render(); });
    root.querySelector("button.dodel")?.addEventListener("click", async () => {
      const id = this._confirm; this._confirm = null;
      try { await this._hass.callWS({ type: "sb_background/delete", entry_id: id }); this._msg = ""; }
      catch (e) { this._msg = `Delete failed: ${e?.message || e}`; }
      this._render();
    });
  }

  // ---- the editor -------------------------------------------------------------------
  _scripts() {
    return Object.values(this._hass.states).filter((s) => s.entity_id.startsWith("script."))
      .map((s) => ({ id: s.entity_id, name: s.attributes.friendly_name || s.entity_id }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async _openEditor(inst, opts = {}) {
    if (!(await loadHaForm())) { this._msg = "HA's form element did not load — open any card editor once and reload."; this._render(); return; }
    const h = this._hass;
    const copy = !!opts.copy;
    const entryId = inst && !copy ? inst.entryId : null;
    const only = this._config?.scripts || [];
    const d = { name: inst ? (copy ? `${inst.name} (copy)` : inst.name) : "", script: inst?.attr.script || (only.length === 1 ? only[0] : ""),
                fields: JSON.parse(JSON.stringify(inst?.attr.fields || {})) };
    let meta = null;           // {fields:[...], name, mode, max}
    const snap = () => JSON.stringify(d);
    let start = snap();

    this.shadowRoot.querySelectorAll("dialog.sbbg").forEach((x) => x.remove());
    const dlg = document.createElement("dialog");
    dlg.className = "sbbg";
    dlg.innerHTML = `<div class="dbody">
      <div class="dtitle"><span>${entryId ? "Edit instance" : copy ? `Duplicate of “${esc(inst.name)}”` : "New background instance"}</span><button class="x" title="Close">✕</button></div>
      <label class="f"><span>Name</span><input class="txt nm" type="text" value="${esc(d.name)}" placeholder="e.g. Kitchen overnight"></label>
      <label class="f"><span>Script — runs continuously with the values below</span><select class="sc">
        <option value="" ${d.script ? "" : "selected"}>Choose a script…</option>
        ${this._scripts().map((s) => `<option value="${esc(s.id)}" ${s.id === d.script ? "selected" : ""}>${esc(s.name)} — ${esc(s.id)}</option>`).join("")}
      </select></label>
      <div class="fields"></div>
      <div class="check"></div>
      <div class="derr" style="display:none"></div>
      <div class="buttons"><div class="ask"></div><span class="spacer"></span><button class="cancel">Cancel</button><button class="ok primary">${entryId ? "Save" : "Create"}</button></div>
    </div>`;
    this.shadowRoot.appendChild(dlg);
    const $ = (s) => dlg.querySelector(s);
    const fail = (m) => { $(".derr").style.display = m ? "" : "none"; $(".derr").textContent = m || ""; };

    const close = () => { this._form = null; this._unguard?.(); dlg.close(); dlg.remove(); };
    const requestClose = () => {
      if (snap() === start) return close();
      $(".ask").innerHTML = `<span class="msg err">Discard your changes?</span> <button class="keep">Keep editing</button> <button class="discard danger">Discard</button>`;
      $(".keep").addEventListener("click", () => { $(".ask").innerHTML = ""; });
      $(".discard").addEventListener("click", close);
    };

    let timer = null;
    const runCheck = () => {
      clearTimeout(timer);
      timer = setTimeout(async () => {
        if (!d.script) { $(".check").innerHTML = ""; return; }
        try {
          const r = await h.callWS({ type: "sb_background/check", script: d.script, fields: d.fields, ...(entryId ? { entry_id: entryId } : {}) });
          $(".check").innerHTML = [...r.errors.map((m) => `<div class="msg err">${esc(m)}</div>`), ...r.warnings.map((m) => `<div class="msg warn">${esc(m)}</div>`)].join("")
            || `<div class="msg" style="color:var(--success-color,#43a047)">Ready to run.</div>`;
        } catch (e) { $(".check").innerHTML = `<div class="msg err">${esc(e?.message || e)}</div>`; }
      }, 300);
    };

    const drawFields = () => {
      const box = $(".fields");
      box.innerHTML = "";
      this._form = null;
      if (!d.script) return;
      if (!meta) { box.innerHTML = `<div class="hint">Loading the script's fields…</div>`; return; }
      if (!meta.fields.length) { box.innerHTML = `<div class="hint">This script has no fields — every run is the same.</div>`; runCheck(); return; }
      const labels = {}, helpers = {};
      meta.fields.forEach((f) => { labels[f.key] = f.name || f.key; helpers[f.key] = f.description || undefined; });
      const hint = document.createElement("div");
      hint.className = "hint";
      hint.textContent = `Fields of ${meta.name}${meta.mode ? ` (mode: ${meta.mode}${meta.max ? `, max ${meta.max}` : ""})` : ""}`;
      const f = document.createElement("ha-form");
      f.hass = this._hass;
      f.schema = meta.fields.map((x) => ({ name: x.key, required: !!x.required, selector: normSelector(x.selector) }));
      f.data = d.fields;
      f.computeLabel = (s) => labels[s.name];
      f.computeHelper = (s) => helpers[s.name];
      f.addEventListener("value-changed", (e) => { e.stopPropagation(); d.fields = { ...e.detail.value }; f.data = d.fields; fail(""); runCheck(); });
      box.appendChild(hint);
      box.appendChild(f);
      this._form = f;
      runCheck();
    };

    const loadMeta = async (keepValues) => {
      meta = null; drawFields();
      if (!d.script) return;
      try {
        meta = await h.callWS({ type: "sb_background/script_fields", script: d.script });
        // keep values for keys the script still has; seed defaults for a new instance
        const keys = new Set(meta.fields.map((x) => x.key));
        const next = {};
        for (const [k, v] of Object.entries(d.fields)) if (keys.has(k) || keepValues) next[k] = v;
        for (const x of meta.fields) if (!(x.key in next) && x.default !== undefined && x.default !== null) next[x.key] = x.default;
        d.fields = next;
      } catch (e) { meta = { fields: [], name: d.script }; fail(String(e?.message || e)); }
      drawFields();
    };

    $(".nm").addEventListener("input", (e) => { d.name = e.target.value; fail(""); });
    $(".sc").addEventListener("change", async (e) => { d.script = e.target.value; fail(""); await loadMeta(false); });
    $(".x").addEventListener("click", requestClose);
    $(".cancel").addEventListener("click", requestClose);
    dlg.addEventListener("cancel", (e) => { e.preventDefault(); requestClose(); });
    $(".ok").addEventListener("click", async () => {
      if (!d.name.trim()) return fail("Give the instance a name.");
      if (!d.script) return fail("Choose a script.");
      const missing = (meta?.fields || []).filter((x) => x.required && [undefined, null, ""].includes(d.fields[x.key]) || (x.required && Array.isArray(d.fields[x.key]) && !d.fields[x.key].length));
      if (missing.length) return fail(`Fill in: ${missing.map((x) => x.name || x.key).join(", ")}.`);
      $(".ok").disabled = true;
      try {
        await h.callWS({ type: "sb_background/save", name: d.name.trim(), script: d.script, fields: d.fields, ...(entryId ? { entry_id: entryId } : {}) });
        close();
        this._msg = entryId ? `Saved ${d.name.trim()} — it restarts with the new values.` : `Created ${d.name.trim()} — it starts in a moment.`;
        this._sig = ""; this._render();
      } catch (e) { fail(String(e?.message || e)); $(".ok").disabled = false; }
    });

    this._guard(dlg);
    dlg.showModal();
    if (d.script) { await loadMeta(true); start = snap(); }
  }

  // showModal() makes the page inert to clicks only: wheel / touch over the backdrop
  // still scroll the dashboard (learned in sb-scheduler-card). Swallow those.
  _guard(dlg) {
    this._unguard?.();
    const body = () => dlg.querySelector(".dbody");
    const onWheel = (e) => {
      const b = body();
      if (!b || !e.composedPath().includes(b)) { e.preventDefault(); return; }
      const atTop = b.scrollTop <= 0, atBottom = b.scrollTop + b.clientHeight >= b.scrollHeight - 1;
      if ((e.deltaY < 0 && atTop) || (e.deltaY > 0 && atBottom)) e.preventDefault();
    };
    const onTouch = (e) => { const b = body(); if (b && !e.composedPath().includes(b)) e.preventDefault(); };
    window.addEventListener("wheel", onWheel, { capture: true, passive: false });
    window.addEventListener("touchmove", onTouch, { capture: true, passive: false });
    this._unguard = () => {
      window.removeEventListener("wheel", onWheel, { capture: true });
      window.removeEventListener("touchmove", onTouch, { capture: true });
      this._unguard = null;
    };
  }
}

// The dashboard's visual card editor. Title, as in the SB Scheduler card, plus which
// scripts' instances the card shows (empty = all; exactly one also preselects it in + Add).
class SbBackgroundCardEditor extends HTMLElement {
  setConfig(config) {
    this._config = { ...(config || {}) };
    if (this._form) this._form.data = this._data();
  }
  set hass(h) {
    this._hass = h;
    if (this._form) this._form.hass = h; else this._build();
  }
  _data() { return { title: this._config.title ?? "", scripts: this._config.scripts || [] }; }
  async _build() {
    if (this._building || !this._hass) return;
    this._building = true;
    if (!(await loadHaForm())) { this.textContent = "HA's form element did not load — edit this card in YAML."; return; }
    const f = document.createElement("ha-form");
    f.hass = this._hass;
    f.schema = [
      { name: "title", selector: { text: {} } },
      { name: "scripts", selector: { entity: { domain: "script", multiple: true } } },
    ];
    f.data = this._data();
    f.computeLabel = (x) => ({ title: "Title", scripts: "Only instances of these scripts" }[x.name]);
    f.computeHelper = (x) => (x.name === "scripts" ? "Leave empty to show every instance. With exactly one, + Add starts with that script." : undefined);
    f.addEventListener("value-changed", (e) => {
      e.stopPropagation();
      const v = e.detail.value || {};
      const next = { ...this._config, title: v.title ?? "" };
      if ((v.scripts || []).length) next.scripts = v.scripts; else delete next.scripts;
      this._config = next;
      this.dispatchEvent(new CustomEvent("config-changed", { detail: { config: next }, bubbles: true, composed: true }));
    });
    this.appendChild(f);
    this._form = f;
  }
}

if (!customElements.get(CARD)) customElements.define(CARD, SbBackgroundCard);
if (!customElements.get(`${CARD}-editor`)) customElements.define(`${CARD}-editor`, SbBackgroundCardEditor);
window.customCards = window.customCards || [];
if (!window.customCards.some((c) => c.type === CARD)) {
  window.customCards.push({ type: CARD, name: "SB Background", preview: false, documentationURL: "https://github.com/snadboy/sb-background",
    description: "Background script instances: status, start/stop, restart, add and edit." });
}

// ---- the sidebar page ---------------------------------------------------------------
class SbBackgroundPanel extends HTMLElement {
  set hass(h) { this._hass = h; this._build(); this._card.hass = h; this._menu.hass = h; }
  set narrow(v) { this._narrow = v; if (this._menu) this._menu.narrow = v; }
  set route(_v) {}
  set panel(_v) {}

  _build() {
    if (this._card) return;
    const root = this.attachShadow({ mode: "open" });
    root.innerHTML = `<style>
      :host { display: block; min-height: 100vh; background: var(--primary-background-color); color: var(--primary-text-color); }
      .bar { display: flex; align-items: center; gap: 4px; height: var(--header-height, 56px); padding: 0 12px; box-sizing: border-box; position: sticky; top: 0; z-index: 2;
             background: var(--app-header-background-color, var(--primary-color)); color: var(--app-header-text-color, #fff); border-bottom: 1px solid var(--divider-color); }
      .title { font-size: 20px; flex: 1; margin-left: 4px; }
      .bar a { color: inherit; font-size: 14px; opacity: .85; text-decoration: none; padding: 6px 10px; border-radius: 14px; }
      .bar a:hover { background: rgba(127,127,127,.2); opacity: 1; }
      .page { padding: 16px; } .col { max-width: 860px; margin: 0 auto; }
      .intro { color: var(--secondary-text-color); font-size: 14px; margin: 0 4px 12px; line-height: 1.5; }
      .settings { display: flex; align-items: center; gap: 8px; margin: 6px 4px 0; font-size: 14px; flex-wrap: wrap; }
      .settings.first { margin-top: 16px; }
      .settings select { max-width: 100%; min-width: 0; font: inherit; padding: 6px; border-radius: 6px; border: 1px solid var(--divider-color);
                         background: var(--card-background-color); color: var(--primary-text-color); color-scheme: light dark; }
      .settings .ok { color: var(--success-color, #43a047); }
      .ver { color: var(--secondary-text-color); font-size: 12px; margin: 12px 4px 0; }
    </style>
    <div class="bar"><ha-menu-button></ha-menu-button><div class="title">SB Background</div><a href="/config/integrations/integration/sb_background">Integration page</a></div>
    <div class="page"><div class="col">
      <div class="intro">An instance is a script plus the values for its fields. SB Background starts every enabled instance when Home Assistant starts, restarts it whenever its run ends, and tells you (settings below) when one cannot run or keeps failing. What an instance <i>does</i> is its script — edit that under Settings → Scripts as usual.</div>
      <div class="slot"></div>
      <div class="settings first"><b>When an instance needs attention</b> (always a Repairs issue), also:</div>
      <div class="settings"><label><input type="checkbox" class="pn"> show it in Notifications</label></div>
      <div class="settings">push it to <select class="ns"><option>…</option></select><span class="saved"></span></div>
      <div class="ver">SB Background ${VERSION}</div>
    </div></div>`;
    this._menu = root.querySelector("ha-menu-button");
    this._menu.narrow = this._narrow;
    const card = document.createElement(CARD);
    card.setConfig({ title: "Instances", panel: true });
    root.querySelector(".slot").appendChild(card);
    this._card = card;
    this._settings(root);
    this._deepLink();
  }

  async _settings(root) {
    const sel = root.querySelector(".ns"), bell = root.querySelector(".pn"), saved = root.querySelector(".saved");
    const label = (svc) => {        // notify.mobile_app_pixel_snadboy → "Pixel Snadboy (mobile app)"
      const m = /^notify\.mobile_app_(.+)$/.exec(svc);
      const t = (m ? m[1] : svc.replace(/^notify\./, "")).replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
      return m ? `${t} (mobile app)` : t;
    };
    const draw = (s) => {
      const opts = ["", ...s.notify_services];
      if (s.notify_service && !opts.includes(s.notify_service)) opts.push(s.notify_service);
      sel.innerHTML = opts.map((o) => `<option value="${esc(o)}" ${o === (s.notify_service || "") ? "selected" : ""}>${o ? `${esc(label(o))} — ${esc(o)}` : "— no device —"}</option>`).join("");
      bell.checked = s.persistent !== false;
    };
    const save = async (patch) => {
      try { draw(await this._hass.callWS({ type: "sb_background/settings", ...patch })); saved.className = "saved ok"; saved.textContent = "Saved."; }
      catch (e) { saved.className = "saved"; saved.textContent = String(e?.message || e); }
    };
    try { draw(await this._hass.callWS({ type: "sb_background/settings" })); } catch (e) { saved.textContent = String(e?.message || e); }
    sel.addEventListener("change", () => save({ notify_service: sel.value }));
    bell.addEventListener("change", () => save({ persistent: bell.checked }));
  }

  async _deepLink() {
    const q = new URLSearchParams(location.search);
    const edit = q.get("edit"), add = q.get("add");
    if (!edit && !add) return;
    history.replaceState(history.state, "", location.pathname);
    for (let i = 0; i < 40 && !this._hass; i++) await new Promise((r) => setTimeout(r, 250));
    if (add) { this._card._openEditor(null); return; }
    const inst = this._card._instances().find((x) => x.entryId === edit);
    if (inst) this._card._openEditor(inst);
  }
}
if (!customElements.get("sb-background-panel")) customElements.define("sb-background-panel", SbBackgroundPanel);
console.info(`%c SB-BACKGROUND %c v${VERSION} `, "background:#37474f;color:#fff", "background:#90a4ae;color:#000");
