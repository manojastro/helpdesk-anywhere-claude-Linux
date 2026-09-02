/**
 * Agent console (PLAN 1.4).
 *
 * Phase 0 scaffold: element wiring and the status helper only. The WebSocket
 * client, canvas renderer (Phase 3.4), input capture (Phase 4.1), elevation
 * controls (Phase 5) and the script pane (Phase 6.2) land in their phases.
 *
 * SECURITY (PLAN 1.4 / 5.2c): the credential fields must never be written to
 * localStorage or sessionStorage, and must be cleared immediately after send.
 */

const el = (id) => document.getElementById(id);

const ui = {
  status: el("status"),
  startSession: el("start-session"),
  codeBlock: el("code-block"),
  code: el("code"),
  joinUrl: el("join-url"),
  copyLink: el("copy-link"),
  uacBanner: el("uac-banner"),
  canvas: el("remote"),
  elevation: el("elevation"),
  credFields: el("cred-fields"),
  elevPassword: el("elev-password"),
  scripting: el("scripting"),
  endSession: el("end-session"),
};

/** Reflects the server-side state machine in the header chip. */
function setStatus(text, state = "idle") {
  ui.status.textContent = text;
  ui.status.dataset.state = state;
}

/** Show/hide the credential inputs with the elevation mode radios (PLAN 1.4). */
for (const radio of document.querySelectorAll('input[name="elev-mode"]')) {
  radio.addEventListener("change", (e) => {
    ui.credFields.hidden = e.target.value !== "credential";
  });
}

ui.copyLink.addEventListener("click", async () => {
  await navigator.clipboard.writeText(ui.joinUrl.textContent);
  ui.copyLink.textContent = "Copied";
  setTimeout(() => (ui.copyLink.textContent = "Copy"), 1500);
});

ui.startSession.addEventListener("click", () => {
  setStatus("Not implemented until Phase 1.4", "error");
});

setStatus("Idle");

export { ui, setStatus };
