/**
 * Agent console (PLAN 1.4).
 *
 * Phase 1: session creation, the join link, the state-machine status line, the
 * "UAC prompt active" banner and End session. The canvas renderer (Phase 3.4),
 * input capture (Phase 4.1), the elevation controls (Phase 5) and the script
 * pane (Phase 6.2) land in their own phases, so those fieldsets stay disabled.
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
  hostInfo: el("host-info"),
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

/** The live socket, or null when there is no session. */
let ws = null;

/** Set once the user deliberately ends the session, to suppress the drop notice. */
let endedByAgent = false;

/**
 * The last explanation the server gave (peer.left, or an error). The socket close
 * that follows must not overwrite it with a vaguer "Disconnected".
 */
let lastNotice = null;

function wsUrl() {
  const scheme = location.protocol === "https:" ? "wss:" : "ws:";
  return `${scheme}//${location.host}/ws`;
}

function resetToIdle(text, state) {
  ws = null;
  endedByAgent = false;
  lastNotice = null;
  ui.startSession.disabled = false;
  ui.endSession.disabled = true;
  ui.uacBanner.hidden = true;
  setStatus(text, state);
}

function startSession() {
  ui.startSession.disabled = true;
  ui.hostInfo.textContent = "";
  ui.codeBlock.hidden = true;
  lastNotice = null;
  setStatus("Connecting…", "waiting");

  ws = new WebSocket(wsUrl());
  ws.binaryType = "arraybuffer";

  ws.addEventListener("open", () => {
    ws.send(JSON.stringify({ t: "agent.create" }));
  });

  ws.addEventListener("message", (ev) => {
    // Binary frames are video (Phase 3) — ignored until the renderer exists.
    if (typeof ev.data !== "string") return;

    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    onServerMessage(msg);
  });

  ws.addEventListener("close", () => {
    if (endedByAgent) resetToIdle("Session ended", "idle");
    else if (lastNotice) resetToIdle(lastNotice.text, lastNotice.state);
    else resetToIdle("Disconnected", "idle");
  });

  ws.addEventListener("error", () => {
    setStatus("Connection error", "error");
  });
}

function onServerMessage(msg) {
  switch (msg.t) {
    case "session.created":
      showCode(msg.code);
      setStatus("Waiting for user…", "waiting");
      break;

    case "peer.joined":
      if (msg.role === "host") {
        const i = msg.info ?? {};
        ui.hostInfo.textContent = `${i.machine ?? "?"} · ${i.user ?? "?"} · ${i.os ?? "?"}`;
        setStatus("Awaiting consent…", "waiting");
      }
      break;

    case "consent.result":
      if (msg.accepted) {
        setStatus("Connected", "active");
        ui.endSession.disabled = false;
      } else {
        setStatus("User declined", "error");
      }
      break;

    // Phase 5.6 drives this from the host's desktop switch; the banner itself is
    // part of the Phase 1 console (PLAN 1.4).
    case "host.desktopChanged":
      ui.uacBanner.hidden = msg.desktop !== "Winlogon";
      break;

    case "peer.left":
      ui.uacBanner.hidden = true;
      notify(msg.role === "host" ? "User disconnected" : "Disconnected", "error");
      break;

    case "error":
      notify(msg.message ?? msg.code ?? "Error", "error");
      break;

    default:
      break;
  }
}

/** Show a server-supplied explanation and keep it through the socket close. */
function notify(text, state) {
  lastNotice = { text, state };
  setStatus(text, state);
}

function showCode(code) {
  ui.code.textContent = code;
  // location.origin is already https://<name>.duckdns.org in a deployment, so
  // this is the exact link to read out or paste (PLAN 1.5).
  ui.joinUrl.textContent = `${location.origin}/j/${code}`;
  ui.codeBlock.hidden = false;
}

function endSession() {
  ui.endSession.disabled = true;
  if (ws && ws.readyState === WebSocket.OPEN) {
    endedByAgent = true;
    ws.send(JSON.stringify({ t: "agent.end" }));
    ws.close();
  } else {
    resetToIdle("Session ended", "idle");
  }
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

ui.startSession.addEventListener("click", startSession);
ui.endSession.addEventListener("click", endSession);

setStatus("Idle");

export { ui, setStatus };
