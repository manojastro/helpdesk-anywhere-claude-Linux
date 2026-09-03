/**
 * Agent console (PLAN 1.4).
 *
 * Phase 1: session creation, the join link, the state-machine status line, the
 * "UAC prompt active" banner and End session. Phase 3.4 adds the canvas renderer
 * and the FPS/kbps counter; Phase 4.1 adds mouse and keyboard capture. The
 * elevation controls (Phase 5) and the script pane (Phase 6.2) land in their own
 * phases, so those fieldsets stay disabled.
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
  fps: el("fps"),
  kbps: el("kbps"),
  inputHint: el("input-hint"),
  specialKeys: el("special-keys"),
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
  setInputEnabled(false);
  resetRenderer();
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
  resetRenderer();
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
    // Binary frames are video (Phase 3.4); control messages are JSON text.
    if (typeof ev.data !== "string") {
      onVideoFrame(ev.data);
      return;
    }

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
        startStatsCounter();
        setInputEnabled(true);
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


/* ------------------------------------------------------- renderer (PLAN 3.4) */

/**
 * The canvas backing store is kept at the remote's native resolution and scaled
 * down by CSS (`#remote { width: 100% }`). Phase 4 maps a click back to a remote
 * pixel from that backing store, so shrinking it here would put every click in
 * the wrong place.
 */
const ctx = ui.canvas.getContext("2d", { alpha: false });

/** `shared/protocol.md` binary frame tags. */
const FRAME_FULL = 0x01;
const FRAME_DIRTY_RECT = 0x02;
const DIRTY_RECT_HEADER_BYTES = 9;

/**
 * Decoding is async, so frames are chained: a dirty rect must never be painted
 * before the full frame it was diffed against.
 */
let renderChain = Promise.resolve();
let queuedFrames = 0;

/** Past this backlog, dirty rects are dropped — a keyframe follows within 5s. */
const MAX_QUEUED_FRAMES = 8;

const stats = { frames: 0, bytes: 0, since: 0, timer: null };

function onVideoFrame(buffer) {
  const bytes = new Uint8Array(buffer);
  if (bytes.length < 1) return;

  const tag = bytes[0];

  if (queuedFrames >= MAX_QUEUED_FRAMES && tag === FRAME_DIRTY_RECT) return;

  queuedFrames += 1;
  stats.bytes += bytes.length;

  renderChain = renderChain
    .then(() => paint(tag, bytes))
    .catch(() => {
      // A corrupt frame is not worth tearing the session down for; the next
      // keyframe repairs the canvas within 5 seconds.
    })
    .finally(() => {
      queuedFrames -= 1;
    });
}

async function paint(tag, bytes) {
  if (tag === FRAME_FULL) {
    const bmp = await decode(bytes.subarray(1));
    // Assigning width/height clears the canvas, so only do it on a real change.
    if (ui.canvas.width !== bmp.width || ui.canvas.height !== bmp.height) {
      ui.canvas.width = bmp.width;
      ui.canvas.height = bmp.height;
    }
    ctx.drawImage(bmp, 0, 0);
    bmp.close();
    stats.frames += 1;
    return;
  }

  if (tag === FRAME_DIRTY_RECT) {
    if (bytes.length <= DIRTY_RECT_HEADER_BYTES) return;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const x = view.getUint16(1, false); // big-endian, per shared/protocol.md
    const y = view.getUint16(3, false);
    const bmp = await decode(bytes.subarray(DIRTY_RECT_HEADER_BYTES));
    ctx.drawImage(bmp, x, y);
    bmp.close();
    stats.frames += 1;
  }
}

function decode(jpeg) {
  return createImageBitmap(new Blob([jpeg], { type: "image/jpeg" }));
}

/** PLAN 3.4: "you will need it for tuning". */
function startStatsCounter() {
  if (stats.timer !== null) return;
  stats.since = performance.now();
  stats.timer = setInterval(() => {
    const elapsed = (performance.now() - stats.since) / 1000;
    if (elapsed <= 0) return;
    ui.fps.textContent = `${(stats.frames / elapsed).toFixed(1)} fps`;
    ui.kbps.textContent = `${Math.round((stats.bytes * 8) / 1000 / elapsed)} kbps`;
    stats.frames = 0;
    stats.bytes = 0;
    stats.since = performance.now();
  }, 1000);
}

function resetRenderer() {
  if (stats.timer !== null) {
    clearInterval(stats.timer);
    stats.timer = null;
  }
  stats.frames = 0;
  stats.bytes = 0;
  queuedFrames = 0;
  renderChain = Promise.resolve();

  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, ui.canvas.width, ui.canvas.height);
  ui.fps.textContent = "– fps";
  ui.kbps.textContent = "– kbps";
}


/* ---------------------------------------------------- remote input (PLAN 4.1) */

/** Input is refused until the user has consented; the relay enforces this too. */
let inputEnabled = false;

/** ~60 moves/second is plenty and keeps the control queue short. */
const MOVE_INTERVAL_MS = 16;
let lastMoveAt = 0;

/**
 * Keys currently held down by the agent. The browser can swallow a keyup — press
 * Alt+Tab and the page never sees Alt come back up — which would leave the remote
 * machine with a stuck modifier. Anything still here on blur gets released.
 */
const heldKeys = new Set();

/**
 * Whether a mouse button went down *on the canvas*. The mouseup listener lives on
 * the window so a drag released outside the canvas still ends on the remote
 * machine — but without this flag it would also fire for every click on the
 * console's own buttons, injecting a stray mouse-up into the user's desktop.
 */
let draggingFromCanvas = false;

function sendInput(message) {
  if (!inputEnabled || !ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ t: "agent.input", ...message }));
}

/**
 * Canvas coordinates → remote pixels, scaled by the BACKING STORE ratio and not
 * the CSS size (PLAN 4.1). The canvas is displayed smaller than the remote
 * desktop, so using CSS pixels would put every click short of where the agent
 * aimed — proportionally further out the closer to the bottom-right they click.
 */
function toRemotePixels(ev) {
  const rect = ui.canvas.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return { x: 0, y: 0 };

  const x = Math.round((ev.clientX - rect.left) * (ui.canvas.width / rect.width));
  const y = Math.round((ev.clientY - rect.top) * (ui.canvas.height / rect.height));

  return {
    x: Math.max(0, Math.min(ui.canvas.width - 1, x)),
    y: Math.max(0, Math.min(ui.canvas.height - 1, y)),
  };
}

function setInputEnabled(enabled) {
  inputEnabled = enabled;
  ui.specialKeys.disabled = !enabled;
  if (!enabled) {
    heldKeys.clear();
    draggingFromCanvas = false;
    ui.inputHint.textContent = "click the screen to send input";
  }
}

ui.canvas.addEventListener("mousemove", (ev) => {
  const now = performance.now();
  if (now - lastMoveAt < MOVE_INTERVAL_MS) return;
  lastMoveAt = now;
  sendInput({ kind: "mouse", ...toRemotePixels(ev), action: "move", button: null });
});

ui.canvas.addEventListener("mousedown", (ev) => {
  ev.preventDefault();
  ui.canvas.focus();
  draggingFromCanvas = true;
  sendInput({ kind: "mouse", ...toRemotePixels(ev), action: "down", button: ev.button });
});

// On window, not the canvas: a drag released outside the canvas must still send
// the button up, or the remote machine is left mid-drag. Only when the press
// actually started on the canvas, though — otherwise clicking the console's own
// buttons would inject a mouse-up into the remote desktop.
window.addEventListener("mouseup", (ev) => {
  if (!inputEnabled || !draggingFromCanvas) return;
  draggingFromCanvas = false;
  sendInput({ kind: "mouse", ...toRemotePixels(ev), action: "up", button: ev.button });
});

ui.canvas.addEventListener("wheel", (ev) => {
  ev.preventDefault();
  // Windows counts 120 per notch and inverts the sign: positive is away from the
  // user, while the DOM's deltaY is positive scrolling down.
  const notches = ev.deltaMode === 1 ? ev.deltaY / 3 : ev.deltaY / 100;
  const delta = Math.max(-3, Math.min(3, Math.round(-notches))) * 120;
  if (delta === 0) return;
  sendInput({ kind: "mouse", ...toRemotePixels(ev), action: "wheel", button: null, wheelDelta: delta });
}, { passive: false });

// Suppress the browser's own menu — the right-click belongs to the remote machine.
ui.canvas.addEventListener("contextmenu", (ev) => ev.preventDefault());

// The two mousedown/mouseup pairs already make a double-click on Windows; this
// only stops the browser selecting the page around the canvas.
ui.canvas.addEventListener("dblclick", (ev) => ev.preventDefault());

ui.canvas.addEventListener("keydown", (ev) => {
  if (!inputEnabled) return;
  ev.preventDefault();
  heldKeys.add(ev.code);
  // event.code is the PHYSICAL key, so a layout mismatch between the agent and
  // the remote machine cannot scramble what gets typed (PLAN 4.1).
  sendInput({ kind: "key", code: ev.code, action: "down" });
});

ui.canvas.addEventListener("keyup", (ev) => {
  if (!inputEnabled) return;
  ev.preventDefault();
  heldKeys.delete(ev.code);
  sendInput({ kind: "key", code: ev.code, action: "up" });
});

ui.canvas.addEventListener("focus", () => {
  if (inputEnabled) ui.inputHint.textContent = "input active";
});

ui.canvas.addEventListener("blur", releaseHeldKeys);
window.addEventListener("blur", releaseHeldKeys);

function releaseHeldKeys() {
  for (const code of heldKeys) sendInput({ kind: "key", code, action: "up" });
  heldKeys.clear();
  if (inputEnabled) ui.inputHint.textContent = "click the screen to send input";
}

/**
 * PLAN 4.3: keys the browser swallows before the page sees them. Sent as an
 * explicit chord — every key down in order, then up in reverse.
 */
for (const button of document.querySelectorAll("#special-keys button[data-keys]")) {
  button.addEventListener("click", () => {
    const codes = button.dataset.keys.split("+");
    for (const code of codes) sendInput({ kind: "key", code, action: "down" });
    for (const code of [...codes].reverse()) sendInput({ kind: "key", code, action: "up" });
    ui.canvas.focus();
  });
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
