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
const VERSION = "0.2.1";
const CARD = "sb-background-card";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const STATUS = {
  waiting:    { label: "Waiting for start-up", color: "var(--secondary-text-color)" },
  running:    { label: "Running",              color: "var(--success-color, #43a047)" },
  restarting: { label: "Restarting",           color: "var(--warning-color, #ffa000)" },
  failing:    { label: "Failing",              color: "var(--error-color, #db4437)" },
  invalid:    { label: "Cannot run",           color: "var(--error-color, #db4437)" },
  stopped:    { label: "Stopped",              color: "var(--disabled-text-color, #9e9e9e)" },
};

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

const STYLE = `
:host { display: block; }
ha-card { padding: 12px 16px 8px; }
.head { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; }
.head .title { flex: 1; font-size: 1.15em; font-weight: 500; }
button { font: inherit; cursor: pointer; border-radius: 16px; border: 1px solid var(--divider-color); background: none;
         color: var(--primary-text-color); padding: 4px 12px; }
button:hover { background: rgba(127,127,127,.12); }
button.primary { background: var(--primary-color); color: var(--text-primary-color, #fff); border-color: transparent; }
button.danger { color: var(--error-color); border-color: var(--error-color); }
button:disabled { opacity: .5; cursor: default; }
.empty { color: var(--secondary-text-color); padding: 12px 0; }
.row { border-top: 1px solid var(--divider-color); padding: 10px 0; display: flex; gap: 10px; align-items: flex-start; flex-wrap: wrap; }
.row:first-of-type { border-top: none; }
.dot { width: 10px; height: 10px; border-radius: 50%; margin-top: 6px; flex: 0 0 10px; }
.info { flex: 1 1 200px; min-width: 0; }
.name { font-weight: 500; }
.sub { color: var(--secondary-text-color); font-size: .88em; margin-top: 2px; }
.msg { font-size: .85em; margin-top: 3px; }
.msg.err { color: var(--error-color); }
.msg.warn { color: var(--warning-color, #ffa000); }
.ctl { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.ctl button { padding: 3px 10px; font-size: .88em; }
.toggle { position: relative; width: 36px; height: 20px; display: inline-block; }
.toggle input { opacity: 0; width: 0; height: 0; }
.toggle span { position: absolute; inset: 0; background: var(--disabled-color, #bdbdbd); border-radius: 10px; transition: .2s; cursor: pointer; }
.toggle span:before { content: ""; position: absolute; width: 16px; height: 16px; left: 2px; top: 2px; background: #fff; border-radius: 50%; transition: .2s; }
.toggle input:checked + span { background: var(--primary-color); }
.toggle input:checked + span:before { transform: translateX(16px); }
.confirm { width: 100%; border: 1px solid var(--error-color); border-radius: 8px; padding: 8px 10px; font-size: .9em;
           display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.confirm .spacer { flex: 1; }
.note { color: var(--secondary-text-color); font-size: .85em; padding: 6px 0 2px; }

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
  disconnectedCallback() { clearInterval(this._tick); this._unguard?.(); }

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

  _render() {
    if (!this._config) return;
    const list = this._instances();
    const now = Date.now();
    const rows = list.map((i) => {
      const a = i.attr, s = STATUS[i.status] || { label: i.status, color: "var(--secondary-text-color)" };
      let sub = `${esc(a.script_name || a.script)}`;
      if ((i.status === "running" || i.status === "failing") && a.running_since) sub += ` · running for ${ago(a.running_since, now)}`;
      if (a.next_start && i.status !== "running") sub += ` · next try in ${until(a.next_start, now)}`;
      if (a.runs > 1) sub += ` · ${a.runs - 1} restart${a.runs === 2 ? "" : "s"}`;
      const msgs = [
        ...(a.errors || []).map((m) => `<div class="msg err">${esc(m)}</div>`),
        ...(a.warnings || []).map((m) => `<div class="msg warn">${esc(m)}</div>`),
        ...(a.last_error && i.status !== "running" ? [`<div class="msg err">Last error${a.last_end ? ` (${ago(a.last_end, now)} ago)` : ""}: ${esc(a.last_error)}</div>`] : []),
      ].join("");
      const confirming = this._confirm === i.entryId;
      return `<div class="row" data-e="${esc(i.entryId)}">
        <div class="dot" style="background:${s.color}" title="${esc(s.label)}"></div>
        <div class="info"><div class="name">${esc(i.name)} <span class="sub">— ${esc(s.label)}</span></div>
          <div class="sub">${sub}</div>${msgs}</div>
        <div class="ctl">
          ${i.switchEntity ? `<label class="toggle" title="${a.enabled ? "Enabled — click to stop" : "Stopped — click to enable"}"><input type="checkbox" class="en" ${a.enabled ? "checked" : ""}><span></span></label>` : ""}
          <button class="restart" ${!a.enabled || !i.buttonEntity || this._busy[i.entryId] ? "disabled" : ""} title="Stop this run and start it again now">Restart</button>
          <button class="edit">Edit</button>
          <button class="dup" title="A new instance with these values">Duplicate</button>
          <button class="del danger" title="Delete this instance">✕</button>
        </div>
        ${confirming ? `<div class="confirm">Delete “${esc(i.name)}”? Its run stops; the script itself is not touched.<span class="spacer"></span>
          <button class="nodel">Keep</button><button class="dodel danger">Delete</button></div>` : ""}
      </div>`;
    }).join("");
    this.shadowRoot.querySelector(".body").innerHTML = `
      <div class="head"><div class="title">${esc(this._config.title)}</div><button class="add primary">+ Add</button></div>
      ${rows || `<div class="empty">${(this._config.scripts || []).length
        ? `No instances of ${esc((this._config.scripts || []).map((s) => this._hass?.states[s]?.attributes?.friendly_name || s).join(", "))} yet.`
        : "No background instances yet. Add one: pick a script and fill in its fields."}</div>`}
      ${this._msg ? `<div class="note">${esc(this._msg)}</div>` : ""}`;
    this._wire();
  }

  _wire() {
    const root = this.shadowRoot.querySelector(".body");
    const byRow = (el) => this._instances().find((i) => i.entryId === el.closest(".row")?.dataset.e);
    root.querySelector("button.add")?.addEventListener("click", () => this._openEditor(null));
    root.querySelectorAll("input.en").forEach((el) => el.addEventListener("change", () => {
      const i = byRow(el);
      this._hass.callService("switch", el.checked ? "turn_on" : "turn_off", { entity_id: i.switchEntity });
    }));
    root.querySelectorAll("button.restart").forEach((b) => b.addEventListener("click", async () => {
      const i = byRow(b);
      this._busy[i.entryId] = true; this._render();
      try { await this._hass.callService("button", "press", { entity_id: i.buttonEntity }); }
      finally { delete this._busy[i.entryId]; this._sig = ""; this._render(); }
    }));
    root.querySelectorAll("button.edit").forEach((b) => b.addEventListener("click", () => this._openEditor(byRow(b))));
    root.querySelectorAll("button.dup").forEach((b) => b.addEventListener("click", () => this._openEditor(byRow(b), { copy: true })));
    root.querySelectorAll("button.del").forEach((b) => b.addEventListener("click", () => { this._confirm = byRow(b).entryId; this._render(); }));
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
      .settings select { font: inherit; padding: 6px; border-radius: 6px; border: 1px solid var(--divider-color);
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
    card.setConfig({ title: "Instances" });
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
