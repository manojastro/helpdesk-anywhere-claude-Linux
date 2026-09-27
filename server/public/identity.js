/**
 * Technician console — signed-in identity, presence heartbeat, sign-out, and the
 * one helper every console API call goes through.
 *
 * The identity shown here comes from GET /api/agent/me, i.e. from the server's
 * verified Entra session — the same display name the customer's consent dialog
 * shows. Nothing the browser holds decides who the technician is.
 *
 * Loaded before portal.js; exposes `window.hdaConsole`.
 */
(() => {
  "use strict";

  const state = { me: null, csrf: "", heartbeat: null };

  function toLogin() {
    location.assign(`/login?returnTo=${encodeURIComponent(location.pathname)}`);
  }

  /** fetch() with the CSRF token and JSON handling; a lost sign-in goes to /login. */
  async function api(path, { method = "GET", body } = {}) {
    const headers = { Accept: "application/json" };
    if (method !== "GET") headers["X-CSRF-Token"] = state.csrf;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const res = await fetch(path, {
      method, headers, credentials: "same-origin",
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 401) {
      toLogin();
      throw new Error("signed out");
    }
    const data = res.status === 204 ? null : await res.json().catch(() => null);
    if (!res.ok) {
      const err = new Error((data && data.error) || `HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  function render(me) {
    const u = me.user;
    const name = document.getElementById("agent-name");
    if (name) {
      name.textContent = u.displayName;
      name.title = [u.displayName, u.email, u.agentCode && `Agent ID ${u.agentCode}`, u.team && `Team ${u.team}`, u.primaryRole]
        .filter(Boolean).join("\n");
    }
    const meta = document.getElementById("agent-meta");
    if (meta) meta.textContent = [u.agentCode, u.primaryRole].filter(Boolean).join(" · ");
    const days = me.chatRetentionDays;
    const notice = document.getElementById("chat-saved-notice");
    if (notice) {
      notice.textContent = days > 0
        ? `Chat is saved to the session record for ${days} days.`
        : "Chat is saved to the session record.";
    }
  }

  async function heartbeat() {
    try {
      await api("/api/agent/presence", { method: "POST" });
    } catch {
      /* next tick retries; a 401 already redirected */
    }
  }

  async function signOut() {
    try {
      await api("/auth/logout", { method: "POST" });
    } finally {
      location.assign("/login?signedOut=1");
    }
  }

  const ready = api("/api/agent/me").then((me) => {
    state.me = me;
    state.csrf = me.csrfToken;
    render(me);
    void heartbeat();
    state.heartbeat = setInterval(heartbeat, Math.max(10, me.heartbeatSeconds) * 1000);
    return me;
  });
  ready.catch(() => { /* toLogin() already ran for a 401 */ });

  document.getElementById("sign-out")?.addEventListener("click", () => { void signOut(); });

  window.hdaConsole = { api, ready, get me() { return state.me; } };
})();
