/** Admin portal sign-in page (separate application). Shows Microsoft sign-in, or the dev form in AUTH_MODE=dev. */
(() => {
  "use strict";
  const params = new URLSearchParams(location.search);
  const rawReturn = params.get("returnTo") || "/";
  // Same strict rule as the server's safeReturnTo(): browsers treat "/\\host" like
  // "//host", so only a plain path from a small alphabet is followed.
  const returnTo = /^\/[A-Za-z0-9/_.-]{0,200}$/.test(rawReturn) && !rawReturn.startsWith("//") ? rawReturn : "/";

  const MESSAGES = {
    pending: "Your account is waiting for an administrator to approve it. You will be able to sign in once it is activated.",
    suspended: "Your access to Helpdesk Anywhere is suspended. Contact your administrator.",
    entra_role_required: "Your account is not assigned to Helpdesk Anywhere in Microsoft Entra ID. Ask your administrator to assign you an app role.",
    portal_not_permitted: "The admin portal is for administrators, supervisors and auditors. Technicians sign in to the technician console instead.",
    wrong_tenant: "This account belongs to a different organisation directory.",
    missing_oid: "The sign-in did not identify your account. Try again.",
    signin_failed: "Sign-in could not be completed. Try again.",
    idp_unavailable: "Microsoft sign-in is unavailable right now. Try again shortly.",
    rate_limited: "Too many attempts. Wait a minute and try again.",
  };

  const message = document.getElementById("message");
  function show(text, kind = "error") {
    message.textContent = text;
    message.dataset.kind = kind;
    message.hidden = false;
  }

  const code = params.get("status") || params.get("error");
  if (code) show(MESSAGES[code] || "Sign-in was not completed.", code === "pending" ? "info" : "error");
  if (params.get("signedOut")) show("You have signed out.", "info");

  fetch("/auth/config", { credentials: "same-origin" })
    .then((r) => r.json())
    .then((cfg) => {
      if (cfg.mode === "dev") {
        document.getElementById("dev-form").hidden = false;
      } else {
        const a = document.getElementById("entra");
        a.href = `/auth/login?returnTo=${encodeURIComponent(returnTo)}`;
        a.hidden = false;
      }
    })
    .catch(() => show("The server is not reachable."));

  document.getElementById("dev-form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const roles = [...document.querySelectorAll("#dev-form input[type=checkbox]:checked")].map((c) => c.value);
    const res = await fetch("/auth/dev/login", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        objectId: document.getElementById("dev-oid").value.trim(),
        name: document.getElementById("dev-name").value.trim(),
        email: document.getElementById("dev-email").value.trim(),
        roles,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok) location.assign(returnTo);
    else show(MESSAGES[data.error] || "Sign-in was refused.", data.error === "pending" ? "info" : "error");
  });
})();
