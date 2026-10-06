/**
 * Technician dashboard (Platform 2.0, Phase 1).
 *
 * Two presentations of the same data:
 *   - the idle screen (`#idle-dashboard`): today's cards and the last few
 *     sessions, shown only while no session exists (data-session="none");
 *   - the Dashboard dialog (`#dashboard-modal`): cards, the live session queue
 *     (click a row to switch to it), and searchable recent history.
 *
 * Live rows and the Active / Waiting / Reconnecting counts come from THIS
 * console's own sessions (they are what the technician can act on, and they
 * change faster than any poll). "Completed today" and the history come from
 * GET /api/agent/dashboard, which the server pins to the signed-in technician.
 * Sessions open in another window are counted by the server and called out
 * separately rather than silently merged.
 *
 * Read-only towards the customer: nothing here sends anything on a session
 * socket. Every string from the server is rendered as text, never as markup.
 */

const el = (id) => document.getElementById(id);

const REFRESH_OPEN_MS = 15_000;
const REFRESH_IDLE_MS = 30_000;

/**
 * @param {object} hooks
 * @param {() => Array<{key:number,label:string,user:string|null,device:string|null,status:string,state:string,duration:string|null}>} hooks.liveRows
 * @param {(key:number) => void} hooks.select
 * @param {() => void} hooks.startSession
 * @param {() => {live:number,max:number}} hooks.slots
 */
export function initDashboard(hooks) {
  const modal = el("dashboard-modal");
  const search = el("dash-search");
  const filter = el("dash-filter");
  let lastData = null;
  let inFlight = null;
  let pendingQuery = false;
  let timer = null;
  let searchDebounce = null;

  /** Local midnight, so "today" is the technician's day, not UTC's. */
  function localMidnightIso() {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d.toISOString();
  }

  async function fetchData() {
    const api = window.hdaConsole?.api;
    if (!api) return null;
    const params = new URLSearchParams({ since: localMidnightIso() });
    const q = search?.value.trim() ?? "";
    if (q) params.set("q", q);
    if (filter?.value) params.set("phase", filter.value);
    return api(`/api/agent/dashboard?${params}`);
  }

  /** One request at a time; a change while one is running queues exactly one more. */
  async function refresh() {
    if (inFlight) { pendingQuery = true; return inFlight; }
    inFlight = (async () => {
      try {
        lastData = await fetchData();
        if (el("dash-error")) el("dash-error").textContent = "";
      } catch (err) {
        if (el("dash-error")) el("dash-error").textContent = "Could not load recent sessions. They will refresh automatically.";
        console.warn("[dashboard] refresh failed:", err?.message ?? err);
      } finally {
        inFlight = null;
      }
      render();
      if (pendingQuery) { pendingQuery = false; void refresh(); }
    })();
    return inFlight;
  }

  function schedule() {
    clearInterval(timer);
    const idle = document.body.dataset.session === "none";
    if (!modal?.open && !idle) return;
    timer = setInterval(() => void refresh(), modal?.open ? REFRESH_OPEN_MS : REFRESH_IDLE_MS);
  }

  /* -------------------------------------------------------------- rendering */

  function cardsData() {
    const rows = hooks.liveRows();
    const local = {
      active: rows.filter((r) => r.state === "connected" || r.state === "held").length,
      waiting: rows.filter((r) => r.state === "waiting" || r.state === "consent" || r.state === "connecting").length,
      reconnecting: rows.filter((r) => r.state === "reconnecting").length,
    };
    return [
      ["Active", local.active, "active"],
      ["Waiting", local.waiting, "waiting"],
      ["Reconnecting", local.reconnecting, "reconnecting"],
      ["Completed today", lastData ? lastData.counts.completedToday : "–", "completed"],
    ];
  }

  function renderCards() {
    for (const host of document.querySelectorAll("[data-dash-cards]")) {
      host.replaceChildren(...cardsData().map(([label, value, key]) => {
        const card = document.createElement("div");
        card.className = `dash-card dash-card-${key}`;
        const v = document.createElement("span");
        v.className = "dash-card-value";
        v.textContent = String(value);
        const l = document.createElement("span");
        l.className = "dash-card-label";
        l.textContent = label;
        card.append(v, l);
        return card;
      }));
    }
  }

  function cell(text, cls) {
    const td = document.createElement("td");
    td.textContent = text ?? "—";
    if (cls) td.className = cls;
    return td;
  }

  function renderQueue() {
    const body = el("dash-queue")?.querySelector("tbody");
    if (!body) return;
    const rows = hooks.liveRows();
    body.replaceChildren(...rows.map((r) => {
      const tr = document.createElement("tr");
      tr.tabIndex = 0;
      tr.className = "dash-row";
      tr.dataset.state = r.state;
      tr.title = "Switch to this session";
      const status = cell(r.status, "dash-status");
      status.dataset.state = r.state;
      tr.append(cell(r.user), cell(r.device ?? r.label), status, cell(r.duration ?? "—", "dash-num"));
      const go = () => { modal?.close(); hooks.select(r.key); };
      tr.addEventListener("click", go);
      tr.addEventListener("keydown", (ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); go(); } });
      return tr;
    }));
    el("dash-queue-empty").hidden = rows.length > 0;
    el("dash-queue").hidden = rows.length === 0;

    const { live, max } = hooks.slots();
    const slots = el("dash-slots");
    if (slots) {
      slots.textContent = `Active sessions ${live} / ${max}`;
      slots.dataset.full = String(live >= max);
    }
    el("dash-limit").hidden = live < max;
    el("dash-new").disabled = live >= max;

    const elsewhere = lastData ? Math.max(0, lastData.live - rows.length) : 0;
    const note = el("dash-elsewhere");
    note.hidden = elsewhere === 0;
    note.textContent = elsewhere === 0 ? "" :
      `${elsewhere} more session${elsewhere === 1 ? " is" : "s are"} open in another browser window and count towards your limit.`;
  }

  function fmtDuration(secs) {
    if (typeof secs !== "number") return "—";
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    const s = secs % 60;
    return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
  }

  function fmtEnded(iso) {
    if (!iso) return "—";
    const d = new Date(iso);
    const today = new Date();
    return d.toDateString() === today.toDateString()
      ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
      : d.toLocaleDateString([], { month: "short", day: "numeric" }) + " " + d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  const RESULT = { ENDED: "Completed", DECLINED: "Declined", EXPIRED: "Expired", FAILED: "Failed" };

  function renderRecent() {
    const items = lastData?.recent ?? [];
    const body = el("dash-recent")?.querySelector("tbody");
    if (body) {
      body.replaceChildren(...items.map((r) => {
        const tr = document.createElement("tr");
        tr.title = `Session ${r.id}${r.endReasonLabel ? ` — ${r.endReasonLabel}` : ""}`;
        const result = cell(RESULT[r.phase] ?? r.phase, "dash-status");
        result.dataset.phase = r.phase;
        tr.append(cell(r.machine), cell(r.user), cell(fmtEnded(r.endedAt), "dash-num"), cell(fmtDuration(r.durationSeconds), "dash-num"), result);
        return tr;
      }));
      el("dash-recent-empty").hidden = items.length > 0 || lastData === null;
    }

    const compact = document.querySelector("[data-dash-recent-compact]");
    if (compact) {
      const top = items.slice(0, 4);
      compact.replaceChildren(...(top.length === 0
        ? [Object.assign(document.createElement("li"), { className: "idle-recent-empty", textContent: lastData ? "No sessions yet today." : "Loading…" })]
        : top.map((r) => {
          const li = document.createElement("li");
          const name = document.createElement("span");
          name.className = "idle-recent-name";
          name.textContent = r.machine ?? "Unknown device";
          const meta = document.createElement("span");
          meta.className = "idle-recent-meta";
          meta.textContent = `${RESULT[r.phase] ?? r.phase} · ${fmtEnded(r.endedAt)}`;
          li.append(name, meta);
          return li;
        })));
    }
  }

  function render() {
    renderCards();
    if (modal?.open) renderQueue();
    renderRecent();
    const upd = el("dash-updated");
    if (upd && lastData) upd.textContent = `Updated ${new Date(lastData.generatedAt).toLocaleTimeString()}`;
  }

  /* ------------------------------------------------------------- open/close */

  function open() {
    if (!modal) return;
    if (!modal.open) modal.showModal();
    renderQueue();
    render();
    void refresh();
    schedule();
  }

  el("open-dashboard")?.addEventListener("click", open);
  el("idle-open-dashboard")?.addEventListener("click", open);
  el("dash-close")?.addEventListener("click", () => modal?.close());
  modal?.addEventListener("close", schedule);
  el("dash-new")?.addEventListener("click", () => {
    modal?.close();
    hooks.startSession();
  });
  search?.addEventListener("input", () => {
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => void refresh(), 250);
  });
  filter?.addEventListener("change", () => void refresh());

  // First load once the identity (and with it the API's CSRF token) is ready.
  window.hdaConsole?.ready?.then(() => { void refresh(); schedule(); }).catch(() => {});

  return {
    /** The console's sessions changed: re-render from local state; refetch when one ended. */
    changed({ ended = false } = {}) {
      renderCards();
      if (modal?.open) renderQueue();
      if (ended) void refresh();
      schedule();
    },
    open,
    get isOpen() { return !!modal?.open; },
  };
}
