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
  copyCode: el("copy-code"),
  hostInfo: el("host-info"),
  uacBanner: el("uac-banner"),
  canvas: el("remote"),
  fps: el("fps"),
  kbps: el("kbps"),
  inputHint: el("input-hint"),
  specialKeys: el("special-keys"),
  elevation: el("elevation"),
  credFields: el("cred-fields"),
  elevDomain: el("elev-domain"),
  elevUsername: el("elev-username"),
  elevPassword: el("elev-password"),
  elevate: el("elevate"),
  elevStatus: el("elev-status"),
  sendSas: el("send-sas"),
  scripting: el("scripting"),
  shell: el("shell"),
  asSystem: el("as-system"),
  script: el("script"),
  runScript: el("run-script"),
  scriptOutput: el("script-output"),
  scriptHistory: el("script-history"),
  scriptHistoryBlock: el("script-history-block"),
  scriptHistoryCount: el("script-history-count"),
  endSession: el("end-session"),

  // Phase-1 UI modernization: purely-reflective elements, driven from the state
  // transitions below. None of them originate a network message or change one.
  headerCode: el("header-session-code"),
  headerDuration: el("header-session-duration"),
  leftCode: el("session-current-code"),
  leftDuration: el("session-current-duration"),
  leftHost: el("session-current-host"),
  viewportCode: el("viewport-session-code"),
  sessionEvents: el("session-events"),
  statusbarResolution: el("statusbar-resolution"),
  statusbarFps: el("statusbar-fps"),
  statusbarKbps: el("statusbar-kbps"),
  statusbarElevated: el("statusbar-elevated"),
  leftPanel: el("left-panel"),
  rightPanel: el("right-panel"),
  leftPanelToggle: el("left-panel-toggle"),
  rightPanelToggle: el("right-panel-toggle"),
  toggleFullscreen: el("toggle-fullscreen"),
  toolbarScripts: el("toolbar-scripts"),
  scriptsSection: el("scripts-section"),

  // UI polish 1.1: presentational only — an idle-state twin of New Session, the
  // customer-machine row, the elevation state line, the inspector tabs and the
  // toolbar's More overflow. None of them originate or alter a wire message.
  idleNewSession: el("idle-new-session"),
  sessionHostRow: el("session-host-row"),
  elevState: el("elev-state"),
  toolbarMore: el("toolbar-more"),
  toolbarMoreWrap: document.querySelector(".toolbar-more"),
};

/** Reflects the server-side state machine in the header chip. */
function setStatus(text, state = "idle") {
  ui.status.textContent = text;
  ui.status.dataset.state = state;

  // Every other copy of the state — left panel, status bar, the idle empty-state
  // over the canvas — mirrors from the same two values, so there is exactly one
  // place that decides what the state machine says.
  for (const mirror of document.querySelectorAll(".js-status-mirror")) {
    mirror.textContent = text;
    mirror.dataset.state = state;
  }
  document.body.dataset.appState = state;
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
  resetScripting();
  resetElevation();
  ui.scripting.disabled = true;
  ws = null;
  endedByAgent = false;
  lastNotice = null;
  setStartEnabled(true);
  ui.endSession.disabled = true;
  ui.uacBanner.hidden = true;
  stopDurationTimer();
  setSessionPhase("none");
  if (ui.headerCode) ui.headerCode.hidden = true;
  if (ui.leftCode) ui.leftCode.textContent = "—";
  if (ui.leftHost) ui.leftHost.textContent = "—";
  if (ui.sessionHostRow) ui.sessionHostRow.hidden = true;
  if (ui.elevState) { ui.elevState.textContent = "Standard session"; ui.elevState.dataset.state = ""; }
  if (ui.viewportCode) ui.viewportCode.textContent = "";
  if (ui.statusbarElevated) ui.statusbarElevated.hidden = true;
  setStatus(text, state);
}

function startSession() {
  setStartEnabled(false);
  resetRenderer();
  ui.hostInfo.textContent = "";
  ui.codeBlock.hidden = true;
  lastNotice = null;
  resetSessionEvents();
  setSessionPhase("pending");
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
      logEvent("Session created");
      break;

    case "peer.joined":
      if (msg.role === "host") {
        const i = msg.info ?? {};
        ui.hostInfo.textContent = `${i.machine ?? "?"} · ${i.user ?? "?"} · ${i.os ?? "?"}`;
        setStatus("Awaiting consent…", "waiting");
        if (ui.leftHost) ui.leftHost.textContent = ui.hostInfo.textContent;
        if (ui.sessionHostRow) ui.sessionHostRow.hidden = false;
        logEvent("User joined");
      }
      break;

    case "consent.result":
      if (msg.accepted) {
        setStatus("Connected", "active");
        ui.endSession.disabled = false;
        startStatsCounter();
        setInputEnabled(true);
        ui.scripting.disabled = false;
        ui.elevation.disabled = false;
        startDurationTimer();
        setSessionPhase("live");
        logEvent("Consent accepted — connected");
      } else {
        setStatus("User declined", "error");
        logEvent("Consent declined");
      }
      break;

    // Phase 5.6 drives this from the host's desktop switch; the banner itself is
    // part of the Phase 1 console (PLAN 1.4).
    case "host.desktopChanged":
      ui.uacBanner.hidden = msg.desktop !== "Winlogon";
      break;

    case "host.elevated":
      onElevated(msg);
      break;

    case "host.execResult":
      onExecResult(msg);
      break;

    case "peer.left":
      ui.uacBanner.hidden = true;
      notify(msg.role === "host" ? "User disconnected" : "Disconnected", "error");
      logEvent(msg.role === "host" ? "User disconnected" : "Disconnected");
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
      if (ui.statusbarResolution) ui.statusbarResolution.textContent = `${bmp.width}×${bmp.height}`;
      // Display-only: lets CSS fit the canvas inside the viewport at this aspect
      // ratio. The backing store above is untouched, so mapping stays exact.
      ui.canvas.style.setProperty("--remote-ar", String(bmp.width / bmp.height));
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
    if (ui.statusbarFps) ui.statusbarFps.textContent = ui.fps.textContent.replace(" fps", "");
    if (ui.statusbarKbps) ui.statusbarKbps.textContent = ui.kbps.textContent.replace(" kbps", "");
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
  if (ui.statusbarFps) ui.statusbarFps.textContent = "–";
  if (ui.statusbarKbps) ui.statusbarKbps.textContent = "–";
  if (ui.statusbarResolution) ui.statusbarResolution.textContent = "–";
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

/** Keeps #input-hint and its status-bar copy in sync (.js-input-mirror). */
function setInputHint(text) {
  for (const mirror of document.querySelectorAll(".js-input-mirror")) mirror.textContent = text;
}

function setInputEnabled(enabled) {
  inputEnabled = enabled;
  ui.specialKeys.disabled = !enabled;
  if (!enabled) {
    heldKeys.clear();
    draggingFromCanvas = false;
    setInputHint("click the screen to send input");
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
  if (inputEnabled) setInputHint("input active");
});

ui.canvas.addEventListener("blur", releaseHeldKeys);
window.addEventListener("blur", releaseHeldKeys);

function releaseHeldKeys() {
  for (const code of heldKeys) sendInput({ kind: "key", code, action: "up" });
  heldKeys.clear();
  if (inputEnabled) setInputHint("click the screen to send input");
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


/* ------------------------------------------------- script execution (PLAN 6.2) */

/** The execution currently awaiting its final result, or null. */
let runningExec = null;

/** PLAN 6.2: a per-session history of what was run. */
let execHistory = 0;

function runScript() {
  const script = ui.script.value;
  if (script.trim() === "" || runningExec !== null) return;
  if (!ws || ws.readyState !== WebSocket.OPEN) return;

  const id = `x${Date.now().toString(36)}`;
  runningExec = id;
  ui.runScript.disabled = true;
  ui.scriptOutput.textContent = "";
  appendOutput(`> running…\n`);

  ws.send(JSON.stringify({
    t: "agent.exec",
    id,
    shell: ui.shell.value,
    script,
    asSystem: ui.asSystem.checked,
  }));

  addHistory(script, ui.shell.value, ui.asSystem.checked);
}

/**
 * `partial: true` chunks stream in while the script runs; exactly one non-partial
 * result closes it out with the real exit code
 * (`shared/protocol.md` "host.execResult streaming").
 */
function onExecResult(msg) {
  if (msg.stdout) appendOutput(msg.stdout);
  if (msg.stderr) appendOutput(msg.stderr);

  if (msg.partial === true) return;

  const ok = msg.exitCode === 0;
  const line = document.createElement("span");
  line.className = ok ? "exit-ok" : "exit-bad";
  line.textContent = `\n[exit code ${msg.exitCode}]\n`;
  ui.scriptOutput.appendChild(line);
  ui.scriptOutput.scrollTop = ui.scriptOutput.scrollHeight;

  if (msg.id === runningExec) {
    runningExec = null;
    ui.runScript.disabled = false;
  }
}

function appendOutput(text) {
  ui.scriptOutput.appendChild(document.createTextNode(text));
  ui.scriptOutput.scrollTop = ui.scriptOutput.scrollHeight;
}

function addHistory(script, shell, asSystem) {
  const item = document.createElement("li");
  const label = document.createElement("code");
  // textContent, never innerHTML: the script is arbitrary text and must never be
  // parsed as markup by the console that submitted it.
  label.textContent = script.length > 90 ? `${script.slice(0, 90)}…` : script;
  item.append(
    document.createTextNode(`${new Date().toLocaleTimeString()} · ${shell}${asSystem ? " · SYSTEM" : ""} `),
    label,
  );
  ui.scriptHistory.appendChild(item);
  ui.scriptHistoryCount.textContent = String(++execHistory);
  ui.scriptHistoryBlock.hidden = false;
}

function resetScripting() {
  runningExec = null;
  execHistory = 0;
  ui.runScript.disabled = false;
  ui.scriptOutput.textContent = "";
  ui.scriptHistory.replaceChildren();
  ui.scriptHistoryCount.textContent = "0";
  ui.scriptHistoryBlock.hidden = true;
}

ui.runScript.addEventListener("click", runScript);

// Ctrl+Enter runs, so the agent does not have to reach for the mouse mid-call.
ui.script.addEventListener("keydown", (ev) => {
  if (ev.key === "Enter" && (ev.ctrlKey || ev.metaKey)) {
    ev.preventDefault();
    runScript();
  }
});

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

  if (ui.headerCode) { ui.headerCode.textContent = `Session ${code}`; ui.headerCode.hidden = false; }
  if (ui.leftCode) ui.leftCode.textContent = code;
  if (ui.viewportCode) ui.viewportCode.textContent = `Session ${code}`;
}

function endSession() {
  ui.endSession.disabled = true;
  if (ws && ws.readyState === WebSocket.OPEN) {
    endedByAgent = true;
    logEvent("Session ended");
    ws.send(JSON.stringify({ t: "agent.end" }));
    ws.close();
  } else {
    resetToIdle("Session ended", "idle");
  }
}

/* ------------------------------------------------------ elevation (PLAN 5.2) */

/** True once the host reports the elevated service is running. */
let elevated = false;

/** Show/hide the credential inputs with the elevation mode radios (PLAN 1.4). */
for (const radio of document.querySelectorAll('input[name="elev-mode"]')) {
  radio.addEventListener("change", (e) => {
    ui.credFields.hidden = e.target.value !== "credential";
  });
}

function elevationMode() {
  return document.querySelector('input[name="elev-mode"]:checked')?.value ?? "interactive";
}

/**
 * PLAN 5.2c rule 4, console side: the password lives in the input and in one
 * message object, and in neither for longer than this function. It is never put
 * in localStorage or sessionStorage, never logged, and never kept for a retry —
 * a second attempt is typed again.
 */
function requestElevation() {
  if (!ws || ws.readyState !== WebSocket.OPEN || elevated) return;

  const mode = elevationMode();
  ui.elevate.disabled = true;

  if (mode === "interactive") {
    // The prompt appears on the USER's screen, and only they can answer it —
    // saying so is the difference between the agent waiting and the agent
    // assuming the tool is broken (PLAN 5.2a).
    ui.elevStatus.textContent =
      "Ask the user to approve the Windows prompt on their screen.";
    ws.send(JSON.stringify({ t: "agent.requestElevation", mode: "interactive" }));
    return;
  }

  const username = ui.elevUsername.value.trim();
  if (username === "") {
    ui.elevStatus.textContent = "Enter the admin username.";
    ui.elevate.disabled = false;
    return;
  }

  ui.elevStatus.textContent = "Elevating…";
  ws.send(JSON.stringify({
    t: "agent.requestElevation",
    mode: "credential",
    domain: ui.elevDomain.value.trim(),
    username,
    password: ui.elevPassword.value,
  }));

  // Cleared the instant it is sent: nothing on this page should still hold an
  // admin password once the frame is on the wire.
  ui.elevPassword.value = "";
}

function onElevated(msg) {
  ui.elevate.disabled = false;

  if (msg.ok === true) {
    elevated = true;
    ui.elevStatus.textContent = "Elevated — UAC prompts are now visible.";
    // PLAN 4.3: SendInput cannot produce a Secure Attention Sequence at all. The
    // button becomes usable only once the elevated service can call SendSAS().
    ui.sendSas.disabled = false;
    ui.sendSas.title = "Send Ctrl+Alt+Del through the elevated service";
    ui.elevation.disabled = true;
    if (ui.elevState) { ui.elevState.textContent = "Elevated"; ui.elevState.dataset.state = "elevated"; }
    if (ui.statusbarElevated) ui.statusbarElevated.hidden = false;
    logEvent("Elevated");
    return;
  }

  // `error` is a message the applet already mapped from a Win32 code; it never
  // carries a credential (PLAN 5.2c rule 2).
  ui.elevStatus.textContent = msg.error ?? "Elevation failed.";
}

function resetElevation() {
  elevated = false;
  if (ui.elevState) { ui.elevState.textContent = "Standard session"; ui.elevState.dataset.state = ""; }
  ui.elevation.disabled = true;
  ui.elevate.disabled = false;
  ui.elevStatus.textContent = "";
  ui.elevDomain.value = "";
  ui.elevUsername.value = "";
  ui.elevPassword.value = "";
  ui.sendSas.disabled = true;
  ui.sendSas.title = "Requires elevation (Phase 5)";
}

ui.elevate.addEventListener("click", requestElevation);

/**
 * Ctrl+Alt+Del. Not a chord of key events — no amount of SendInput produces a
 * Secure Attention Sequence; the elevated service calls SendSAS() (PLAN 4.3).
 */
ui.sendSas.addEventListener("click", () => {
  if (!ws || ws.readyState !== WebSocket.OPEN || !elevated) return;
  ws.send(JSON.stringify({ t: "agent.input", kind: "sas", action: "press" }));
  ui.canvas.focus();
});

/**
 * Copy-to-clipboard for the session code and the join link.
 *
 * Only the label <span> changes — replacing the button's textContent would drop
 * its icon — and the original wording is restored afterwards. The Clipboard API
 * needs a secure context, so a refusal is reported, not thrown: the code and the
 * link are both selectable text either way.
 */
function wireCopy(button, read) {
  if (!button) return;
  const label = button.querySelector("span") ?? button;
  const original = label.textContent;
  button.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(read());
      label.textContent = "Copied";
    } catch {
      label.textContent = "Copy failed";
    }
    setTimeout(() => (label.textContent = original), 1500);
  });
}

wireCopy(ui.copyLink, () => ui.joinUrl.textContent);
wireCopy(ui.copyCode, () => ui.code.textContent);

ui.startSession.addEventListener("click", startSession);
ui.endSession.addEventListener("click", endSession);


/* ---------------------------------------- UI modernization (Phase 1, presentational) */
/*
 * Everything below is purely visual/UI state: it reflects real transitions the
 * console already goes through (never fabricates data), and never sends or
 * changes a wire message. See DEV_NOTES.md "Technician Console UI Modernization".
 */

/** Appends a timestamped entry to the left panel's session-events log. */
function logEvent(text) {
  if (!ui.sessionEvents) return;
  const empty = ui.sessionEvents.querySelector(".event-empty");
  if (empty) empty.remove();
  const li = document.createElement("li");
  const time = document.createElement("time");
  time.textContent = new Date().toLocaleTimeString();
  li.append(document.createTextNode(text), time);
  ui.sessionEvents.appendChild(li);
}

function resetSessionEvents() {
  if (!ui.sessionEvents) return;
  ui.sessionEvents.replaceChildren();
  const li = document.createElement("li");
  li.className = "event-empty";
  li.textContent = "No events yet";
  ui.sessionEvents.appendChild(li);
}

/** A real elapsed-time clock, started once consent is accepted (PLAN 1.4 header). */
let durationTimer = null;
let durationSince = 0;

function startDurationTimer() {
  if (durationTimer !== null) return;
  durationSince = Date.now();
  const tick = () => {
    const secs = Math.max(0, Math.floor((Date.now() - durationSince) / 1000));
    const text = `${String(Math.floor(secs / 60)).padStart(2, "0")}:${String(secs % 60).padStart(2, "0")}`;
    if (ui.headerDuration) { ui.headerDuration.textContent = text; ui.headerDuration.hidden = false; }
    if (ui.leftDuration) ui.leftDuration.textContent = text;
  };
  tick();
  durationTimer = setInterval(tick, 1000);
}

function stopDurationTimer() {
  if (durationTimer !== null) clearInterval(durationTimer);
  durationTimer = null;
  if (ui.headerDuration) ui.headerDuration.hidden = true;
  if (ui.leftDuration) ui.leftDuration.textContent = "—";
}

/**
 * Session phase, independent of the status pill: the server can send an `error`
 * mid-session without ending it, so "is a stream live" must not be inferred from
 * the pill's state. none → pending (code issued) → live (consent accepted).
 */
function setSessionPhase(phase) {
  document.body.dataset.session = phase;
}

/** Left/right panel collapse — a pure layout toggle, nothing it hides is torn down. */
function setPanelCollapsed(panel, toggle, collapsed) {
  if (!panel || !toggle) return;
  panel.classList.toggle("collapsed", collapsed);
  toggle.setAttribute("aria-expanded", String(!collapsed));
  const name = panel === ui.leftPanel ? "sessions" : "tools";
  toggle.setAttribute("aria-label", `${collapsed ? "Expand" : "Collapse"} ${name} panel`);
  toggle.title = collapsed ? "Expand panel" : "Collapse panel";
}

for (const [panel, toggle] of [[ui.leftPanel, ui.leftPanelToggle], [ui.rightPanel, ui.rightPanelToggle]]) {
  toggle?.addEventListener("click", () => {
    setPanelCollapsed(panel, toggle, !panel.classList.contains("collapsed"));
  });
}

// Keep the remote screen usable on narrow windows by starting side panels as
// rails. Both panels stay expanded at the 1280px+ widths the design targets.
const narrowForLeft = window.matchMedia("(max-width: 1279px)");
const narrowForRight = window.matchMedia("(max-width: 1099px)");
function applyResponsivePanels() {
  setPanelCollapsed(ui.leftPanel, ui.leftPanelToggle, narrowForLeft.matches);
  setPanelCollapsed(ui.rightPanel, ui.rightPanelToggle, narrowForRight.matches);
}
narrowForLeft.addEventListener("change", applyResponsivePanels);
narrowForRight.addEventListener("change", applyResponsivePanels);
applyResponsivePanels();

/** Fullscreen the remote viewport using the standard Fullscreen API. */
const viewportEl = document.getElementById("screen");
if (ui.toggleFullscreen && viewportEl) {
  ui.toggleFullscreen.addEventListener("click", async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await viewportEl.requestFullscreen();
    } catch {
      // Fullscreen can be refused by the browser (e.g. no user-activation edge
      // cases); nothing here depends on it succeeding.
    }
  });
  document.addEventListener("fullscreenchange", () => {
    ui.toggleFullscreen.classList.toggle("active", document.fullscreenElement === viewportEl);
  });
}

/**
 * New Session has two buttons — the toolbar's and the one on the idle screen —
 * and exactly one code path behind them. They are enabled and disabled together
 * so neither can start a second session while the first is being created.
 */
function setStartEnabled(enabled) {
  ui.startSession.disabled = !enabled;
  if (ui.idleNewSession) ui.idleNewSession.disabled = !enabled;
}

ui.idleNewSession?.addEventListener("click", startSession);

/* ---- right-panel tabs (Tools / Scripts / Chat / Notes) --------------------- */
/*
 * A pure show/hide over sections that already existed in one long column.
 * Nothing is torn down when a tab is hidden: the script pane keeps its output
 * and history, the elevation fieldset keeps its state, and both keep receiving
 * server messages exactly as before.
 */
const tabs = [...document.querySelectorAll(".panel-tab")];

function selectTab(name) {
  for (const tab of tabs) {
    const active = tab.dataset.tab === name;
    tab.setAttribute("aria-selected", String(active));
    const panel = document.getElementById(tab.getAttribute("aria-controls"));
    if (panel) panel.hidden = !active;
  }
}

for (const tab of tabs) {
  tab.addEventListener("click", () => selectTab(tab.dataset.tab));
}

/** The toolbar's Scripts shortcut opens the panel and the tab the pane lives in. */
if (ui.toolbarScripts && ui.scriptsSection) {
  ui.toolbarScripts.addEventListener("click", () => {
    setPanelCollapsed(ui.rightPanel, ui.rightPanelToggle, false);
    selectTab("scripts");
    ui.scriptsSection.scrollIntoView({ behavior: "smooth", block: "nearest" });
    ui.script.focus();
  });
}

/* ---- toolbar "More" overflow ---------------------------------------------- */
/*
 * Below 1280px the Support group is CSS-positioned as a menu under this button
 * (one DOM subtree, never duplicated buttons). The JS only tracks open/closed.
 */
function setMoreOpen(open) {
  if (!ui.toolbarMoreWrap || !ui.toolbarMore) return;
  // A click anywhere closes the menu, and during a session that is every click
  // on the canvas — so do nothing at all unless the state actually changes.
  if (ui.toolbarMoreWrap.hasAttribute("data-open") === open) return;
  ui.toolbarMoreWrap.toggleAttribute("data-open", open);
  ui.toolbarMore.setAttribute("aria-expanded", String(open));
}

ui.toolbarMore?.addEventListener("click", (ev) => {
  ev.stopPropagation();
  setMoreOpen(!ui.toolbarMoreWrap.hasAttribute("data-open"));
});

document.addEventListener("click", (ev) => {
  if (!ui.toolbarMoreWrap?.contains(ev.target)) setMoreOpen(false);
});

document.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape") setMoreOpen(false);
});

setStatus("Idle");

export { ui, setStatus };
