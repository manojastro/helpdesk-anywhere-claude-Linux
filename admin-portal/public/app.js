/**
 * Helpdesk Anywhere — admin portal (separate application from the technician
 * console; served only by the admin listener, talks only to /api/admin/*).
 *
 * Rendering rule: every piece of data reaches the DOM through textContent or an
 * attribute set on a created element — never innerHTML — so chat, notes, device
 * names and URLs cannot inject markup. Links are created only for http(s) URLs,
 * with rel="noopener noreferrer".
 *
 * Hiding a nav item or a button here is a courtesy. Every action is authorised
 * again on the server, which is the control.
 */

const $view = document.getElementById("view");
const $title = document.getElementById("page-title");
const $flash = document.getElementById("flash");
const $tooltip = document.getElementById("tooltip");

const state = { me: null, csrf: "", perms: new Set(), teams: [], liveTimer: null };

/* ------------------------------------------------------------------ helpers */

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "text") el.textContent = v;
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else if (k === "dataset") Object.assign(el.dataset, v);
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

function fmtTime(v) {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "medium" });
}

function timeCell(v, never = "—") {
  const t = fmtTime(v);
  return t ? h("time", { datetime: new Date(v).toISOString(), text: t }) : h("span", { class: "never", text: never });
}

function fmtDuration(sec) {
  if (sec === null || sec === undefined) return "—";
  const h_ = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h_ > 0 ? `${h_}h ${m}m` : m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function safeLink(url, label) {
  try {
    const u = new URL(url);
    if (u.protocol === "http:" || u.protocol === "https:") {
      return h("a", { href: u.href, target: "_blank", rel: "noopener noreferrer", text: label || u.href });
    }
  } catch { /* fall through */ }
  return h("span", { text: label ? `${label} (${url})` : url });
}

function flash(text, kind = "ok") {
  $flash.textContent = text;
  $flash.dataset.kind = kind;
  $flash.hidden = false;
  clearTimeout(flash.t);
  flash.t = setTimeout(() => { $flash.hidden = true; }, kind === "error" ? 8000 : 4000);
}

const ERRORS = {
  forbidden: "Your role does not allow that.",
  csrf: "Your page is out of date. Reload and try again.",
  not_found: "Not found, or not visible to your role.",
  entra_role_required: "This person has no Helpdesk Anywhere app role in Microsoft Entra ID. Assign one in the Entra admin center, then ask them to sign in again.",
  agent_code_taken: "That agent ID is already in use.",
  invalid_agent_code: "Agent ID: 1–32 letters, digits, dot, dash or underscore.",
  last_admin: "You cannot suspend the last active administrator.",
  cannot_suspend_self: "You cannot suspend your own access.",
  rate_limited: "Too many requests. Wait a moment.",
  not_live: "That session is no longer live.",
  team_exists: "A team with that name already exists.",
  invalid_script: "Check the script fields: name 1–120 characters, a category, a shell, who it runs as, and a script body.",
  archived: "That script is archived and can no longer be changed.",
};

async function api(path, { method = "GET", body } = {}) {
  const headers = { Accept: "application/json" };
  if (method !== "GET") headers["X-CSRF-Token"] = state.csrf;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(`/api/admin${path}`, {
    method, headers, credentials: "same-origin", body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401) {
    location.assign(`/login?returnTo=${encodeURIComponent("/")}`);
    throw new Error("signed out");
  }
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error(ERRORS[data?.error] || data?.message || `Request failed (${res.status})`);
    err.code = data?.error;
    throw err;
  }
  return data;
}

const can = (p) => state.perms.has(p);

function statusBadge(status) {
  const map = { active: "badge-good", pending: "badge-warn", suspended: "badge-crit", waiting_for_customer: "badge-info",
    waiting_for_consent: "badge-info", ended: "badge-muted", ready: "badge-good", failed: "badge-crit", expired: "badge-muted" };
  const label = { waiting_for_customer: "waiting for customer", waiting_for_consent: "awaiting consent" }[status] ?? status;
  return h("span", { class: `badge ${map[status] ?? "badge-muted"}`, text: label });
}

function table(columns, rows, { onRow, empty = "Nothing to show." } = {}) {
  const thead = h("thead", {}, h("tr", {}, columns.map((c) => h("th", { class: c.num ? "num" : null, scope: "col", text: c.label }))));
  const tbody = h("tbody");
  if (rows.length === 0) tbody.append(h("tr", {}, h("td", { colspan: columns.length, class: "empty", text: empty })));
  for (const r of rows) {
    const tr = h("tr", { class: onRow ? "clickable" : null, tabindex: onRow ? 0 : null });
    for (const c of columns) {
      const v = c.render(r);
      tr.append(h("td", { class: c.num ? "num" : null }, v instanceof Node ? v : v ?? "—"));
    }
    if (onRow) {
      tr.addEventListener("click", (e) => { if (!e.target.closest("button, a, input, select")) onRow(r); });
      tr.addEventListener("keydown", (e) => { if (e.key === "Enter") onRow(r); });
    }
    tbody.append(tr);
  }
  return h("div", { class: "table-wrap" }, h("table", {}, thead, tbody));
}

function card(title, sub, ...body) {
  return h("section", { class: "card" }, h("h2", { text: title }), sub ? h("p", { class: "sub", text: sub }) : null, ...body);
}

function dialog(title, content, actions) {
  const d = h("dialog", {}, h("h2", { text: title }), content, h("div", { class: "actions", style: "margin-top:14px;justify-content:flex-end" }, actions));
  document.body.append(d);
  d.addEventListener("close", () => d.remove());
  d.showModal();
  return d;
}

/* ------------------------------------------------------------------- router */

const routes = {
  overview: { title: "Overview", perm: "dashboard.view", render: renderOverview },
  agents: { title: "Agents & access", perm: "users.read", render: renderAgents },
  live: { title: "Live sessions", perm: "sessions.read", render: renderLive },
  history: { title: "Session history", perm: "sessions.read", render: renderHistory },
  session: { title: "Session detail", perm: "sessions.read", render: renderSession },
  reports: { title: "Reports", perm: "reports.export", render: renderReports },
  audit: { title: "Audit trail", perm: "audit.read", render: renderAudit },
  scripts: { title: "Script library", perm: "scripts.read", render: renderScripts },
  settings: { title: "Settings", perm: "dashboard.view", render: renderSettings },
};

function parseHash() {
  const [path, query = ""] = location.hash.replace(/^#\/?/, "").split("?");
  const parts = path.split("/").filter(Boolean);
  const name = parts[0] === "sessions" && parts[1] ? "session" : parts[0] || "overview";
  return { name, arg: parts[1] ? decodeURIComponent(parts[1]) : null, params: new URLSearchParams(query) };
}

async function navigate() {
  clearInterval(state.liveTimer);
  const { name, arg, params } = parseHash();
  let route = routes[name];
  if (!route || !can(route.perm)) route = routes[Object.keys(routes).find((k) => can(routes[k].perm) && k !== "session")] ?? null;
  document.querySelectorAll("#nav a").forEach((a) => {
    a.toggleAttribute("aria-current", a.dataset.route === name || (name === "session" && a.dataset.route === "history"));
    if (a.hasAttribute("aria-current")) a.setAttribute("aria-current", "page");
  });
  document.getElementById("sidebar").classList.remove("open");
  $view.replaceChildren();
  if (!route) {
    $view.append(card("No access", "Your role has no admin portal sections."));
    return;
  }
  $title.textContent = route.title;
  document.title = `${route.title} — Helpdesk Anywhere Admin`;
  try {
    await route.render(arg, params);
  } catch (err) {
    $view.append(h("div", { class: "callout callout-crit", text: err.message }));
  }
  $view.focus({ preventScroll: true });
}

/* ------------------------------------------------------------------ overview */

async function renderOverview() {
  const d = await api("/dashboard");
  const scopeNote = d.scope === "team" ? "Your team only." : "Whole organisation.";
  const tile = (label, value, def) => h("div", { class: "tile" }, h("div", { class: "label", text: label }), h("div", { class: "value", text: String(value) }), h("div", { class: "def", text: def }));

  if (!d.storage.databaseOk || d.storage.recordWriteFailuresSinceStart > 0 || d.incompleteRecords > 0) {
    $view.append(h("div", { class: "callout callout-crit" },
      h("strong", { text: "Record storage problems. " }),
      `${d.storage.recordWriteFailuresSinceStart} session record write(s) failed since the server started; `,
      `${d.incompleteRecords} session record(s) are marked incomplete.`,
      d.storage.lastDatabaseError ? ` Last database error: ${d.storage.lastDatabaseError}` : ""));
  }

  $view.append(h("div", { class: "tiles" },
    tile("Agents online", d.agentsOnline, d.definitions.agentsOnline),
    tile("Active sessions", d.activeSessions, d.definitions.activeSessions),
    tile("Waiting sessions", d.waitingSessions, "Code issued or awaiting the customer's consent."),
    tile("Created today", d.createdToday, d.definitions.createdToday),
    tile("Completed today", d.completedToday, d.definitions.completedToday),
    tile("Avg. active time today", fmtDuration(d.avgDurationTodaySeconds), `Declined today: ${d.declinedToday}.`),
  ));

  $view.append(h("div", { class: "grid-2" },
    card("Sessions per day", `Last 14 days, ${scopeNote}`, trendChart(d.trend)),
    card("Online now", "Technicians with a console heartbeat inside the presence window.",
      d.onlineAgents.length === 0 ? h("p", { class: "empty", text: "No technicians online." })
        : h("ul", {}, d.onlineAgents.map((a) => h("li", { text: a.agentCode ? `${a.name} (${a.agentCode})` : a.name })))),
  ));

  $view.append(card("By technician", "Last 30 days.", table([
    { label: "Technician", render: (r) => r.name },
    { label: "Agent ID", render: (r) => r.agentCode ?? "—" },
    { label: "Sessions", num: true, render: (r) => String(r.sessions) },
    { label: "Completed", num: true, render: (r) => String(r.completed) },
    { label: "Active time", num: true, render: (r) => fmtDuration(r.activeSeconds) },
  ], d.byAgent, { empty: "No sessions in the last 30 days." })));

  $view.append(card("Recent sessions", null, sessionsTable(d.recent)));
}

/** Grouped bars (created vs completed per day), one y-axis, legend + hover + table view. */
function trendChart(rows) {
  const W = 640, H = 220, padL = 32, padB = 26, padT = 8;
  const max = Math.max(1, ...rows.map((r) => Math.max(r.created, r.completed)));
  const ticks = niceTicks(max);
  const top = ticks[ticks.length - 1];
  const plotW = W - padL, plotH = H - padB - padT;
  const band = plotW / rows.length;
  const barW = Math.max(3, Math.min(14, (band - 8) / 2));
  const y = (v) => padT + plotH - (v / top) * plotH;
  const NS = "http://www.w3.org/2000/svg";
  const s = (tag, attrs) => { const e = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); return e; };

  const svg = s("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": "Sessions created and completed per day" });
  for (const t of ticks) {
    svg.append(s("line", { x1: padL, x2: W, y1: y(t), y2: y(t), class: "gridline" }));
    const lbl = s("text", { x: padL - 6, y: y(t) + 4, "text-anchor": "end", class: "axis-label" }); lbl.textContent = String(t); svg.append(lbl);
  }
  // Rounded top, square base: a 4px-radius rect clipped by drawing from the baseline.
  const bar = (x, v, color, label, day) => {
    const hgt = Math.max(0, plotH * (v / top));
    const r = Math.min(4, hgt / 2, barW / 2);
    const y0 = padT + plotH, y1 = y0 - hgt;
    const path = hgt === 0 ? `M${x},${y0}h${barW}` :
      `M${x},${y0}V${y1 + r}q0,-${r} ${r},-${r}h${barW - 2 * r}q${r},0 ${r},${r}V${y0}Z`;
    const p = s("path", { d: path, fill: color });
    const hit = s("rect", { x: x - 2, y: padT, width: barW + 4, height: plotH, fill: "transparent" });
    const tip = `${day}\n${label}: ${v}`;
    for (const el of [p, hit]) {
      el.addEventListener("mousemove", (e) => showTip(e, tip));
      el.addEventListener("mouseleave", hideTip);
    }
    svg.append(p, hit);
  };
  rows.forEach((r, i) => {
    const cx = padL + band * i + band / 2;
    bar(cx - barW - 1, r.created, "var(--series-1)", "Created", r.day);
    bar(cx + 1, r.completed, "var(--series-2)", "Completed", r.day);  // 2px surface gap between the pair
    if (i % 2 === rows.length % 2 || rows.length <= 7) {
      const t = s("text", { x: cx, y: H - 8, "text-anchor": "middle", class: "axis-label" }); t.textContent = r.day.slice(5); svg.append(t);
    }
  });

  const tableView = table([
    { label: "Day", render: (r) => r.day },
    { label: "Created", num: true, render: (r) => String(r.created) },
    { label: "Completed", num: true, render: (r) => String(r.completed) },
  ], rows);
  tableView.hidden = true;
  const toggle = h("button", { type: "button", class: "linkish", text: "Show as table",
    onclick: () => { tableView.hidden = !tableView.hidden; chart.hidden = !tableView.hidden; toggle.textContent = tableView.hidden ? "Show as table" : "Show as chart"; } });
  const chart = h("div", { class: "chart" }, svg);
  return h("div", {},
    h("div", { class: "legend" }, h("span", { style: "--c: var(--series-1)", text: "Created" }), h("span", { style: "--c: var(--series-2)", text: "Completed" }), toggle),
    chart, tableView);
}

function niceTicks(max) {
  const step = max <= 5 ? 1 : max <= 10 ? 2 : Math.pow(10, Math.floor(Math.log10(max))) * (max / Math.pow(10, Math.floor(Math.log10(max))) <= 2 ? 0.5 : 1);
  const out = [];
  for (let v = 0; v <= max + step - 1e-9; v += step) out.push(Math.round(v));
  if (out[out.length - 1] < max) out.push(out[out.length - 1] + step);
  return out;
}

function showTip(e, text) {
  $tooltip.textContent = text;
  $tooltip.hidden = false;
  $tooltip.style.left = `${Math.min(e.clientX + 12, innerWidth - 160)}px`;
  $tooltip.style.top = `${e.clientY + 12}px`;
}
function hideTip() { $tooltip.hidden = true; }

/* -------------------------------------------------------------------- agents */

async function loadTeams() {
  state.teams = (await api("/teams")).items;
  return state.teams;
}

function teamSelect(current, id) {
  return h("select", { id }, h("option", { value: "", text: "No team" }),
    state.teams.map((t) => h("option", { value: t.id, text: t.name, selected: t.id === current })));
}

async function renderAgents(_arg, params) {
  await loadTeams();
  const tab = params.get("status") || "pending";
  const data = await api(`/users${tab === "all" ? "" : `?status=${tab}`}`);
  const manage = can("users.manage");

  $view.append(h("div", { class: "callout" },
    h("strong", { text: "Microsoft Entra ID controls who can sign in at all. " }),
    "This portal cannot assign app roles. To give someone access, assign them the Admin, Supervisor, Agent or Auditor app role on the Helpdesk Anywhere enterprise application in the Entra admin center (Enterprise applications → Helpdesk Anywhere → Users and groups). They then sign in once, appear here as Pending, and an administrator activates them. Removing the Entra assignment, or suspending them here, blocks future access."));

  const tabs = h("div", { class: "tabs", role: "tablist" }, ["pending", "active", "suspended", "all"].map((t) =>
    h("button", { type: "button", role: "tab", "aria-selected": String(t === tab), text: t[0].toUpperCase() + t.slice(1),
      onclick: () => { location.hash = `#/agents?status=${t}`; } })));

  const cols = [
    { label: "Name", render: (u) => h("div", {}, h("strong", { text: u.displayName }), h("div", { class: "mono", text: u.email ?? "" })) },
    { label: "Agent ID", render: (u) => u.agentCode ?? h("span", { class: "never", text: "not assigned" }) },
    { label: "Team", render: (u) => u.team?.name ?? "—" },
    { label: "Entra role", render: (u) => u.entraAssignment === "required"
      ? h("span", { class: "badge badge-crit", text: "Assignment required in Entra" }) : u.entraRoles.join(", ") },
    { label: "Status", render: (u) => h("div", {}, statusBadge(u.status), u.online ? h("span", { class: "badge badge-good", style: "margin-left:4px", text: "online" }) : null) },
    { label: "Last seen", render: (u) => timeCell(u.lastHeartbeatAt ?? u.lastLoginAt, "never") },
    { label: "", render: (u) => manage ? userActions(u) : null },
  ];
  $view.append(card("People", "Everyone who has signed in with a Helpdesk Anywhere Entra identity.", tabs, table(cols, data.items, {
    empty: tab === "pending" ? "No pending access requests." : "Nobody here.",
  })));

  $view.append(teamsCard());
}

function userActions(u) {
  const box = h("div", { class: "actions" });
  if (u.status === "pending") box.append(h("button", { type: "button", class: "btn btn-primary", text: "Review & activate", onclick: () => activateDialog(u) }));
  if (u.status === "active") box.append(h("button", { type: "button", class: "btn", text: "Edit", onclick: () => editDialog(u) }),
    h("button", { type: "button", class: "btn btn-danger", text: "Suspend", onclick: () => suspendDialog(u) }));
  if (u.status === "suspended") box.append(h("button", { type: "button", class: "btn", text: "Reactivate", onclick: () => reactivate(u) }));
  return box;
}

function activateDialog(u) {
  const code = h("input", { id: "act-code", required: true, maxlength: 32, pattern: "[A-Za-z0-9._\\-]{1,32}", placeholder: "e.g. AG-0042" });
  const team = teamSelect(null, "act-team");
  const form = h("form", { class: "form", method: "dialog" },
    h("dl", { class: "meta" }, h("dt", { text: "Name" }), h("dd", { text: u.displayName }), h("dt", { text: "E-mail" }), h("dd", { text: u.email ?? "—" }),
      h("dt", { text: "Entra object ID" }), h("dd", { class: "mono", text: u.objectId }), h("dt", { text: "Entra app roles" }),
      h("dd", { text: u.entraRoles.length ? u.entraRoles.join(", ") : "None — assign in Entra first" })),
    u.entraAssignment === "required" ? h("div", { class: "callout callout-crit", text: ERRORS.entra_role_required }) : null,
    h("label", {}, "Internal agent ID", code), h("label", {}, "Team", team));
  const d = dialog(`Activate ${u.displayName}`, form, [
    h("button", { type: "button", class: "btn", text: "Cancel", onclick: () => d.close() }),
    h("button", { type: "button", class: "btn btn-primary", text: "Activate", disabled: u.entraAssignment === "required",
      onclick: async () => {
        if (!code.reportValidity()) return;
        try {
          await api(`/users/${u.id}/activate`, { method: "POST", body: { agentCode: code.value.trim(), teamId: team.value || null } });
          d.close(); flash(`${u.displayName} is now active.`); navigate();
        } catch (e) { flash(e.message, "error"); }
      } }),
  ]);
}

function editDialog(u) {
  const code = h("input", { value: u.agentCode ?? "", maxlength: 32 });
  const team = teamSelect(u.team?.id ?? null, "edit-team");
  const box = (key, label) => h("label", { class: "check" }, h("input", { type: "checkbox", "data-key": key, checked: u.limits[key] }), label);
  // Multi-session: the relay enforces min(account limit, server ceiling), and the
  // API refuses anything above the ceiling, so the field offers exactly that range.
  const ceiling = state.me?.sessionCeiling ?? 4;
  const max = h("input", { type: "number", min: 1, max: ceiling, value: Math.min(u.limits.maxConcurrentSessions, ceiling) });
  const form = h("form", { class: "form", method: "dialog" },
    h("label", {}, "Internal agent ID", code), h("label", {}, "Team", team),
    h("fieldset", { style: "border:1px solid var(--line);border-radius:8px;padding:10px 12px;display:grid;gap:6px" },
      h("legend", { text: "Limits (within the Entra role)" }),
      box("canUseConsole", "May use the technician console"), box("allowScripts", "May run remote scripts"), box("allowFileTransfer", "May transfer and manage files"),
      box("allowElevation", "May request elevation"), box("canExport", "May export reports"),
      h("label", {}, "Max. concurrent sessions", max)));
  const d = dialog(`Edit ${u.displayName}`, form, [
    h("button", { type: "button", class: "btn", text: "Cancel", onclick: () => d.close() }),
    h("button", { type: "button", class: "btn btn-primary", text: "Save", onclick: async () => {
      const limits = { maxConcurrentSessions: Number(max.value) };
      form.querySelectorAll("input[type=checkbox]").forEach((c) => { limits[c.dataset.key] = c.checked; });
      try {
        await api(`/users/${u.id}`, { method: "PATCH", body: { agentCode: code.value.trim(), teamId: team.value || null, limits } });
        d.close(); flash("Saved."); navigate();
      } catch (e) { flash(e.message, "error"); }
    } }),
  ]);
}

function suspendDialog(u) {
  const reason = h("textarea", { rows: 3, maxlength: 300, placeholder: "Reason (recorded in the audit trail)" });
  const d = dialog(`Suspend ${u.displayName}?`, h("div", { class: "form" },
    h("p", { text: "Their sign-in is revoked immediately, any live session they are running is ended, and they cannot sign in to either portal until reactivated." }),
    h("label", {}, "Reason", reason)), [
    h("button", { type: "button", class: "btn", text: "Cancel", onclick: () => d.close() }),
    h("button", { type: "button", class: "btn btn-danger", text: "Suspend access", onclick: async () => {
      try {
        await api(`/users/${u.id}/suspend`, { method: "POST", body: { reason: reason.value } });
        d.close(); flash(`${u.displayName} is suspended.`); navigate();
      } catch (e) { flash(e.message, "error"); }
    } }),
  ]);
}

async function reactivate(u) {
  try {
    await api(`/users/${u.id}/reactivate`, { method: "POST", body: {} });
    flash(`${u.displayName} is active again.`); navigate();
  } catch (e) { flash(e.message, "error"); }
}

function teamsCard() {
  const rows = table([
    { label: "Team", render: (t) => t.name },
    { label: "Members", num: true, render: (t) => String(t.members) },
    { label: "", render: (t) => can("teams.manage") ? h("button", { type: "button", class: "btn", text: "Rename", onclick: () => {
      const input = h("input", { value: t.name, maxlength: 80 });
      const d = dialog("Rename team", h("label", { class: "form" }, "Name", input), [
        h("button", { type: "button", class: "btn", text: "Cancel", onclick: () => d.close() }),
        h("button", { type: "button", class: "btn btn-primary", text: "Save", onclick: async () => {
          try { await api(`/teams/${t.id}`, { method: "PATCH", body: { name: input.value.trim() } }); d.close(); navigate(); }
          catch (e) { flash(e.message, "error"); }
        } })]);
    } }) : null },
  ], state.teams, { empty: "No teams yet." });
  const add = can("teams.manage") ? h("form", { class: "filters", onsubmit: async (e) => {
    e.preventDefault();
    const input = e.target.querySelector("input");
    try { await api("/teams", { method: "POST", body: { name: input.value.trim() } }); flash("Team created."); navigate(); }
    catch (err) { flash(err.message, "error"); }
  } }, h("label", {}, "New team", h("input", { required: true, maxlength: 80 })), h("button", { class: "btn", type: "submit", text: "Add team" })) : null;
  return card("Teams", "Supervisors see sessions and people of their own team.", add, rows);
}

/* ---------------------------------------------------------------------- live */

/** "3 / 4" plus one slot per allowed session — filled, reconnecting (hollow amber) or free. */
function slotMeter(active, reconnecting, max) {
  const slots = [];
  for (let i = 0; i < max; i++) {
    const cls = i < active - reconnecting ? "slot slot-on" : i < active ? "slot slot-reconnecting" : "slot";
    slots.push(h("span", { class: cls }));
  }
  return h("span", { class: "slot-meter", title: `${active} of ${max} concurrent sessions${reconnecting ? `, ${reconnecting} reconnecting` : ""}` },
    h("strong", { class: active >= max ? "slot-full" : null, text: `${active} / ${max}` }), h("span", { class: "slots", "aria-hidden": "true" }, slots));
}

async function renderLive() {
  // Multi-session: concurrency per technician, with a drill-down into one
  // technician's live sessions. Chat is a count only; content stays behind
  // the transcript permission on the session page.
  const techHolder = h("div");
  const detailHolder = h("div");
  $view.append(card("Technicians — concurrent sessions",
    "Each technician can hold up to their limit of live sessions at once. Select a technician to see their sessions.", techHolder, detailHolder));
  let openTech = null;
  const renderTech = (technicians) => {
    techHolder.replaceChildren(table([
      { label: "Technician", render: (t) => t.agentCode ? `${t.name} (${t.agentCode})` : t.name },
      { label: "Active sessions", render: (t) => slotMeter(t.active, t.reconnecting, t.maxSessions) },
      { label: "Reconnecting", num: true, render: (t) => String(t.reconnecting) },
      { label: "Console", render: (t) => t.online ? h("span", { class: "badge badge-good", text: "online" }) : h("span", { class: "badge badge-muted", text: "offline" }) },
    ], technicians, { onRow: (t) => { openTech = openTech === t.id ? null : t.id; renderTech(technicians); }, empty: "No technician is online or running a session." }));
    const t = technicians.find((x) => x.id === openTech);
    if (!t) { detailHolder.replaceChildren(); return; }
    detailHolder.replaceChildren(h("h3", { class: "drill-title", text: `${t.name} — ${t.active} / ${t.maxSessions} sessions` }), table([
      { label: "Session", render: (s) => h("code", { text: s.id.slice(0, 8) }) },
      { label: "Remote device", render: (s) => s.customer ? `${s.customer.machine} · ${s.customer.user}` : h("span", { class: "never", text: "not joined yet" }) },
      { label: "State", render: (s) => h("div", {}, statusBadge(s.state),
        s.reconnecting ? h("span", { class: "badge badge-warn", style: "margin-left:4px", text: "technician reconnecting" }) : null,
        s.held ? h("span", { class: "badge badge-warn", style: "margin-left:4px", text: "on hold" }) : null,
        s.elevated ? h("span", { class: "badge badge-info", style: "margin-left:4px", text: "elevated" }) : null) },
      { label: "Started", render: (s) => timeCell(s.createdAt) },
      { label: "Duration", num: true, render: (s) => fmtDuration(s.durationSeconds) },
      { label: "Chat messages", num: true, render: (s) => String(s.chatCount) },
      { label: "Reconnects", num: true, render: (s) => String(s.reconnectCount) },
    ], t.sessions, { onRow: (s) => { location.hash = `#/sessions/${s.id}`; }, empty: "No live sessions." }));
  };

  const holder = h("div");
  $view.append(card("Live sessions", "Refreshes every 5 seconds. Administrators and supervisors can end a session; nobody can view or control it from here.", holder));
  const load = async () => {
    const [{ items }, techs] = await Promise.all([api("/sessions/live"), api("/technicians/live")]);
    renderTech(techs.technicians);
    holder.replaceChildren(table([
      { label: "Technician", render: (s) => s.agentCode ? `${s.agentName} (${s.agentCode})` : s.agentName },
      { label: "Customer device", render: (s) => s.customer ? `${s.customer.machine} · ${s.customer.user}` : h("span", { class: "never", text: "not joined yet" }) },
      { label: "OS", render: (s) => s.customer?.os ?? "—" },
      { label: "State", render: (s) => h("div", {}, statusBadge(s.state),
        s.reconnecting ? h("span", { class: "badge badge-warn", style: "margin-left:4px", text: "technician reconnecting" }) : null,
        s.held ? h("span", { class: "badge badge-warn", style: "margin-left:4px", text: "on hold" }) : null) },
      { label: "Consent", render: (s) => s.consent },
      { label: "Started", render: (s) => timeCell(s.createdAt) },
      { label: "Active for", num: true, render: (s) => fmtDuration(s.durationSeconds) },
      { label: "", render: (s) => s.canTerminate ? h("button", { type: "button", class: "btn btn-danger", text: "End session", onclick: () => terminate(s.id, load) }) : null },
    ], items, { onRow: (s) => { location.hash = `#/sessions/${s.id}`; }, empty: "No live sessions." }));
  };
  await load();
  state.liveTimer = setInterval(() => { load().catch(() => undefined); }, 5000);
}

function terminate(id, after) {
  const reason = h("input", { maxlength: 300, placeholder: "Reason (audited)" });
  const d = dialog("End this session?", h("div", { class: "form" },
    h("p", { text: "The technician and the customer are both disconnected, and the customer's applet closes its session indicator. This is recorded in the audit trail and on the session timeline." }),
    h("label", {}, "Reason", reason)), [
    h("button", { type: "button", class: "btn", text: "Cancel", onclick: () => d.close() }),
    h("button", { type: "button", class: "btn btn-danger", text: "End session", onclick: async () => {
      try { await api(`/sessions/${id}/terminate`, { method: "POST", body: { reason: reason.value } }); d.close(); flash("Session ended."); after(); }
      catch (e) { flash(e.message, "error"); }
    } }),
  ]);
}

/* ------------------------------------------------------------------- history */

function sessionsTable(items) {
  return table([
    { label: "Created", render: (s) => timeCell(s.createdAt) },
    { label: "Technician", render: (s) => s.agent.agentCode ? `${s.agent.name} (${s.agent.agentCode})` : s.agent.name },
    { label: "Team", render: (s) => s.team?.name ?? "—" },
    { label: "Device", render: (s) => s.customer.machine ?? h("span", { class: "never", text: "never joined" }) },
    { label: "Status", render: (s) => h("div", {}, statusBadge(s.status), s.recordComplete ? null : h("span", { class: "badge badge-crit", style: "margin-left:4px", text: "incomplete" })) },
    { label: "Consent", render: (s) => s.consent ?? "—" },
    { label: "Duration", num: true, render: (s) => fmtDuration(s.durationSeconds) },
    { label: "End reason", render: (s) => s.endReasonLabel ?? "—" },
  ], items, { onRow: (s) => { location.hash = `#/sessions/${s.id}`; }, empty: "No sessions match." });
}

async function renderHistory(_arg, params) {
  await loadTeams().catch(() => []);
  const f = Object.fromEntries(params.entries());
  const field = (name, label, el) => { el.name = name; if (f[name]) el.value = f[name]; return h("label", {}, label, el); };
  const form = h("form", { class: "filters", onsubmit: (e) => {
    e.preventDefault();
    const q = new URLSearchParams();
    for (const [k, v] of new FormData(e.target).entries()) if (String(v).trim()) q.set(k, String(v).trim());
    location.hash = `#/history?${q}`;
  } },
    field("q", "Search (session ID, technician, device, user)", h("input", { type: "search", size: 28 })),
    field("status", "Status", h("select", {}, ["", "waiting", "active", "ended"].map((v) => h("option", { value: v, text: v || "Any" })))),
    field("teamId", "Team", h("select", {}, h("option", { value: "", text: "Any" }), state.teams.map((t) => h("option", { value: t.id, text: t.name })))),
    field("device", "Device", h("input", { size: 14 })),
    field("from", "From", h("input", { type: "date" })),
    field("to", "To", h("input", { type: "date" })),
    field("sort", "Sort", h("select", {}, [["created", "Created"], ["ended", "Ended"], ["duration", "Duration"], ["agent", "Technician"], ["device", "Device"], ["status", "Status"]].map(([v, t]) => h("option", { value: v, text: t })))),
    field("dir", "Order", h("select", {}, [["desc", "Newest / largest first"], ["asc", "Oldest / smallest first"]].map(([v, t]) => h("option", { value: v, text: t })))),
    h("button", { class: "btn btn-primary", type: "submit", text: "Apply" }),
    h("a", { class: "btn", href: "#/history", text: "Reset" }));

  const page = Number(f.page || 1);
  const q = new URLSearchParams(params); q.set("page", String(page)); q.set("pageSize", "25");
  const data = await api(`/sessions?${q}`);
  const pages = Math.max(1, Math.ceil(data.total / data.pageSize));
  const go = (p) => { const n = new URLSearchParams(params); n.set("page", String(p)); location.hash = `#/history?${n}`; };

  const exportBtn = can("reports.export") ? h("button", { type: "button", class: "btn", text: "Export these results (CSV)", onclick: async () => {
    const filters = Object.fromEntries([...params.entries()].filter(([k]) => !["page", "pageSize"].includes(k)));
    try { await api("/reports", { method: "POST", body: { kind: "summary_csv", filters } }); flash("CSV export requested — see Reports."); location.hash = "#/reports"; }
    catch (e) { flash(e.message, "error"); }
  } }) : null;

  $view.append(card("Sessions", `${data.total} session(s) match.`, form, h("div", { class: "actions", style: "margin-bottom:10px" }, exportBtn), sessionsTable(data.items),
    h("div", { class: "pager" }, `Page ${data.page} of ${pages}`,
      h("button", { type: "button", class: "btn", text: "Previous", disabled: page <= 1, onclick: () => go(page - 1) }),
      h("button", { type: "button", class: "btn", text: "Next", disabled: page >= pages, onclick: () => go(page + 1) }))));
}

/* ------------------------------------------------------------------- session */

async function renderSession(id) {
  const d = await api(`/sessions/${encodeURIComponent(id)}`);
  const s = d.session;
  const dd = (v, never = "Not captured") => (v === null || v === undefined || v === "" ? h("span", { class: "never", text: never }) : v instanceof Node ? v : String(v));

  if (!s.recordComplete) {
    $view.append(h("div", { class: "callout callout-crit", text: "Some events for this session could not be stored. This record is incomplete; the timeline may be missing entries." }));
  }

  const actions = h("div", { class: "actions" });
  if (d.permissions.export) {
    actions.append(h("button", { type: "button", class: "btn btn-primary", text: "Download PDF report", onclick: () => requestPdf(s.id, d.permissions) }));
  }
  if (d.live && d.permissions.terminate) actions.append(h("button", { type: "button", class: "btn btn-danger", text: "End session", onclick: () => terminate(s.id, navigate) }));

  $view.append(h("div", { class: "grid-2" },
    card("Session", null, h("dl", { class: "meta" },
      h("dt", { text: "Session ID" }), h("dd", { class: "mono", text: s.id }),
      h("dt", { text: "Status" }), h("dd", {}, statusBadge(s.status), d.live ? h("span", { class: "badge badge-good", style: "margin-left:4px", text: "live" }) : null),
      h("dt", { text: "Created" }), h("dd", {}, timeCell(s.createdAt)),
      h("dt", { text: "Customer joined" }), h("dd", {}, timeCell(s.customerJoinedAt, "Customer never joined")),
      h("dt", { text: "Consent" }), h("dd", {}, dd(s.consent, "Never decided")),
      h("dt", { text: "Active from" }), h("dd", {}, timeCell(s.activeAt, "Never became active")),
      h("dt", { text: "Ended" }), h("dd", {}, timeCell(s.endedAt, d.live ? "Still live" : "—")),
      h("dt", { text: "Active duration" }), h("dd", { text: fmtDuration(s.durationSeconds) }),
      h("dt", { text: "End reason" }), h("dd", {}, dd(s.endReasonLabel, d.live ? "Still live" : "—"))), actions),
    card("People and device", "Device details are what the customer's applet reported.", h("dl", { class: "meta" },
      h("dt", { text: "Technician" }), h("dd", { text: s.agent.name }),
      h("dt", { text: "Agent ID" }), h("dd", {}, dd(s.agent.agentCode, "Not assigned")),
      h("dt", { text: "Team" }), h("dd", {}, dd(s.team?.name, "No team")),
      h("dt", { text: "Machine" }), h("dd", {}, dd(s.customer.machine)),
      h("dt", { text: "Windows user" }), h("dd", {}, dd(s.customer.user)),
      h("dt", { text: "OS" }), h("dd", {}, dd(s.customer.os))))));

  $view.append(card("Timeline", "Server-recorded, in order. Script bodies, credentials and pairing codes are never stored.",
    d.timeline.length === 0 ? h("p", { class: "empty", text: "No events recorded." }) :
      h("ol", { class: "timeline" }, d.timeline.map((e) => h("li", {},
        timeCell(e.at),
        h("div", {}, h("strong", { text: e.title }), " ", h("span", { class: "badge badge-muted", text: e.actorName ? `${e.actorRole}: ${e.actorName}` : e.actorRole }),
          Object.keys(e.detail).length ? h("div", { class: "detail", text: Object.entries(e.detail).map(([k, v]) => `${k}: ${v}`).join(" · ") }) : null))))));

  const purged = s.transcriptPurgedAt ? h("p", { class: "callout", text: `Chat and notes were deleted by the retention policy on ${fmtTime(s.transcriptPurgedAt)}.` }) : null;

  if (d.permissions.transcript) {
    const holder = h("div", {}, purged, h("p", { class: "sub", text: `${d.counts.chat} message(s). Opening the transcript is recorded in the audit trail.` }),
      h("button", { type: "button", class: "btn", text: "View transcript", onclick: async (e) => {
        e.target.disabled = true;
        try {
          const t = await api(`/sessions/${s.id}/transcript`);
          holder.replaceChildren(t.purged ? h("p", { class: "never", text: "Deleted by the retention policy." }) :
            t.messages.length === 0 ? h("p", { class: "empty", text: "No chat messages in this session." }) :
              h("div", { class: "chat" }, t.messages.map((m) => h("div", { class: `msg ${m.sender}` },
                h("span", { class: "msg-who", text: `${m.sender === "agent" ? m.senderName ?? "Technician" : "Customer"} · ${fmtTime(m.at)}` }),
                m.kind === "url" ? safeLink(m.url, m.label) : m.text))));
        } catch (err) { flash(err.message, "error"); e.target.disabled = false; }
      } }));
    $view.append(card("Chat transcript", null, holder));
  } else {
    $view.append(card("Chat transcript", "Your role cannot view transcripts."));
  }

  if (d.permissions.notes) {
    const holder = h("div", {}, h("p", { class: "sub", text: `${d.counts.notes} saved revision(s). Private to technicians and oversight roles; never shown to the customer. Viewing is audited.` }),
      h("button", { type: "button", class: "btn", text: "View notes", onclick: async (e) => {
        e.target.disabled = true;
        try {
          const n = await api(`/sessions/${s.id}/notes`);
          holder.replaceChildren(n.purged ? h("p", { class: "never", text: "Deleted by the retention policy." }) :
            n.notes.length === 0 ? h("p", { class: "empty", text: "No notes were saved for this session." }) :
              h("div", { class: "chat" }, n.notes.map((x, i) => h("div", {}, h("div", { class: "sub", text: `Revision ${i + 1} · ${x.author ?? "unknown"} · ${fmtTime(x.at)}` }), h("div", { class: "note", text: x.body })))));
        } catch (err) { flash(err.message, "error"); e.target.disabled = false; }
      } }));
    $view.append(card("Technician notes", null, holder));
  }
}

function requestPdf(sessionId, perms) {
  const chat = h("input", { type: "checkbox", checked: perms.transcript, disabled: !perms.transcript });
  const notes = h("input", { type: "checkbox", checked: perms.notes, disabled: !perms.notes });
  const d = dialog("Session PDF report", h("div", { class: "form" },
    h("p", { text: "The report includes metadata and the timeline. It never contains pairing codes, credentials or script contents. The request and every download are audited; the file can be downloaded only by you, for a limited time." }),
    h("label", { class: "check" }, chat, "Include chat transcript"), h("label", { class: "check" }, notes, "Include technician notes")), [
    h("button", { type: "button", class: "btn", text: "Cancel", onclick: () => d.close() }),
    h("button", { type: "button", class: "btn btn-primary", text: "Generate", onclick: async () => {
      try {
        await api("/reports", { method: "POST", body: { kind: "session_pdf", sessionId, includeChat: chat.checked, includeNotes: notes.checked } });
        d.close(); flash("Report requested — it will appear under Reports in a moment."); location.hash = "#/reports";
      } catch (e) { flash(e.message, "error"); }
    } }),
  ]);
}

/* ------------------------------------------------------------------- reports */

async function renderReports() {
  const holder = h("div");
  const form = h("form", { class: "filters", onsubmit: async (e) => {
    e.preventDefault();
    const filters = {};
    for (const [k, v] of new FormData(e.target).entries()) if (String(v).trim()) filters[k] = String(v).trim();
    try { await api("/reports", { method: "POST", body: { kind: "summary_csv", filters } }); flash("CSV export requested."); load(); }
    catch (err) { flash(err.message, "error"); }
  } },
    h("label", {}, "From", h("input", { type: "date", name: "from" })), h("label", {}, "To", h("input", { type: "date", name: "to" })),
    h("label", {}, "Status", h("select", { name: "status" }, ["", "waiting", "active", "ended"].map((v) => h("option", { value: v, text: v || "Any" })))),
    h("button", { type: "submit", class: "btn btn-primary", text: "Export summary CSV" }));

  $view.append(card("New summary export", "One row per session: session ID, technician, agent ID, team, device, times, duration, consent, status and end reason. Never chat bodies, notes or codes.", form));
  $view.append(card("My exports", null, holder));

  let timer = null;
  async function load() {
    const data = await api("/reports");
    holder.replaceChildren(h("p", { class: "sub", text: `Files can be downloaded by the person who requested them, for ${data.ttlMinutes} minutes after they are generated. Each download is audited.` }),
      table([
        { label: "Requested", render: (r) => timeCell(r.createdAt) },
        { label: "Kind", render: (r) => r.kind === "session_pdf" ? "Session PDF" : "Summary CSV" },
        { label: "Subject", render: (r) => r.sessionId ? h("a", { href: `#/sessions/${r.sessionId}`, class: "mono", text: r.sessionId.slice(0, 8) }) : "Filtered sessions" },
        { label: "Status", render: (r) => statusBadge(r.status) },
        { label: "Expires", render: (r) => timeCell(r.expiresAt) },
        { label: "Downloads", num: true, render: (r) => String(r.downloads) },
        { label: "", render: (r) => r.status === "ready" ? h("a", { class: "btn", href: `/api/admin/reports/${r.id}/download`, text: "Download" }) : r.error ?? null },
      ], data.items, { empty: "No exports yet." }));
    clearTimeout(timer);
    if (data.items.some((r) => r.status === "pending") && location.hash.startsWith("#/reports")) timer = setTimeout(load, 1500);
  }
  await load();
}

/* --------------------------------------------------------------------- audit */

async function renderAudit(_arg, params) {
  const f = Object.fromEntries(params.entries());
  const actions = ["", "access.", "auth.", "transcript.viewed", "notes.viewed", "report.", "session.terminated", "team.", "retention.purged"];
  const form = h("form", { class: "filters", onsubmit: (e) => {
    e.preventDefault();
    const q = new URLSearchParams();
    for (const [k, v] of new FormData(e.target).entries()) if (String(v).trim()) q.set(k, String(v).trim());
    location.hash = `#/audit?${q}`;
  } },
    h("label", {}, "Action", h("select", { name: "action" }, actions.map((a) => h("option", { value: a, selected: f.action === a, text: a ? (a.endsWith(".") ? `${a}*` : a) : "Any" })))),
    h("label", {}, "From", h("input", { type: "date", name: "from", value: f.from ?? "" })),
    h("label", {}, "To", h("input", { type: "date", name: "to", value: f.to ?? "" })),
    h("button", { type: "submit", class: "btn btn-primary", text: "Apply" }));
  const page = Number(f.page || 1);
  const q = new URLSearchParams(params); q.set("page", String(page)); q.set("pageSize", "50");
  const data = await api(`/audit?${q}`);
  const pages = Math.max(1, Math.ceil(data.total / data.pageSize));
  const go = (p) => { const n = new URLSearchParams(params); n.set("page", String(p)); location.hash = `#/audit?${n}`; };
  $view.append(card("Audit trail", "Access changes, sign-ins, transcript and notes views, report exports and downloads, and terminations.", form,
    table([
      { label: "When", render: (a) => timeCell(a.at) },
      { label: "Who", render: (a) => a.actor_label ?? "system" },
      { label: "Action", render: (a) => h("span", { class: "mono", text: a.action }) },
      { label: "Target", render: (a) => a.target_type === "session" ? h("a", { href: `#/sessions/${a.target_id}`, class: "mono", text: `session ${a.target_id.slice(0, 8)}` })
        : a.target_user_name ? `user ${a.target_user_name}` : a.target_type ? `${a.target_type} ${String(a.target_id ?? "").slice(0, 8)}` : "—" },
      { label: "Detail", render: (a) => h("span", { class: "mono", text: JSON.stringify(a.detail) }) },
      { label: "IP", render: (a) => a.ip ?? "—" },
    ], data.items, { empty: "No audit entries match." }),
    h("div", { class: "pager" }, `Page ${data.page} of ${pages}`,
      h("button", { type: "button", class: "btn", text: "Previous", disabled: page <= 1, onclick: () => go(page - 1) }),
      h("button", { type: "button", class: "btn", text: "Next", disabled: page >= pages, onclick: () => go(page + 1) }))));
}

/* ------------------------------------------------------------------ settings */

/* ------------------------------------------------------------ script library */

/**
 * Platform 2.0: the saved scripts technicians can load in the console. Built-ins
 * are read-only. Saving writes a NEW version (the old one stays, so history
 * resolves to the exact text that ran); archiving hides a script from
 * technicians without deleting it. Script bodies are shown as text only.
 */
async function renderScripts() {
  const data = await api("/scripts");
  const manage = data.canManage === true;
  const head = h("div", { class: "actions", style: "justify-content:space-between;align-items:center;margin-bottom:12px" },
    h("p", { class: "sub", style: "margin:0", text: "Technicians can load these in the console's Scripts tab. Running one still needs the \"may run remote scripts\" limit and an active session; the relay records a run as a saved script only if the text, shell and privilege match exactly." }),
    manage ? h("button", { type: "button", class: "btn btn-primary", text: "New script", onclick: () => scriptDialog(null, data.categories) }) : null);
  const rows = data.items;
  $view.append(card("Saved scripts", `${rows.filter((r) => !r.archived).length} available to technicians`, head,
    table([
      { label: "Name", render: (r) => h("div", {}, h("strong", { text: r.name }), h("div", { class: "sub", text: r.description || "" })) },
      { label: "Category", render: (r) => r.category },
      { label: "Shell", render: (r) => (r.shell === "cmd" ? "Command Prompt" : "PowerShell") },
      { label: "Runs as", render: (r) => h("span", { class: `badge ${r.runAs === "system" ? "badge-warn" : "badge-muted"}`, text: r.runAs === "system" ? "SYSTEM (elevated)" : "user" }) },
      { label: "Version", num: true, render: (r) => `v${r.version}` },
      { label: "Source", render: (r) => (r.builtin ? "Built-in" : r.archived ? h("span", { class: "badge badge-muted", text: "archived" }) : `By ${r.createdByName}`) },
    ], rows, { onRow: (r) => scriptDialog(r, data.categories, manage), empty: "No scripts." })));
}

function scriptDialog(sc, categories, manage = true) {
  const editable = manage && (!sc || (!sc.builtin && !sc.archived));
  const name = h("input", { value: sc?.name ?? "", maxlength: 120, disabled: !editable });
  const description = h("input", { value: sc?.description ?? "", maxlength: 1000, disabled: !editable });
  const category = h("select", { disabled: !editable }, categories.map((c) => h("option", { value: c, text: c, selected: sc?.category === c })));
  const shell = h("select", { disabled: !editable },
    h("option", { value: "powershell", text: "PowerShell", selected: sc?.shell !== "cmd" }),
    h("option", { value: "cmd", text: "Command Prompt", selected: sc?.shell === "cmd" }));
  const runAs = h("select", { disabled: !editable },
    h("option", { value: "user", text: "Signed-in user", selected: sc?.runAs !== "system" }),
    h("option", { value: "system", text: "SYSTEM — needs an elevated session", selected: sc?.runAs === "system" }));
  const body = h("textarea", { rows: 12, spellcheck: "false", style: "font-family:ui-monospace,monospace;font-size:12px;width:100%", disabled: !editable });
  body.value = sc?.body ?? "";
  const form = h("form", { class: "form", method: "dialog", style: "min-width:min(640px,80vw)" },
    h("label", {}, "Name", name), h("label", {}, "Description", description),
    h("div", { style: "display:grid;grid-template-columns:repeat(3,1fr);gap:8px" },
      h("label", {}, "Category", category), h("label", {}, "Shell", shell), h("label", {}, "Runs as", runAs)),
    h("label", {}, "Script", body),
    sc && !sc.builtin ? h("p", { class: "sub", text: `Version ${sc.version}. Saving creates version ${sc.version + 1}; earlier versions are kept.` }) : null,
    sc?.builtin ? h("p", { class: "sub", text: "Built-in script — read-only." }) : null);
  const payload = () => ({ name: name.value, description: description.value, category: category.value, shell: shell.value, runAs: runAs.value, body: body.value });
  const actions = [h("button", { type: "button", class: "btn", text: editable ? "Cancel" : "Close", onclick: () => d.close() })];
  if (editable && sc) {
    actions.push(h("button", { type: "button", class: "btn btn-danger", text: "Archive", onclick: async () => {
      if (!confirm(`Archive "${sc.name}"? Technicians will no longer see it; its history is kept.`)) return;
      try { await api(`/scripts/${sc.id}/archive`, { method: "POST", body: {} }); d.close(); flash("Archived."); navigate(); }
      catch (e) { flash(e.message, "error"); }
    } }));
  }
  if (editable) {
    actions.push(h("button", { type: "button", class: "btn btn-primary", text: sc ? "Save new version" : "Create", onclick: async () => {
      try {
        if (sc) await api(`/scripts/${sc.id}`, { method: "PUT", body: payload() });
        else await api("/scripts", { method: "POST", body: payload() });
        d.close(); flash("Saved."); navigate();
      } catch (e) { flash(e.message, "error"); }
    } }));
  }
  const d = dialog(sc ? sc.name : "New script", form, actions);
}

async function renderSettings() {
  const s = await api("/settings");
  const days = (n) => (n > 0 ? `${n} days` : "Kept indefinitely");
  $view.append(card("Retention", "Set by environment variables on the server (see the operator guide). Changing them requires a restart.", h("dl", { class: "meta" },
    h("dt", { text: "Chat transcripts and notes" }), h("dd", { text: `${days(s.retention.transcriptDays)} after the session ends (TRANSCRIPT_RETENTION_DAYS)` }),
    h("dt", { text: "Session records and timelines" }), h("dd", { text: `${days(s.retention.sessionDays)} after the session ends (SESSION_RETENTION_DAYS)` }),
    h("dt", { text: "Administrative audit trail" }), h("dd", { text: `${days(s.retention.auditDays)} (AUDIT_RETENTION_DAYS)` }),
    h("dt", { text: "Generated report files" }), h("dd", { text: `${s.retention.reportTtlMinutes} minutes, then erased (REPORT_TTL_MINUTES)` }))));
  $view.append(card("Sign-in and metrics", null, h("dl", { class: "meta" },
    h("dt", { text: "Sign-in" }), h("dd", { text: s.authMode === "dev" ? "DEVELOPMENT sign-in (loopback only)" : "Microsoft Entra ID" }),
    h("dt", { text: "Idle sign-out" }), h("dd", { text: `${s.authIdleMinutes} minutes` }),
    h("dt", { text: "Maximum sign-in lifetime" }), h("dd", { text: `${s.authMaxHours} hours` }),
    h("dt", { text: "“Online” window" }), h("dd", { text: `${s.presenceWindowSeconds} seconds since the last console heartbeat` }),
    h("dt", { text: "Dashboard day boundary" }), h("dd", { text: s.reportTimezone }),
    h("dt", { text: "Technician console" }), h("dd", { class: "mono", text: s.agentConsoleHost }),
    h("dt", { text: "Admin portal" }), h("dd", { class: "mono", text: s.adminPortalHost }))));
}

/* ------------------------------------------------------------------- startup */

document.getElementById("menu").addEventListener("click", () => document.getElementById("sidebar").classList.toggle("open"));
document.getElementById("sign-out").addEventListener("click", async () => {
  try { await fetch("/auth/logout", { method: "POST", credentials: "same-origin", headers: { "X-CSRF-Token": state.csrf } }); }
  finally { location.assign("/login?signedOut=1"); }
});

(async () => {
  try {
    const me = await api("/me");
    state.me = me;
    state.csrf = me.csrfToken;
    state.perms = new Set(me.permissions);
    document.getElementById("who-name").textContent = me.user.displayName;
    document.getElementById("who-role").textContent = `${me.user.roles.join(", ")} · ${me.scope === "all" ? "organisation" : "team"} scope`;
    document.getElementById("dev-badge").hidden = me.authMode !== "dev";
    document.querySelectorAll("#nav a").forEach((a) => { a.hidden = !can(a.dataset.perm); });
    window.addEventListener("hashchange", navigate);
    await navigate();
  } catch (e) {
    if (e.message !== "signed out") $view.append(h("div", { class: "callout callout-crit", text: e.message }));
  }
})();
