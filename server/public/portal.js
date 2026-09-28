/**
 * Agent console (PLAN 1.4) — multi-session.
 *
 * Phase 1: session creation, the join link, the state-machine status line, the
 * "UAC prompt active" banner and End session. Phase 3.4 adds the canvas renderer
 * and the FPS/kbps counter; Phase 4.1 adds mouse and keyboard capture; Phase 5
 * elevation; Phase 6.2 the script pane; Feature Batches 1–2 view aids, hold,
 * chat and notes.
 *
 * MULTI-SESSION. A technician holds up to `maxSessions` (4) live sessions at
 * once. Each one is a `RemoteSession` with everything that used to be a module
 * global: its OWN WebSocket, its own canvas and renderer queue, its own held
 * keys and mouse buttons, hold, elevation, chat, script pane, notes draft,
 * timers and reconnect state. Nothing mutable is shared between sessions.
 *
 * Isolation is structural, not a check that could be forgotten:
 *   - every session has its own socket, and the relay binds a socket to exactly
 *     one session — there is no sessionId on the wire for anything to get wrong;
 *   - input listeners are bound to each session's own canvas and send only on
 *     that session's socket, and only while it is the SELECTED session;
 *   - scripts, elevation, Ctrl+Alt+Del, hold, chat, Send URL and notes all go to
 *     `sel()` — and the drafts the technician types (script, chat, notes) are
 *     per session, so text typed for PC-A can never be sent to PC-B;
 *   - switching sessions first releases every key and button still held down on
 *     the session being left, and clears any typed admin password.
 *
 * The shared DOM (every existing id) always shows the SELECTED session. Content
 * that belongs to one session — chat log, script output and history, event
 * logs — is parked in that session's own DocumentFragment while it is not
 * selected and moved back when it is.
 *
 * SECURITY (PLAN 1.4 / 5.2c): the credential fields must never be written to
 * localStorage or sessionStorage, and must be cleared immediately after send —
 * and now also whenever the selected session changes.
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

  // UI polish 1.1: presentational only.
  idleNewSession: el("idle-new-session"),

  // Feature Batch 1 — fullscreen, zoom, magnifier, hold/resume.
  holdSession: el("hold-session"),
  resumeSession: el("resume-session"),
  holdBanner: el("hold-banner"),
  statusbarHold: el("statusbar-hold"),
  zoom: el("zoom"),
  zoomReadout: el("zoom-readout"),
  magnifier: el("magnifier"),
  lens: el("magnifier-lens"),
  exitFullscreen: el("exit-fullscreen"),
  canvasWrap: document.querySelector(".canvas-wrap"),
  sessionHostRow: el("session-host-row"),
  elevState: el("elev-state"),
  toolbarMore: el("toolbar-more"),
  toolbarMoreWrap: document.querySelector(".toolbar-more"),

  // Feature Batch 2 — chat, Send URL, predefined replies, history & notes.
  toolbarHistory: el("toolbar-history"),
  toolbarChat: el("toolbar-chat"),
  toolbarSendUrl: el("toolbar-sendurl"),
  toolbarQuickReplies: el("toolbar-quickreplies"),
  chatSection: el("chat-section"),
  notesSection: el("notes-section"),
  chatConnection: el("chat-connection"),
  chatLog: el("chat-log"),
  chatJump: el("chat-jump"),
  chatUnreadBadge: el("chat-unread"),
  chatForm: el("chat-form"),
  chatInput: el("chat-input"),
  chatSend: el("chat-send"),
  quickReplySelect: el("quick-reply-select"),
  quickReplyManage: el("quick-reply-manage"),
  quickReplyEditor: el("quick-reply-editor"),
  quickReplyList: el("quick-reply-list"),
  quickReplyAddForm: el("quick-reply-add-form"),
  quickReplyAddInput: el("quick-reply-add-input"),
  quickReplyEditorClose: el("quick-reply-editor-close"),
  notesHistory: el("notes-history"),
  sessionNotes: el("session-notes"),
  saveNotes: el("save-notes"),
  notesSavedHint: el("notes-saved-hint"),
  urlModal: el("url-modal"),
  urlForm: el("url-form"),
  urlInput: el("url-input"),
  urlLabelInput: el("url-label-input"),
  urlError: el("url-error"),
  urlCancel: el("url-cancel"),

  // Multi-session.
  sessionTabs: el("session-tabs"),
  addSession: el("add-session"),
  sessionSummary: el("session-summary"),
  layoutTabs: el("layout-tabs"),
  layoutGrid: el("layout-grid"),
  disconnectAll: el("disconnect-all"),
  limitModal: el("limit-modal"),
  limitText: el("limit-text"),
  limitView: el("limit-view"),
  limitClose: el("limit-close"),
  disconnectAllModal: el("disconnect-all-modal"),
  disconnectAllText: el("disconnect-all-text"),
  disconnectAllCancel: el("disconnect-all-cancel"),
  disconnectAllConfirm: el("disconnect-all-confirm"),
  toasts: el("toasts"),
  sessionInfo: el("session-info"),
  infoSection: el("info-section"),
};

/** Reflects the SELECTED session's state in the header chip and its mirrors. */
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

function wsUrl() {
  const scheme = location.protocol === "https:" ? "wss:" : "ws:";
  return `${scheme}//${location.host}/ws`;
}

/** `shared/protocol.md` binary frame tags. */
const FRAME_FULL = 0x01;
const FRAME_DIRTY_RECT = 0x02;
const DIRTY_RECT_HEADER_BYTES = 9;

/** Past this backlog, dirty rects are dropped — a keyframe follows within 5s. */
const MAX_QUEUED_FRAMES = 8;

/** ~60 moves/second is plenty and keeps the control queue short. */
const MOVE_INTERVAL_MS = 16;

/* =====================================================================
   SESSION MODEL
   ===================================================================== */

/**
 * Client-side lifecycle. The relay's own states are waiting_for_host →
 * waiting_for_consent → active → ended; the console adds the socket's view:
 *
 *   connecting ─► waiting ─► consent ─► connected ─┐
 *                                        ▲         ▼
 *                                        └─ reconnecting
 *   terminal: ended | failed   (the tab leaves the strip)
 */
const STATE_LABEL = {
  connecting: "Connecting",
  waiting: "Waiting for user",
  consent: "Awaiting consent",
  connected: "Connected",
  reconnecting: "Reconnecting",
  ended: "Disconnected",
  failed: "Failed",
};

/** Close codes after which resuming is pointless: the relay ended the session on purpose. */
const FINAL_CLOSE_CODES = new Set([1000, 1002, 1008, 1009, 1011, 4403, 4409]);

/** Backoff for technician-side reconnect; the relay keeps the session ~60 s. */
const RECONNECT_DELAYS_MS = [400, 1000, 2000, 3000, 5000, 5000, 8000, 8000, 8000, 8000];
const RECONNECT_WINDOW_MS = 55_000;

const STORAGE_KEY = "hda.sessions.v1";

const PARKED_KEYS = ["chatLog", "scriptOutput", "scriptHistory", "sessionEvents", "notesHistory"];

let sessionSeq = 0;

class RemoteSession {
  constructor() {
    this.key = ++sessionSeq;          // local, never on the wire
    this.sessionId = null;            // permanent id from session.created
    this.code = null;                 // pairing secret, only while waiting
    this.resumeToken = null;          // bearer secret for agent.resume, per session
    this.ws = null;
    this.state = "connecting";
    this.phase = "pending";           // none | pending | live  (body[data-session])
    this.statusText = "Connecting…";
    this.statusState = "waiting";
    this.lastNotice = null;
    this.endedByAgent = false;
    this.host = null;                 // { machine, user, os }
    this.createdAt = Date.now();
    this.consentedAt = null;
    this.lastActivityAt = Date.now();

    // Renderer.
    this.tile = null;
    this.canvas = null;
    this.ctx = null;
    this.renderChain = Promise.resolve();
    this.queuedFrames = 0;
    this.stats = { frames: 0, bytes: 0, since: performance.now() };
    this.fpsText = "– fps";
    this.kbpsText = "– kbps";
    this.resolution = "–";
    this.lastFrameAt = 0;
    this.bytesIn = 0;
    this.viewSent = "full";

    // Input.
    this.inputEnabled = false;
    this.heldKeys = new Set();
    this.heldButtons = new Set();
    this.lastRemotePoint = { x: 0, y: 0 };
    this.lastMoveAt = 0;

    // Hold / elevation / UAC.
    this.held = false;
    this.elevated = false;
    this.elevStatus = "";
    this.elevPending = false;
    this.desktop = "Default";

    // Scripts.
    this.runningExec = null;
    this.execHistory = 0;
    this.scriptDraft = "";

    // Chat & notes.
    this.pendingChatRows = new Map();
    this.failedChatPayloads = new Map();
    this.chatIds = new Set();
    this.chatHasStarted = false;
    this.chatCount = 0;
    this.unread = 0;
    this.chatDraft = "";
    this.chatScroll = null;
    this.notesDraft = "";

    // Reconnect.
    this.reconnect = { attempts: 0, count: 0, startedAt: null, lastReason: null, timer: null };

    // Per-session DOM that is parked while another session is selected.
    this.parked = {};
    for (const k of PARKED_KEYS) this.parked[k] = document.createDocumentFragment();
    this.parked.chatLog.appendChild(chatEmptyNotice());
    this.parked.sessionEvents.appendChild(eventEmptyItem());
    this.parked.notesHistory.appendChild(eventEmptyItem());

    // Strip tab.
    this.tabEl = null;
  }

  get isSelected() { return manager.selected === this; }
  get isLive() { return this.state !== "ended" && this.state !== "failed"; }
  get open() { return this.ws !== null && this.ws.readyState === WebSocket.OPEN; }

  /** Machine name once known; otherwise the code or a placeholder. */
  get label() {
    if (this.host?.machine) return this.host.machine;
    if (this.code) return `Session ${this.code}`;
    return "New session";
  }

  send(message) {
    if (!this.open) return false;
    this.ws.send(JSON.stringify(message));
    return true;
  }
}

/** The one owner of every RemoteSession. */
const manager = {
  sessions: [],
  selected: null,
  layout: "tabs",
  maxSessions: 4,
};

/** The session the technician is working in, or null. */
function sel() { return manager.selected; }

function liveSessions() { return manager.sessions.filter((s) => s.isLive); }

/* ------------------------------------------------------------- DOM helpers */

function chatEmptyNotice() {
  const empty = document.createElement("p");
  empty.className = "chat-empty";
  empty.textContent = "No messages yet. Chat is available once a session is connected.";
  return empty;
}

function eventEmptyItem() {
  const li = document.createElement("li");
  li.className = "event-empty";
  li.textContent = "No events yet";
  return li;
}

/** Where a session's per-session content lives right now: the live element, or its parking fragment. */
function target(s, key) {
  return s.isSelected ? ui[key] : s.parked[key];
}

function park(s) {
  if (ui.chatLog) s.chatScroll = ui.chatLog.scrollTop;
  for (const k of PARKED_KEYS) {
    const live = ui[k];
    if (!live) continue;
    const frag = document.createDocumentFragment();
    while (live.firstChild) frag.appendChild(live.firstChild);
    s.parked[k] = frag;
  }
}

function unpark(s) {
  for (const k of PARKED_KEYS) {
    const live = ui[k];
    if (!live) continue;
    live.replaceChildren(s.parked[k]);
    s.parked[k] = document.createDocumentFragment();
  }
  if (ui.chatLog) ui.chatLog.scrollTop = s.chatScroll ?? ui.chatLog.scrollHeight;
}

/** The shared panes with no session at all: exactly the old idle state. */
function showEmptyPanes() {
  ui.chatLog?.replaceChildren(chatEmptyNotice());
  ui.scriptOutput.textContent = "";
  ui.scriptHistory.replaceChildren();
  ui.sessionEvents?.replaceChildren(eventEmptyItem());
  ui.notesHistory?.replaceChildren(eventEmptyItem());
}

/* =====================================================================
   TILES & CANVASES
   ===================================================================== */

/**
 * Every session paints into its own <canvas>, each in its own tile. The canvas
 * of the SELECTED session carries id="remote", so everything that addresses the
 * remote screen by id (CSS focus ring, the test suite) addresses the one that
 * receives input. When no session exists one idle tile remains, holding the
 * #remote canvas, cleared to black — exactly the old idle screen.
 */
const idleTile = document.querySelector(".session-tile");

function newTile() {
  if (idleTile && !idleTile.dataset.owner) {
    return idleTile;
  }
  const tile = document.createElement("div");
  tile.className = "session-tile";
  const canvas = document.createElement("canvas");
  canvas.className = "remote-canvas";
  canvas.width = 1280;
  canvas.height = 720;
  canvas.tabIndex = -1;
  const label = document.createElement("div");
  label.className = "tile-label";
  label.innerHTML = '<span class="st-dot" aria-hidden="true"></span><span class="tile-name"></span><span class="tile-state"></span><span class="tile-control">Control active</span>';
  tile.append(canvas, label);
  ui.canvasWrap.insertBefore(tile, ui.lens ?? null);
  return tile;
}

function attachTile(s) {
  const tile = newTile();
  tile.dataset.owner = String(s.key);
  s.tile = tile;
  s.canvas = tile.querySelector("canvas");
  s.ctx = s.canvas.getContext("2d", { alpha: false });
  if (!tile.querySelector(".tile-label")) {
    const label = document.createElement("div");
    label.className = "tile-label";
    label.innerHTML = '<span class="st-dot" aria-hidden="true"></span><span class="tile-name"></span><span class="tile-state"></span><span class="tile-control">Control active</span>';
    tile.appendChild(label);
  }
  clearCanvas(s.canvas, s.ctx);
  wireCanvasInput(s);
}

function detachTile(s) {
  const tile = s.tile;
  if (!tile) return;
  unwireCanvasInput(s);
  delete tile.dataset.owner;
  tile.classList.remove("is-selected");
  if (tile === idleTile) {
    clearCanvas(s.canvas, s.ctx);
  } else {
    tile.remove();
  }
  s.tile = null;
  s.canvas = null;
  s.ctx = null;
}

function clearCanvas(canvas, ctx) {
  if (!canvas || !ctx) return;
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
}

/** Move id="remote" to the selected session's canvas (or back to the idle tile). */
function assignRemoteId() {
  const current = document.getElementById("remote");
  const s = sel();
  const want = s?.canvas ?? idleTile?.querySelector("canvas") ?? null;
  if (current === want) return;
  if (current) {
    current.removeAttribute("id");
    current.tabIndex = -1;
  }
  if (want) {
    want.id = "remote";
    want.tabIndex = 0;
  }
}

function currentCanvas() {
  return sel()?.canvas ?? document.getElementById("remote");
}

/* =====================================================================
   LIFECYCLE: create, resume, end
   ===================================================================== */

function startSession() {
  const live = liveSessions();
  if (live.length >= manager.maxSessions) {
    showLimitModal(live.length);
    return;
  }
  const s = new RemoteSession();
  manager.sessions.push(s);
  attachTile(s);
  buildTab(s);
  select(s);
  logEvent(s, "Connecting…");
  openSocket(s, { t: "agent.create" });
  renderChrome();
}

/** Open a socket for `s` and send `first` (agent.create or agent.resume) on open. */
function openSocket(s, first) {
  const ws = new WebSocket(wsUrl());
  ws.binaryType = "arraybuffer";
  s.ws = ws;

  ws.addEventListener("open", () => {
    if (s.ws !== ws) return;
    ws.send(JSON.stringify(first));
  });

  ws.addEventListener("message", (ev) => {
    // A stale socket (replaced by a resume) must never touch the session again.
    if (s.ws !== ws) return;
    // Per-session error boundary: one session's bad frame or handler bug must
    // not take down the console, or any other session.
    try {
      if (typeof ev.data !== "string") {
        onVideoFrame(s, ev.data);
        return;
      }
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      onServerMessage(s, msg);
    } catch (err) {
      console.error(`[session ${s.key}] handler error:`, err);
    }
  });

  ws.addEventListener("close", (ev) => {
    if (s.ws !== ws) return;
    s.ws = null;
    try {
      onSocketClosed(s, ev);
    } catch (err) {
      console.error(`[session ${s.key}] close handler error:`, err);
      disposeSession(s, { text: "Disconnected", state: "idle" });
    }
  });

  ws.addEventListener("error", () => {
    if (s.ws !== ws) return;
    if (s.state !== "reconnecting") setSessionStatus(s, "Connection error", "error");
  });
}

function onSocketClosed(s, ev) {
  if (s.endedByAgent) {
    disposeSession(s, { text: "Session ended", state: "idle" });
    return;
  }

  if (s.state === "reconnecting") {
    // A resume attempt's socket closed. If the relay closed it on purpose
    // (resume refused, sign-in gone) the session is over; if the network ate
    // it before any answer, try again.
    if (s.resumeToken === null || FINAL_CLOSE_CODES.has(ev.code)) {
      disposeSession(s, s.lastNotice ?? { text: "The session could not be resumed", state: "error" }, { notify: true });
    } else {
      scheduleReconnect(s);
    }
    return;
  }

  // A drop the relay did not cause: keep the session and try to resume it.
  const resumable = s.sessionId !== null && s.resumeToken !== null
    && s.state !== "connecting" && !FINAL_CLOSE_CODES.has(ev.code);
  if (resumable) {
    beginReconnect(s, ev.code === 1006 ? "connection lost" : `closed (${ev.code})`);
    return;
  }

  disposeSession(s, s.lastNotice ?? { text: "Disconnected", state: "idle" });
}

function beginReconnect(s, reason) {
  s.state = "reconnecting";
  s.reconnect.startedAt = Date.now();
  s.reconnect.attempts = 0;
  s.reconnect.lastReason = reason;
  s.inputEnabled = false;
  releaseSessionInput(s, { send: false });
  setSessionStatus(s, "Reconnecting…", "waiting");
  logEvent(s, `Connection lost — reconnecting (${reason})`);
  if (!s.isSelected) toast(s, `${s.label}: connection interrupted — reconnecting`);
  scheduleReconnect(s);
  renderChrome();
}

function scheduleReconnect(s) {
  clearTimeout(s.reconnect.timer);
  if (!manager.sessions.includes(s)) return;
  if (Date.now() - (s.reconnect.startedAt ?? Date.now()) > RECONNECT_WINDOW_MS) {
    disposeSession(s, { text: "Connection lost — the session ended", state: "error" }, { notify: true });
    return;
  }
  const delay = RECONNECT_DELAYS_MS[Math.min(s.reconnect.attempts, RECONNECT_DELAYS_MS.length - 1)];
  s.reconnect.attempts += 1;
  s.reconnect.timer = setTimeout(() => {
    if (!manager.sessions.includes(s) || s.state !== "reconnecting") return;
    openSocket(s, { t: "agent.resume", sessionId: s.sessionId, resumeToken: s.resumeToken });
  }, delay);
}

/** End one session on purpose. Never touches any other session. */
function endSession(s = sel()) {
  if (!s) return;
  if (s === sel()) ui.endSession.disabled = true;
  clearTimeout(s.reconnect.timer);
  if (s.open) {
    s.endedByAgent = true;
    logEvent(s, "Session ended");
    releaseSessionInput(s, { send: true });
    s.send({ t: "agent.end" });
    s.ws.close();
  } else {
    // Not connected (still dialling, or reconnecting): nothing to tell the relay
    // on THIS socket; a resume socket that is mid-flight is abandoned.
    if (s.ws) {
      const ws = s.ws;
      s.ws = null;
      try { ws.close(); } catch { /* already closing */ }
    }
    disposeSession(s, { text: "Session ended", state: "idle" });
  }
}

/**
 * Remove a session from the console: stop its timers, drop its socket, canvas
 * and tab, forget its resume token. If it was selected, move to a neighbour —
 * or back to the idle screen with `notice` in the status pill, exactly as a
 * single-session console did.
 */
function disposeSession(s, notice, { notify = false } = {}) {
  const idx = manager.sessions.indexOf(s);
  if (idx === -1) return;
  const wasSelected = s.isSelected;

  s.state = notice?.state === "error" ? "failed" : "ended";
  clearTimeout(s.reconnect.timer);
  if (s.ws) {
    const ws = s.ws;
    s.ws = null;
    try { ws.close(); } catch { /* ignore */ }
  }
  s.inputEnabled = false;
  s.renderChain = Promise.resolve();
  manager.sessions.splice(idx, 1);
  s.tabEl?.remove();
  s.tabEl = null;
  forgetStored(s);

  if (!wasSelected && (notify || !s.endedByAgent)) {
    toast(null, `${s.label}: ${notice?.text ?? "session ended"}`);
  }

  if (wasSelected) {
    park(s);                 // take its content out of the shared panes
    manager.selected = null;
    detachTile(s);
    const next = manager.sessions[Math.min(idx, manager.sessions.length - 1)] ?? null;
    if (next) {
      select(next);
      if (notify || !s.endedByAgent) toast(null, `${s.label}: ${notice?.text ?? "session ended"}`);
    } else {
      goIdle(notice);
    }
  } else {
    detachTile(s);
  }
  applyLayout();
  renderChrome();
}

/** No session left: the console's original idle state. */
function goIdle(notice) {
  manager.selected = null;
  assignRemoteId();
  showEmptyPanes();
  resetSharedStats();
  setMagnifier(false);
  if (ui.chatInput) ui.chatInput.value = "";
  if (ui.sessionNotes) ui.sessionNotes.value = "";
  if (ui.notesSavedHint) ui.notesSavedHint.textContent = "";
  ui.script.value = "";
  clearCredentialFields();
  setChatUnreadBadge(0);
  document.body.dataset.session = "none";
  document.body.dataset.hold = "";
  setStatus(notice?.text ?? "Idle", notice?.state ?? "idle");
  renderChrome();
}

/* =====================================================================
   SELECTION
   ===================================================================== */

/**
 * Make `s` the session that receives keyboard, mouse, clipboard and every
 * remote command. Never disconnects, pauses or throttles-to-death any other
 * session; the one being left has its held keys and buttons released first.
 */
function select(s, { focus = true } = {}) {
  const prev = manager.selected;
  if (prev === s) {
    renderChrome();
    return;
  }

  if (prev) {
    releaseSessionInput(prev, { send: true });
    prev.scriptDraft = ui.script.value;
    prev.chatDraft = ui.chatInput?.value ?? "";
    prev.notesDraft = ui.sessionNotes?.value ?? "";
    park(prev);
    prev.tile?.classList.remove("is-selected");
  } else {
    // Leaving the idle state: the shared panes hold only empty placeholders.
    showEmptyPanes();
    for (const k of PARKED_KEYS) ui[k]?.replaceChildren();
  }

  // An admin password typed for one session must never be sent to another.
  clearCredentialFields();
  setMagnifier(false);

  manager.selected = s;
  if (s) {
    unpark(s);
    s.tile?.classList.add("is-selected");
    ui.script.value = s.scriptDraft;
    if (ui.chatInput) ui.chatInput.value = s.chatDraft;
    if (ui.sessionNotes) ui.sessionNotes.value = s.notesDraft;
    if (ui.notesSavedHint) ui.notesSavedHint.textContent = "";
    if (isChatTabOpen()) s.unread = 0;
  }
  assignRemoteId();
  applyViewPriorities();
  applyLayout();
  renderChrome();
  if (s && focus && s.phase === "live" && s.inputEnabled) s.canvas?.focus();
}

/** Relay video priority: the selected session gets every frame, the rest keyframes only. */
function applyViewPriorities() {
  for (const s of manager.sessions) {
    const want = s.isSelected ? "full" : "preview";
    if (s.viewSent !== want && s.open && s.state !== "connecting") {
      if (s.send({ t: "agent.view", priority: want })) s.viewSent = want;
    }
  }
}

/* =====================================================================
   SERVER MESSAGES (per session)
   ===================================================================== */

function onServerMessage(s, msg) {
  s.lastActivityAt = Date.now();
  switch (msg.t) {
    case "session.created":
      s.sessionId = typeof msg.sessionId === "string" ? msg.sessionId : null;
      s.resumeToken = typeof msg.resumeToken === "string" ? msg.resumeToken : null;
      s.code = msg.code;
      s.state = "waiting";
      s.phase = "pending";
      remember(s);
      setSessionStatus(s, "Waiting for user…", "waiting");
      logEvent(s, "Session created");
      applyViewPriorities();
      break;

    case "session.resumed":
      onResumed(s, msg);
      break;

    case "chat.history":
      for (const m of Array.isArray(msg.messages) ? msg.messages : []) onChatMessage(s, m, { replay: true });
      break;

    case "peer.joined":
      if (msg.role === "host") {
        const i = msg.info ?? {};
        s.host = { machine: String(i.machine ?? "?"), user: String(i.user ?? "?"), os: String(i.os ?? "?") };
        s.state = "consent";  // the code is burned now; the card hides, the header keeps it as a label
        setSessionStatus(s, "Awaiting consent…", "waiting");
        logEvent(s, "User joined");
      }
      break;

    case "consent.result":
      if (msg.accepted) {
        s.state = "connected";
        s.phase = "live";
        s.consentedAt = Date.now();
        s.inputEnabled = true;
        setSessionStatus(s, "Connected", "active");
        logEvent(s, "Consent accepted — connected");
        if (!s.isSelected) toast(s, `${s.label}: customer accepted — connected`);
      } else {
        setSessionStatus(s, "User declined", "error");
        s.lastNotice = { text: "User declined", state: "error" };
        logEvent(s, "Consent declined");
      }
      break;

    // Phase 5.6 drives this from the host's desktop switch.
    case "host.desktopChanged":
      s.desktop = msg.desktop;
      if (!s.isSelected && msg.desktop === "Winlogon") toast(s, `${s.label}: UAC prompt on the customer's screen`);
      break;

    case "host.elevated":
      onElevated(s, msg);
      break;

    case "host.execResult":
      onExecResult(s, msg);
      break;

    case "peer.left":
      s.desktop = "Default";
      notifySession(s, msg.role === "host" ? "User disconnected" : "Disconnected", "error");
      logEvent(s, msg.role === "host" ? "User disconnected" : "Disconnected");
      break;

    case "chat.message":
      onChatMessage(s, msg);
      break;

    case "error":
      onSessionError(s, msg);
      break;

    default:
      break;
  }
  refreshSession(s);
}

function onSessionError(s, msg) {
  // A refused chat send names the exact pending bubble (`clientId`) rather
  // than being a session-wide notice (§19 "UI should fail cleanly").
  if (msg.clientId && s.pendingChatRows.has(msg.clientId)) {
    markChatFailed(s.pendingChatRows.get(msg.clientId), msg.code);
    s.pendingChatRows.delete(msg.clientId);
    return;
  }

  // Multi-session limit, refused by the relay (the authority, whatever this
  // console believed): drop the tab that asked, keep every other session.
  if (msg.code === "session_limit") {
    if (typeof msg.maxSessions === "number") manager.maxSessions = msg.maxSessions;
    s.endedByAgent = true;  // nothing to report on the status pill for a tab that never existed
    const count = typeof msg.activeSessions === "number" ? msg.activeSessions : liveSessions().length - 1;
    disposeSession(s, { text: manager.sessions.length > 1 ? "Connected" : "Idle", state: manager.sessions.length > 1 ? "active" : "idle" });
    showLimitModal(count);
    return;
  }

  // A resume the relay refused: the session is gone (ended while we were away,
  // or taken over by another window). Final.
  if (msg.code === "resume_failed") {
    s.lastNotice = { text: msg.message ?? "This session can no longer be resumed.", state: "error" };
    s.resumeToken = null;
    return;
  }

  notifySession(s, msg.message ?? msg.code ?? "Error", "error");
}

function onResumed(s, msg) {
  s.reconnect.count = typeof msg.reconnectCount === "number" ? msg.reconnectCount : s.reconnect.count + 1;
  s.reconnect.attempts = 0;
  s.resumeToken = typeof msg.resumeToken === "string" ? msg.resumeToken : s.resumeToken;
  s.sessionId = msg.sessionId ?? s.sessionId;
  if (msg.host) s.host = { machine: String(msg.host.machine ?? "?"), user: String(msg.host.user ?? "?"), os: String(msg.host.os ?? "?") };
  s.held = msg.held === true;
  s.elevated = msg.elevated === true;
  if (s.elevated) s.elevStatus = "Elevated — UAC prompts are now visible.";
  s.desktop = msg.desktop ?? "Default";
  s.viewSent = "full";   // the relay resets it on resume
  s.renderChain = Promise.resolve();
  s.queuedFrames = 0;
  remember(s);

  if (msg.state === "active") {
    s.state = "connected";
    s.phase = "live";
    s.consentedAt = typeof msg.consentedAt === "number" ? msg.consentedAt : s.consentedAt ?? Date.now();
    s.inputEnabled = !s.held;
    setSessionStatus(s, s.held ? "On hold" : "Connected", s.held ? "waiting" : "active");
  } else if (msg.state === "waiting_for_consent") {
    s.state = "consent";
    s.phase = "pending";
    setSessionStatus(s, "Awaiting consent…", "waiting");
  } else {
    s.state = "waiting";
    s.phase = "pending";
    if (typeof msg.code === "string") s.code = msg.code;
    setSessionStatus(s, "Waiting for user…", "waiting");
  }
  logEvent(s, s.reconnect.startedAt ? "Reconnected" : "Session restored after reload");
  if (!s.isSelected) toast(s, `${s.label}: reconnected`);
  s.reconnect.startedAt = null;
  applyViewPriorities();
}

/** A server-supplied explanation for ONE session, kept through its socket close. */
function notifySession(s, text, state) {
  s.lastNotice = { text, state };
  setSessionStatus(s, text, state);
  if (!s.isSelected) toast(s, `${s.label}: ${text}`);
}

function setSessionStatus(s, text, state) {
  s.statusText = text;
  s.statusState = state;
  if (s.isSelected) setStatus(text, state);
}

/** Re-render whatever `s` shows: always its tab; the shared chrome only if selected. */
function refreshSession(s) {
  renderTab(s);
  if (s.isSelected) renderChrome();
  else renderSummary();
}

/* =====================================================================
   RENDERER (PLAN 3.4), one per session
   ===================================================================== */

/**
 * The canvas backing store is kept at the remote's native resolution and scaled
 * down by CSS. Phase 4 maps a click back to a remote pixel from that backing
 * store, so shrinking it here would put every click in the wrong place.
 */
function onVideoFrame(s, buffer) {
  const bytes = new Uint8Array(buffer);
  if (bytes.length < 1 || !s.ctx) return;

  const tag = bytes[0];
  s.lastFrameAt = Date.now();
  s.bytesIn += bytes.length;

  if (s.queuedFrames >= MAX_QUEUED_FRAMES && tag === FRAME_DIRTY_RECT) return;

  s.queuedFrames += 1;
  s.stats.bytes += bytes.length;

  // Decoding is async, so frames are chained per session: a dirty rect must
  // never be painted before the full frame it was diffed against.
  s.renderChain = s.renderChain
    .then(() => paint(s, tag, bytes))
    .catch(() => {
      // A corrupt frame is not worth tearing the session down for; the next
      // keyframe repairs the canvas within 5 seconds. Other sessions never see it.
    })
    .finally(() => {
      s.queuedFrames = Math.max(0, s.queuedFrames - 1);
    });
}

async function paint(s, tag, bytes) {
  const canvas = s.canvas;
  const ctx = s.ctx;
  if (!canvas || !ctx) return;  // disposed while the frame was queued

  if (tag === FRAME_FULL) {
    const bmp = await decode(bytes.subarray(1));
    if (s.canvas !== canvas) { bmp.close(); return; }
    // Assigning width/height clears the canvas, so only do it on a real change.
    const resolution = `${bmp.width}×${bmp.height}`;
    if (s.resolution !== resolution) {
      s.resolution = resolution;
      if (s.isSelected && ui.statusbarResolution) ui.statusbarResolution.textContent = resolution;
    }
    if (canvas.width !== bmp.width || canvas.height !== bmp.height) {
      canvas.width = bmp.width;
      canvas.height = bmp.height;
      // Display-only: lets CSS fit the canvas at this aspect ratio and scale it to
      // a fixed zoom level from its native width. Mapping stays exact.
      canvas.style.setProperty("--remote-ar", String(bmp.width / bmp.height));
      canvas.style.setProperty("--remote-native-w", String(bmp.width));
    }
    ctx.drawImage(bmp, 0, 0);
    bmp.close();
    s.stats.frames += 1;
    if (s.isSelected && magnifierOn) scheduleLens();
    return;
  }

  if (tag === FRAME_DIRTY_RECT) {
    if (bytes.length <= DIRTY_RECT_HEADER_BYTES) return;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const x = view.getUint16(1, false); // big-endian, per shared/protocol.md
    const y = view.getUint16(3, false);
    const bmp = await decode(bytes.subarray(DIRTY_RECT_HEADER_BYTES));
    if (s.canvas !== canvas) { bmp.close(); return; }
    ctx.drawImage(bmp, x, y);
    bmp.close();
    s.stats.frames += 1;
    if (s.isSelected && magnifierOn) scheduleLens();
  }
}

function decode(jpeg) {
  return createImageBitmap(new Blob([jpeg], { type: "image/jpeg" }));
}

function resetSharedStats() {
  ui.fps.textContent = "– fps";
  ui.kbps.textContent = "– kbps";
  if (ui.statusbarFps) ui.statusbarFps.textContent = "–";
  if (ui.statusbarKbps) ui.statusbarKbps.textContent = "–";
  if (ui.statusbarResolution) ui.statusbarResolution.textContent = "–";
}

/**
 * One 1-second ticker for the whole console (not one timer per session): frame
 * rates, durations, tab clocks, quality dots and the info panel.
 */
function tick() {
  const now = performance.now();
  for (const s of manager.sessions) {
    const elapsed = (now - s.stats.since) / 1000;
    if (s.phase === "live" && elapsed > 0) {
      s.fpsText = `${(s.stats.frames / elapsed).toFixed(1)} fps`;
      s.kbpsText = `${Math.round((s.stats.bytes * 8) / 1000 / elapsed)} kbps`;
    }
    s.stats.frames = 0;
    s.stats.bytes = 0;
    s.stats.since = now;
    renderTab(s);
  }
  const s = sel();
  if (s && s.phase === "live") {
    ui.fps.textContent = s.fpsText;
    ui.kbps.textContent = s.kbpsText;
    if (ui.statusbarFps) ui.statusbarFps.textContent = s.fpsText.replace(" fps", "");
    if (ui.statusbarKbps) ui.statusbarKbps.textContent = s.kbpsText.replace(" kbps", "");
  }
  renderDuration();
  renderSummary();
  if (isInfoTabOpen()) renderInfo();
}
setInterval(tick, 1000);

function durationText(s) {
  if (!s?.consentedAt) return null;
  const secs = Math.max(0, Math.floor((Date.now() - s.consentedAt) / 1000));
  const h = Math.floor(secs / 3600);
  const mm = String(Math.floor((secs % 3600) / 60)).padStart(2, "0");
  const ss = String(secs % 60).padStart(2, "0");
  return h > 0 ? `${String(h).padStart(2, "0")}:${mm}:${ss}` : `${mm}:${ss}`;
}

function renderDuration() {
  const text = durationText(sel());
  if (ui.headerDuration) { ui.headerDuration.textContent = text ?? ""; ui.headerDuration.hidden = text === null; }
  if (ui.leftDuration) ui.leftDuration.textContent = text ?? "—";
}

/* =====================================================================
   REMOTE INPUT (PLAN 4.1) — bound per canvas, sent only to the selected session
   ===================================================================== */

/**
 * Whether a mouse button went down on a session's canvas. The mouseup listener
 * lives on the window so a drag released outside the canvas still ends on the
 * remote machine — but only for the session the drag started in.
 */
let dragSession = null;

/**
 * The single answer to "may this console change THIS session's machine right
 * now?" — used by input, scripts, elevation and Ctrl+Alt+Del alike. It is not the
 * only answer that matters: the relay refuses the same things independently.
 */
function remoteActionsAllowed(s = sel()) {
  return !!s && s.isSelected && !s.held && s.state === "connected" && s.open;
}

function sendInput(s, message) {
  if (!s || !s.inputEnabled || !remoteActionsAllowed(s)) return;
  if (message.kind === "mouse" && typeof message.x === "number") {
    s.lastRemotePoint.x = message.x;
    s.lastRemotePoint.y = message.y;
  }
  s.send({ t: "agent.input", ...message });
}

/**
 * Canvas coordinates → remote pixels, scaled by the BACKING STORE ratio and not
 * the CSS size (PLAN 4.1).
 */
function toRemotePixels(canvas, ev) {
  const rect = canvas.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return { x: 0, y: 0 };

  const x = Math.round((ev.clientX - rect.left) * (canvas.width / rect.width));
  const y = Math.round((ev.clientY - rect.top) * (canvas.height / rect.height));

  return {
    x: Math.max(0, Math.min(canvas.width - 1, x)),
    y: Math.max(0, Math.min(canvas.height - 1, y)),
  };
}

/** Keeps #input-hint and its status-bar copy in sync (.js-input-mirror). */
function setInputHint(text) {
  for (const mirror of document.querySelectorAll(".js-input-mirror")) mirror.textContent = text;
}

/**
 * Release every key and mouse button `s` still holds on its remote machine —
 * before switching away, holding, or ending. `send: false` when the socket is
 * already gone (the relay drops nothing it never received).
 */
function releaseSessionInput(s, { send = true } = {}) {
  if (send && remoteActionsAllowed(s) && s.inputEnabled) {
    for (const code of s.heldKeys) s.send({ t: "agent.input", kind: "key", code, action: "up" });
    for (const button of s.heldButtons) {
      s.send({ t: "agent.input", kind: "mouse", x: s.lastRemotePoint.x, y: s.lastRemotePoint.y, action: "up", button });
    }
  }
  s.heldKeys.clear();
  s.heldButtons.clear();
  if (dragSession === s) dragSession = null;
}

function wireCanvasInput(s) {
  const canvas = s.canvas;
  const h = {};

  h.mousemove = (ev) => {
    if (!s.isSelected) return;
    const now = performance.now();
    if (now - s.lastMoveAt < MOVE_INTERVAL_MS) return;
    s.lastMoveAt = now;
    sendInput(s, { kind: "mouse", ...toRemotePixels(canvas, ev), action: "move", button: null });
  };

  h.mousedown = (ev) => {
    ev.preventDefault();
    // Grid view is for monitoring: a click on a session that is not the control
    // target only SELECTS it. Nothing reaches that machine until it is selected.
    if (!s.isSelected) {
      select(s);
      return;
    }
    canvas.focus();
    dragSession = s;
    s.heldButtons.add(ev.button);
    sendInput(s, { kind: "mouse", ...toRemotePixels(canvas, ev), action: "down", button: ev.button });
  };

  h.wheel = (ev) => {
    ev.preventDefault();
    if (!s.isSelected) return;
    // Windows counts 120 per notch and inverts the sign.
    const notches = ev.deltaMode === 1 ? ev.deltaY / 3 : ev.deltaY / 100;
    const delta = Math.max(-3, Math.min(3, Math.round(-notches))) * 120;
    if (delta === 0) return;
    sendInput(s, { kind: "mouse", ...toRemotePixels(canvas, ev), action: "wheel", button: null, wheelDelta: delta });
  };

  // Suppress the browser's own menu — the right-click belongs to the remote machine.
  h.contextmenu = (ev) => ev.preventDefault();
  h.dblclick = (ev) => ev.preventDefault();

  h.keydown = (ev) => {
    if (!s.isSelected || !s.inputEnabled) return;
    ev.preventDefault();
    s.heldKeys.add(ev.code);
    // event.code is the PHYSICAL key (PLAN 4.1).
    sendInput(s, { kind: "key", code: ev.code, action: "down" });
  };

  h.keyup = (ev) => {
    if (!s.isSelected || !s.inputEnabled) return;
    ev.preventDefault();
    // Only release what went down on THIS session. A key-up whose key-down
    // happened elsewhere — the tail of a Ctrl+Shift+N switch, or a key held
    // while focus moved here — belongs to no key this machine ever saw pressed.
    if (!s.heldKeys.delete(ev.code)) return;
    sendInput(s, { kind: "key", code: ev.code, action: "up" });
  };

  h.focus = () => {
    if (s.isSelected && s.inputEnabled) setInputHint("input active");
  };

  h.blur = () => releaseHeldKeys(s);

  // Magnifier: separate listeners on purpose, never throttled by the input cap
  // and never affecting what is sent.
  h.lensmove = (ev) => {
    if (!magnifierOn || !s.isSelected) return;
    lensPointer = { x: ev.clientX, y: ev.clientY };
    if (ui.lens) ui.lens.hidden = false;
    scheduleLens();
  };
  h.mouseleave = () => {
    lensPointer = null;
    if (ui.lens) ui.lens.hidden = true;
  };

  canvas.addEventListener("mousemove", h.mousemove);
  canvas.addEventListener("mousedown", h.mousedown);
  canvas.addEventListener("wheel", h.wheel, { passive: false });
  canvas.addEventListener("contextmenu", h.contextmenu);
  canvas.addEventListener("dblclick", h.dblclick);
  canvas.addEventListener("keydown", h.keydown);
  canvas.addEventListener("keyup", h.keyup);
  canvas.addEventListener("focus", h.focus);
  canvas.addEventListener("blur", h.blur);
  canvas.addEventListener("mousemove", h.lensmove);
  canvas.addEventListener("mouseleave", h.mouseleave);
  s.canvasHandlers = h;
}

/** Remove every listener `wireCanvasInput` added — the idle tile's canvas outlives its session. */
function unwireCanvasInput(s) {
  const canvas = s.canvas;
  const h = s.canvasHandlers;
  if (!canvas || !h) return;
  canvas.removeEventListener("mousemove", h.mousemove);
  canvas.removeEventListener("mousedown", h.mousedown);
  canvas.removeEventListener("wheel", h.wheel);
  canvas.removeEventListener("contextmenu", h.contextmenu);
  canvas.removeEventListener("dblclick", h.dblclick);
  canvas.removeEventListener("keydown", h.keydown);
  canvas.removeEventListener("keyup", h.keyup);
  canvas.removeEventListener("focus", h.focus);
  canvas.removeEventListener("blur", h.blur);
  canvas.removeEventListener("mousemove", h.lensmove);
  canvas.removeEventListener("mouseleave", h.mouseleave);
  s.canvasHandlers = null;
}

// On window, not the canvas: a drag released outside the canvas must still send
// the button up — to the session the drag started in, and only if it started on
// a canvas (clicks on the console's own buttons must never reach a machine).
window.addEventListener("mouseup", (ev) => {
  const s = dragSession;
  if (!s || !s.inputEnabled) return;
  dragSession = null;
  s.heldButtons.delete(ev.button);
  if (s.canvas) sendInput(s, { kind: "mouse", ...toRemotePixels(s.canvas, ev), action: "up", button: ev.button });
});

window.addEventListener("blur", () => {
  const s = sel();
  if (s) releaseHeldKeys(s);
});

function releaseHeldKeys(s) {
  for (const code of s.heldKeys) sendInput(s, { kind: "key", code, action: "up" });
  s.heldKeys.clear();
  if (s.isSelected && s.inputEnabled) setInputHint("click the screen to send input");
}

/**
 * PLAN 4.3: keys the browser swallows before the page sees them. Sent as an
 * explicit chord to the SELECTED session only.
 */
for (const button of document.querySelectorAll("#special-keys button[data-keys]")) {
  button.addEventListener("click", () => {
    const s = sel();
    if (!s) return;
    const codes = button.dataset.keys.split("+");
    for (const code of codes) sendInput(s, { kind: "key", code, action: "down" });
    for (const code of [...codes].reverse()) sendInput(s, { kind: "key", code, action: "up" });
    s.canvas?.focus();
  });
}

/* =====================================================================
   SCRIPT EXECUTION (PLAN 6.2) — per session
   ===================================================================== */

function runScript() {
  const s = sel();
  const script = ui.script.value;
  if (!s || script.trim() === "" || s.runningExec !== null) return;
  // Same gate as remote input: a held session must not be able to run a script.
  if (!remoteActionsAllowed(s)) return;

  const id = `x${Date.now().toString(36)}`;
  s.runningExec = id;
  ui.runScript.disabled = true;
  ui.scriptOutput.textContent = "";
  appendOutput(s, `> running…\n`);

  s.send({
    t: "agent.exec",
    id,
    shell: ui.shell.value,
    script,
    asSystem: ui.asSystem.checked,
  });

  addHistory(s, script, ui.shell.value, ui.asSystem.checked);
}

/**
 * `partial: true` chunks stream in while the script runs; exactly one non-partial
 * result closes it out with the real exit code. Lands in the pane of the session
 * that ran it, selected or not.
 */
function onExecResult(s, msg) {
  if (msg.stdout) appendOutput(s, msg.stdout);
  if (msg.stderr) appendOutput(s, msg.stderr);

  if (msg.partial === true) return;

  const ok = msg.exitCode === 0;
  const line = document.createElement("span");
  line.className = ok ? "exit-ok" : "exit-bad";
  line.textContent = `\n[exit code ${msg.exitCode}]\n`;
  target(s, "scriptOutput").appendChild(line);
  if (s.isSelected) ui.scriptOutput.scrollTop = ui.scriptOutput.scrollHeight;

  if (msg.id === s.runningExec) {
    s.runningExec = null;
    if (s.isSelected) ui.runScript.disabled = false;
  }
  if (!s.isSelected) toast(s, `${s.label}: script finished (exit code ${msg.exitCode})`);
}

function appendOutput(s, text) {
  target(s, "scriptOutput").appendChild(document.createTextNode(text));
  if (s.isSelected) ui.scriptOutput.scrollTop = ui.scriptOutput.scrollHeight;
}

function addHistory(s, script, shell, asSystem) {
  const item = document.createElement("li");
  const label = document.createElement("code");
  // textContent, never innerHTML: the script is arbitrary text.
  label.textContent = script.length > 90 ? `${script.slice(0, 90)}…` : script;
  item.append(
    document.createTextNode(`${new Date().toLocaleTimeString()} · ${shell}${asSystem ? " · SYSTEM" : ""} `),
    label,
  );
  target(s, "scriptHistory").appendChild(item);
  s.execHistory += 1;
  if (s.isSelected) renderScriptHistoryMeta(s);
}

function renderScriptHistoryMeta(s) {
  ui.scriptHistoryCount.textContent = String(s?.execHistory ?? 0);
  ui.scriptHistoryBlock.hidden = !s || s.execHistory === 0;
  ui.runScript.disabled = !!s && s.runningExec !== null;
}

ui.runScript.addEventListener("click", runScript);

// Ctrl+Enter runs, so the agent does not have to reach for the mouse mid-call.
ui.script.addEventListener("keydown", (ev) => {
  if (ev.key === "Enter" && (ev.ctrlKey || ev.metaKey)) {
    ev.preventDefault();
    runScript();
  }
});

/* =====================================================================
   SESSION CODE CARD
   ===================================================================== */

function renderCode(s) {
  const code = s?.state === "waiting" ? s.code : null;
  if (code) {
    ui.code.textContent = code;
    // location.origin is already https://<name>.duckdns.org in a deployment, so
    // this is the exact link to read out or paste (PLAN 1.5).
    ui.joinUrl.textContent = `${location.origin}/j/${code}`;
  }
  ui.codeBlock.hidden = !code;
  const shown = s?.code ?? null;
  if (ui.headerCode) { ui.headerCode.textContent = shown ? `Session ${shown}` : ""; ui.headerCode.hidden = !shown; }
  if (ui.leftCode) ui.leftCode.textContent = shown ?? (s?.sessionId ? s.sessionId.slice(0, 8) : "—");
  if (ui.viewportCode) ui.viewportCode.textContent = s ? (shown ? `Session ${shown}` : s.label) : "";
}

/* =====================================================================
   ELEVATION (PLAN 5.2) — per session
   ===================================================================== */

/** Show/hide the credential inputs with the elevation mode radios (PLAN 1.4). */
for (const radio of document.querySelectorAll('input[name="elev-mode"]')) {
  radio.addEventListener("change", (e) => {
    ui.credFields.hidden = e.target.value !== "credential";
  });
}

function elevationMode() {
  return document.querySelector('input[name="elev-mode"]:checked')?.value ?? "interactive";
}

function clearCredentialFields() {
  ui.elevDomain.value = "";
  ui.elevUsername.value = "";
  ui.elevPassword.value = "";
}

/**
 * PLAN 5.2c rule 4, console side: the password lives in the input and in one
 * message object, and in neither for longer than this function. It is never put
 * in localStorage or sessionStorage, never logged, and never kept for a retry.
 * It goes ONLY to the selected session, and is cleared on any session switch.
 */
function requestElevation() {
  const s = sel();
  if (!s || !remoteActionsAllowed(s) || s.elevated) return;

  const mode = elevationMode();
  s.elevPending = true;
  ui.elevate.disabled = true;

  if (mode === "interactive") {
    // The prompt appears on the USER's screen, and only they can answer it (PLAN 5.2a).
    s.elevStatus = "Ask the user to approve the Windows prompt on their screen.";
    ui.elevStatus.textContent = s.elevStatus;
    s.send({ t: "agent.requestElevation", mode: "interactive" });
    logEvent(s, "Elevation requested");
    return;
  }

  const username = ui.elevUsername.value.trim();
  if (username === "") {
    s.elevStatus = "Enter the admin username.";
    ui.elevStatus.textContent = s.elevStatus;
    s.elevPending = false;
    ui.elevate.disabled = false;
    return;
  }

  s.elevStatus = "Elevating…";
  ui.elevStatus.textContent = s.elevStatus;
  s.send({
    t: "agent.requestElevation",
    mode: "credential",
    domain: ui.elevDomain.value.trim(),
    username,
    password: ui.elevPassword.value,
  });
  logEvent(s, "Elevation requested");

  // Cleared the instant it is sent: nothing on this page should still hold an
  // admin password once the frame is on the wire.
  ui.elevPassword.value = "";
}

function onElevated(s, msg) {
  s.elevPending = false;
  if (msg.ok === true) {
    s.elevated = true;
    s.elevStatus = "Elevated — UAC prompts are now visible.";
    logEvent(s, "Elevated");
    if (!s.isSelected) toast(s, `${s.label}: elevated`);
    return;
  }
  // `error` is a message the applet already mapped from a Win32 code; it never
  // carries a credential (PLAN 5.2c rule 2).
  s.elevStatus = msg.error ?? "Elevation failed.";
  if (!s.isSelected) toast(s, `${s.label}: elevation failed`);
}

function renderElevation(s) {
  const elevated = !!s?.elevated;
  ui.elevStatus.textContent = s?.elevStatus ?? "";
  if (ui.elevState) {
    ui.elevState.textContent = elevated ? "Elevated" : "Standard session";
    ui.elevState.dataset.state = elevated ? "elevated" : "";
  }
  if (ui.statusbarElevated) ui.statusbarElevated.hidden = !elevated;
  ui.sendSas.title = elevated ? "Send Ctrl+Alt+Del through the elevated service" : "Requires elevation (Phase 5)";
  ui.elevate.disabled = !!s?.elevPending;
}

ui.elevate.addEventListener("click", requestElevation);

/**
 * Ctrl+Alt+Del. Not a chord of key events — the elevated service calls SendSAS()
 * (PLAN 4.3). Selected session only.
 */
ui.sendSas.addEventListener("click", () => {
  const s = sel();
  if (!s || !remoteActionsAllowed(s) || !s.elevated) return;
  s.send({ t: "agent.input", kind: "sas", action: "press" });
  logEvent(s, "Ctrl+Alt+Del sent");
  s.canvas?.focus();
});

/**
 * Copy-to-clipboard for the session code and the join link. Only the label
 * <span> changes; the original wording is restored afterwards.
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
ui.endSession.addEventListener("click", () => endSession(sel()));

/* =====================================================================
   SESSION EVENTS, PANELS (presentational)
   ===================================================================== */

/**
 * Appends a timestamped entry to THIS session's event log and History timeline
 * — one real, client-observed event feed per session, never mixed.
 */
function logEvent(s, text) {
  appendEventTo(target(s, "sessionEvents"), text);
  appendEventTo(target(s, "notesHistory"), text);
}

function appendEventTo(list, text) {
  if (!list) return;
  const empty = list.querySelector(".event-empty");
  if (empty) empty.remove();
  const li = document.createElement("li");
  const time = document.createElement("time");
  time.textContent = new Date().toLocaleTimeString();
  li.append(document.createTextNode(text), time);
  list.appendChild(li);
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

const narrowForLeft = window.matchMedia("(max-width: 1279px)");
const narrowForRight = window.matchMedia("(max-width: 1099px)");
function applyResponsivePanels() {
  setPanelCollapsed(ui.leftPanel, ui.leftPanelToggle, narrowForLeft.matches);
  setPanelCollapsed(ui.rightPanel, ui.rightPanelToggle, narrowForRight.matches);
}
narrowForLeft.addEventListener("change", applyResponsivePanels);
narrowForRight.addEventListener("change", applyResponsivePanels);
applyResponsivePanels();

/* =====================================================================
   CHROME — everything the shared DOM shows, from the selected session
   ===================================================================== */

/**
 * Every enable/disable decision in one place, derived from the SELECTED
 * session's state and hold flag.
 *
 *   IDLE/WAITING  New Session on (under the limit); Hold, Resume, End, view aids off
 *   CONNECTED     Hold, End, view aids on; Resume off
 *   HELD          Resume, End, view aids on; Hold, scripts, elevation off
 *   RECONNECTING  End on; everything that acts on the machine off
 */
function renderChrome() {
  const s = sel();
  const phase = s?.phase ?? "none";
  document.body.dataset.session = phase;
  document.body.dataset.hold = s?.held ? "on" : "";
  document.body.dataset.layout = manager.layout;

  if (s) setStatus(s.statusText, s.statusState);

  const live = phase === "live";
  const connected = live && s.state === "connected";
  const canAct = connected && !s.held;

  ui.endSession.disabled = !s;
  if (ui.holdSession) ui.holdSession.disabled = !canAct;
  if (ui.resumeSession) ui.resumeSession.disabled = !connected || !s.held;

  // Observation is always allowed, so the view aids follow "is there a picture".
  const tabsLayout = manager.layout === "tabs";
  if (ui.toggleFullscreen) ui.toggleFullscreen.disabled = !live;
  if (ui.zoom) ui.zoom.disabled = !live || !tabsLayout;
  if (ui.magnifier) ui.magnifier.disabled = !live || !tabsLayout;

  // Anything that changes the customer's machine follows canAct.
  ui.scripting.disabled = !canAct;
  ui.elevation.disabled = !canAct || !!s?.elevated;
  ui.specialKeys.disabled = !canAct || !s?.inputEnabled;
  if (ui.sendSas) ui.sendSas.disabled = !canAct || !s?.elevated;

  if (ui.holdBanner) ui.holdBanner.hidden = !s?.held;
  if (ui.statusbarHold) ui.statusbarHold.hidden = !s?.held;
  ui.uacBanner.hidden = !(s && s.desktop === "Winlogon" && s.isLive);

  if (!s || !s.inputEnabled || !canAct) setInputHint("click the screen to send input");
  else if (document.activeElement === s.canvas) setInputHint("input active");

  // Host / code / elevation / scripts / stats.
  ui.hostInfo.textContent = s?.host ? `${s.host.machine} · ${s.host.user} · ${s.host.os}` : "";
  if (ui.leftHost) ui.leftHost.textContent = ui.hostInfo.textContent || "—";
  if (ui.sessionHostRow) ui.sessionHostRow.hidden = !s?.host;
  renderCode(s);
  renderElevation(s);
  renderScriptHistoryMeta(s);
  if (s && live) {
    ui.fps.textContent = s.fpsText;
    ui.kbps.textContent = s.kbpsText;
    if (ui.statusbarResolution) ui.statusbarResolution.textContent = s.resolution;
  } else {
    resetSharedStats();
  }
  renderDuration();

  // New Session: allowed while under the limit; the relay stays the authority.
  const atLimit = liveSessions().length >= manager.maxSessions;
  setStartEnabled(!atLimit);

  setChatUnreadBadge(s?.unread ?? 0);
  updateChatAvailability();
  for (const x of manager.sessions) renderTab(x);
  renderSummary();
  if (isInfoTabOpen()) renderInfo();
}

/* =====================================================================
   SESSION STRIP: tabs, summary, layout, disconnect all
   ===================================================================== */

function buildTab(s) {
  const tab = document.createElement("div");
  tab.className = "session-tab";
  tab.setAttribute("role", "tab");
  tab.tabIndex = 0;
  tab.dataset.key = String(s.key);
  tab.innerHTML =
    '<span class="st-dot" aria-hidden="true"></span>' +
    '<span class="st-main"><span class="st-name"></span>' +
    '<span class="st-sub"><span class="st-state"></span><span class="st-time"></span></span></span>' +
    '<span class="st-quality" aria-hidden="true"><i></i><i></i><i></i></span>' +
    '<span class="st-badge" hidden></span>' +
    '<button type="button" class="st-close"></button>';
  tab.addEventListener("click", (ev) => {
    if (ev.target.closest(".st-close")) return;
    select(s);
  });
  tab.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" || ev.key === " ") {
      ev.preventDefault();
      select(s);
    }
  });
  tab.querySelector(".st-close").addEventListener("click", (ev) => {
    ev.stopPropagation();
    endSession(s);
  });
  ui.sessionTabs?.appendChild(tab);
  s.tabEl = tab;
  renderTab(s);
}

/** Stream liveness from the last frame's age: preview sessions get a keyframe every ≤5 s. */
function quality(s) {
  if (s.phase !== "live" || s.state !== "connected") return 0;
  const age = Date.now() - s.lastFrameAt;
  if (s.lastFrameAt === 0) return 1;
  if (age < 2500) return 3;
  if (age < 8000) return 2;
  return 1;
}

function renderTab(s) {
  const tab = s.tabEl;
  if (!tab) return;
  const state = s.state === "connected" && s.held ? "held" : s.state;
  tab.dataset.state = state;
  tab.setAttribute("aria-selected", String(s.isSelected));
  tab.classList.toggle("is-selected", s.isSelected);
  const name = s.label;
  tab.querySelector(".st-name").textContent = name;
  const stateText = state === "held" ? "On hold" : STATE_LABEL[s.state] ?? s.state;
  tab.querySelector(".st-state").textContent = stateText;
  const dur = durationText(s);
  tab.querySelector(".st-time").textContent = dur ? ` · ${dur}` : "";
  const q = quality(s);
  const qEl = tab.querySelector(".st-quality");
  qEl.dataset.level = String(q);
  qEl.hidden = s.phase !== "live";
  const badge = tab.querySelector(".st-badge");
  badge.textContent = String(s.unread);
  badge.hidden = s.unread === 0 || (s.isSelected && isChatTabOpen());
  badge.title = `${s.unread} unread message${s.unread === 1 ? "" : "s"}`;
  const close = tab.querySelector(".st-close");
  close.title = `Disconnect ${name}`;
  close.setAttribute("aria-label", `Disconnect ${name}`);
  close.textContent = "×";
  tab.title = [
    name,
    s.sessionId ? `Session ${s.sessionId}` : null,
    stateText,
    s.phase === "live" ? `${s.fpsText} · ${s.kbpsText}` : null,
    s.elevated ? "Elevated" : null,
  ].filter(Boolean).join(" — ");

  // The grid tile's label mirrors the tab.
  if (s.tile) {
    s.tile.dataset.state = state;
    const tn = s.tile.querySelector(".tile-name");
    const ts = s.tile.querySelector(".tile-state");
    if (tn) tn.textContent = name;
    if (ts) ts.textContent = dur && s.state === "connected" ? `${stateText} · ${dur}` : stateText;
  }
}

function renderSummary() {
  const live = liveSessions();
  const connected = live.filter((s) => s.state === "connected").length;
  const reconnecting = live.filter((s) => s.state === "reconnecting").length;
  const pending = live.length - connected - reconnecting;
  const available = Math.max(0, manager.maxSessions - live.length);
  const signature = `${live.length}/${manager.maxSessions}/${connected}/${reconnecting}/${pending}`;
  if (ui.sessionSummary && ui.sessionSummary.dataset.sig !== signature) {
    ui.sessionSummary.dataset.sig = signature;
    ui.sessionSummary.dataset.full = String(available === 0);
    ui.sessionSummary.innerHTML = "";
    const main = document.createElement("strong");
    main.className = "sum-main";
    main.textContent = `Active Sessions: ${live.length} / ${manager.maxSessions}`;
    ui.sessionSummary.appendChild(main);
    const parts = [
      ["Connected", connected, "connected"],
      ["Reconnecting", reconnecting, "reconnecting"],
      ["Waiting", pending, "waiting"],
      ["Available", available, "available"],
    ];
    for (const [label, n, key] of parts) {
      if (n === 0 && key !== "available" && key !== "connected") continue;
      const span = document.createElement("span");
      span.className = `sum-part sum-${key}`;
      span.textContent = `${label} ${n}`;
      ui.sessionSummary.appendChild(span);
    }
  }
  if (ui.disconnectAll) ui.disconnectAll.disabled = live.length === 0;
  if (ui.addSession) {
    ui.addSession.disabled = available === 0;
    ui.addSession.title = available === 0
      ? `Session limit reached (${manager.maxSessions}). Disconnect a session to start another.`
      : "Start a new session";
  }
  if (ui.layoutGrid) ui.layoutGrid.disabled = manager.sessions.length < 2;
  document.title = live.length > 0 ? `(${live.length}) Helpdesk Anywhere — Agent Console` : "Helpdesk Anywhere — Agent Console";
}

ui.addSession?.addEventListener("click", startSession);

/* ---- layout: tabs | grid ------------------------------------------------ */

/**
 * Tabs: the selected session fills the viewport. Grid: every open session is a
 * tile, for monitoring — clicking a tile selects it, and only the selected
 * tile (outlined, "Control active") receives input. Grid forces Fit zoom and
 * turns the magnifier off, so no view aid can point somewhere ambiguous.
 */
function setLayout(layout) {
  if (layout === "grid" && manager.sessions.length < 2) layout = "tabs";
  if (manager.layout === layout) return;
  manager.layout = layout;
  if (layout === "grid") {
    if (ui.zoom) ui.zoom.value = "fit";
    applyZoom("fit");
    setMagnifier(false);
  }
  applyLayout();
  renderChrome();
}

function applyLayout() {
  if (manager.sessions.length < 2 && manager.layout === "grid") manager.layout = "tabs";
  const grid = manager.layout === "grid";
  if (ui.canvasWrap) {
    ui.canvasWrap.dataset.layout = manager.layout;
    ui.canvasWrap.dataset.count = String(manager.sessions.length);
  }
  document.body.dataset.layout = manager.layout;
  ui.layoutTabs?.setAttribute("aria-pressed", String(!grid));
  ui.layoutGrid?.setAttribute("aria-pressed", String(grid));
  for (const s of manager.sessions) s.tile?.classList.toggle("is-selected", s.isSelected);
}

ui.layoutTabs?.addEventListener("click", () => setLayout("tabs"));
ui.layoutGrid?.addEventListener("click", () => setLayout("grid"));

/* ---- dialogs: limit, disconnect all ------------------------------------ */

function showLimitModal(count) {
  if (!ui.limitModal) return;
  if (ui.limitText) {
    ui.limitText.textContent =
      `You currently have ${count} active remote-support session${count === 1 ? "" : "s"}. ` +
      `You can manage up to ${manager.maxSessions}. Disconnect one session before starting another.`;
  }
  if (!ui.limitModal.open) ui.limitModal.showModal();
}

ui.limitClose?.addEventListener("click", () => ui.limitModal?.close());
ui.limitView?.addEventListener("click", () => {
  ui.limitModal?.close();
  if (manager.sessions.length >= 2) setLayout("grid");
  ui.sessionTabs?.querySelector(".session-tab.is-selected")?.focus();
});

ui.disconnectAll?.addEventListener("click", () => {
  const n = liveSessions().length;
  if (n === 0 || !ui.disconnectAllModal) return;
  if (ui.disconnectAllText) {
    ui.disconnectAllText.textContent = `This will terminate all ${n} remote-support session${n === 1 ? "" : "s"}.`;
  }
  ui.disconnectAllModal.showModal();
  ui.disconnectAllCancel?.focus();
});
ui.disconnectAllCancel?.addEventListener("click", () => ui.disconnectAllModal?.close());
ui.disconnectAllConfirm?.addEventListener("click", () => {
  ui.disconnectAllModal?.close();
  for (const s of [...manager.sessions]) endSession(s);
});

/* ---- notifications ------------------------------------------------------ */

/**
 * Something happened in a session the technician is not looking at. Clicking
 * the toast selects that session; nothing ever switches on its own, so the
 * machine being controlled never changes under the technician's hands.
 */
function toast(s, text) {
  if (!ui.toasts) return;
  // The same notice again (a second message from the same customer) refreshes
  // the one already shown instead of stacking copies of it.
  for (const existing of ui.toasts.children) {
    if (existing.textContent === text) existing.remove();
  }
  const item = document.createElement(s ? "button" : "div");
  if (s) item.type = "button";
  item.className = "toast";
  item.textContent = text;
  if (s) {
    item.title = "Switch to this session";
    item.addEventListener("click", () => {
      item.remove();
      if (manager.sessions.includes(s)) select(s);
    });
  }
  ui.toasts.appendChild(item);
  while (ui.toasts.children.length > 4) ui.toasts.firstElementChild.remove();
  setTimeout(() => item.remove(), 7000);
}

/* ---- keyboard shortcuts -------------------------------------------------- */

/**
 * Ctrl+Shift+1..4 selects session 1..4. Handled in the CAPTURE phase on the
 * window, so the canvas's own key handler never sees the chord and it is never
 * forwarded to a remote machine. Not Ctrl+1..4: browsers reserve those for
 * their own tab switching, and Ctrl+digit is a real shortcut in Windows apps.
 * The Ctrl and Shift already pressed on the old session are released by
 * `select()` before the switch.
 */
window.addEventListener("keydown", (ev) => {
  if (!ev.ctrlKey || !ev.shiftKey || ev.altKey || ev.metaKey) return;
  const m = /^Digit([1-9])$/.exec(ev.code);
  if (!m) return;
  if (document.querySelector("dialog[open]")) return;
  const s = manager.sessions[Number(m[1]) - 1];
  ev.preventDefault();
  ev.stopImmediatePropagation();
  if (s) select(s);
}, { capture: true });

/* ---- session info panel -------------------------------------------------- */

function isInfoTabOpen() {
  return ui.infoSection ? !ui.infoSection.hidden : false;
}

/**
 * Per-session facts the console actually knows. The customer's IP address is
 * deliberately not here: the relay records it in the session record for
 * administrators, and a technician does not need it to do the job.
 */
function renderInfo() {
  if (!ui.sessionInfo) return;
  const s = sel();
  ui.sessionInfo.replaceChildren();
  if (!s) {
    const p = document.createElement("p");
    p.className = "panel-empty";
    p.textContent = "No session selected.";
    ui.sessionInfo.appendChild(p);
    return;
  }
  const me = window.hdaConsole?.me?.user;
  const rows = [
    ["Session ID", s.sessionId ?? "—"],
    ["Technician", me?.displayName ?? "—"],
    ["Remote user", s.host?.user ?? "—"],
    ["Remote device", s.host?.machine ?? "—"],
    ["Operating system", s.host?.os ?? "—"],
    ["Connection state", s.held && s.state === "connected" ? "On hold" : STATE_LABEL[s.state] ?? s.state],
    ["Session start", new Date(s.createdAt).toLocaleString()],
    ["Duration", durationText(s) ?? "—"],
    ["Connection", `Relayed over ${location.protocol === "https:" ? "WSS (TLS)" : "WS"} via ${location.host}`],
    ["Reconnects", String(s.reconnect.count)],
    ["Elevation / UAC", `${s.elevated ? "Elevated" : "Standard"}${s.desktop === "Winlogon" ? " · UAC prompt active" : ""}`],
    ["Video received", formatBytes(s.bytesIn)],
    ["Frame rate", s.phase === "live" ? `${s.fpsText} (${s.isSelected ? "full" : "preview"})` : "—"],
    ["Chat messages", String(s.chatCount)],
    ["Scripts run", String(s.execHistory)],
    ["File transfers", "Not available yet"],
  ];
  const dl = document.createElement("dl");
  dl.className = "kv info-kv";
  for (const [k, v] of rows) {
    const dt = document.createElement("dt");
    dt.textContent = k;
    const dd = document.createElement("dd");
    dd.textContent = v;
    dl.append(dt, dd);
  }
  ui.sessionInfo.appendChild(dl);
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/* ---- resume after reload (sessionStorage) ------------------------------- */

/**
 * The resume token of each open session is kept in THIS tab's sessionStorage
 * so a page reload can pick the sessions back up. sessionStorage is per tab and
 * dies with it; the token is useless without this technician's own sign-in
 * (the relay checks ownership), rotates on every resume, and dies with the
 * session. Credentials are never stored here or anywhere.
 */
function loadStored() {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list.filter((e) => typeof e?.sessionId === "string" && typeof e?.resumeToken === "string") : [];
  } catch {
    return [];
  }
}

function saveStored() {
  try {
    const list = manager.sessions
      .filter((s) => s.sessionId && s.resumeToken && s.isLive)
      .map((s) => ({ sessionId: s.sessionId, resumeToken: s.resumeToken, label: s.label }));
    if (list.length === 0) sessionStorage.removeItem(STORAGE_KEY);
    else sessionStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  } catch {
    // Storage unavailable: reload simply cannot resume; nothing else depends on it.
  }
}

function remember() { saveStored(); }
function forgetStored() { saveStored(); }

function resumeStoredSessions() {
  for (const entry of loadStored().slice(0, manager.maxSessions)) {
    const s = new RemoteSession();
    s.sessionId = entry.sessionId;
    s.resumeToken = entry.resumeToken;
    s.state = "reconnecting";
    s.phase = "pending";
    s.statusText = "Reconnecting…";
    s.reconnect.startedAt = Date.now();
    manager.sessions.push(s);
    attachTile(s);
    buildTab(s);
    if (!sel()) select(s, { focus: false });
    logEvent(s, "Page reloaded — resuming session");
    openSocket(s, { t: "agent.resume", sessionId: s.sessionId, resumeToken: s.resumeToken });
  }
  applyLayout();
  renderChrome();
}

/* =====================================================================
   FEATURE BATCH 1 — fullscreen, zoom, magnifier, hold/resume
   ===================================================================== */

/* ------------------------------------------------------------ hold / resume */

/**
 * Pause or resume remote control of the SELECTED session. Order matters on the
 * way in: keys and mouse buttons still held are released FIRST.
 */
function setHeld(next) {
  const s = sel();
  if (!s || s.held === next || !s.open || s.phase !== "live") return;

  if (next) releaseSessionInput(s, { send: true });

  s.held = next;
  s.send({ t: "agent.hold", held: next });

  s.inputEnabled = !next;
  setSessionStatus(s, next ? "On hold" : "Connected", next ? "waiting" : "active");
  logEvent(s, next ? "Session put on hold" : "Session resumed");
  renderChrome();
  if (!next) s.canvas?.focus();
}

ui.holdSession?.addEventListener("click", () => setHeld(true));
ui.resumeSession?.addEventListener("click", () => setHeld(false));

/* -------------------------------------------------------------------- zoom */

/**
 * Technician-side display scaling, shared by every session's canvas (only one
 * is displayed at a time in the tabs layout; grid always fits).
 */
function applyZoom(value) {
  if (value === "fit") {
    document.body.dataset.zoom = "fit";
    ui.canvasWrap?.style.removeProperty("--zoom-factor");
  } else {
    document.body.dataset.zoom = "fixed";
    ui.canvasWrap?.style.setProperty("--zoom-factor", value);
  }

  if (ui.zoomReadout) {
    const option = ui.zoom?.selectedOptions[0];
    ui.zoomReadout.textContent = option?.textContent ?? "Fit";
  }
  if (magnifierOn) scheduleLens();
}

ui.zoom?.addEventListener("change", () => applyZoom(ui.zoom.value));

/* --------------------------------------------------------------- magnifier */

const LENS_SIZE = 216;
const LENS_POWER = 2;

let magnifierOn = false;
let lensPointer = null;
let lensFrame = 0;

const lensCtx = ui.lens?.getContext("2d", { alpha: false }) ?? null;
if (lensCtx) lensCtx.imageSmoothingEnabled = false;

function scheduleLens() {
  if (!magnifierOn || lensFrame !== 0) return;
  lensFrame = requestAnimationFrame(() => {
    lensFrame = 0;
    drawLens();
  });
}

function drawLens() {
  const canvas = currentCanvas();
  if (!magnifierOn || lensPointer === null || lensCtx === null || !ui.canvasWrap || !canvas) return;

  const rect = canvas.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return;

  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;

  const srcW = (LENS_SIZE * scaleX) / LENS_POWER;
  const srcH = (LENS_SIZE * scaleY) / LENS_POWER;
  const sx = (lensPointer.x - rect.left) * scaleX - srcW / 2;
  const sy = (lensPointer.y - rect.top) * scaleY - srcH / 2;

  lensCtx.fillStyle = "#000";
  lensCtx.fillRect(0, 0, LENS_SIZE, LENS_SIZE);
  lensCtx.drawImage(canvas, sx, sy, srcW, srcH, 0, 0, LENS_SIZE, LENS_SIZE);

  const wrapRect = ui.canvasWrap.getBoundingClientRect();
  const left = lensPointer.x - wrapRect.left + ui.canvasWrap.scrollLeft - LENS_SIZE / 2;
  const top = lensPointer.y - wrapRect.top + ui.canvasWrap.scrollTop - LENS_SIZE / 2;
  const maxLeft = ui.canvasWrap.scrollLeft + wrapRect.width - LENS_SIZE;
  const maxTop = ui.canvasWrap.scrollTop + wrapRect.height - LENS_SIZE;

  ui.lens.style.left = `${Math.max(ui.canvasWrap.scrollLeft, Math.min(maxLeft, left))}px`;
  ui.lens.style.top = `${Math.max(ui.canvasWrap.scrollTop, Math.min(maxTop, top))}px`;
}

function setMagnifier(on) {
  magnifierOn = on;
  if (!on) {
    lensPointer = null;
    if (lensFrame !== 0) {
      cancelAnimationFrame(lensFrame);
      lensFrame = 0;
    }
  }
  if (ui.lens) ui.lens.hidden = !on || lensPointer === null;
  if (ui.magnifier) {
    ui.magnifier.setAttribute("aria-pressed", String(on));
    const label = on ? "Disable Magnifier" : "Enable Magnifier";
    ui.magnifier.title = label;
    ui.magnifier.setAttribute("aria-label", label);
  }
}

ui.magnifier?.addEventListener("click", () => {
  setMagnifier(!magnifierOn);
  if (document.body.dataset.session === "live") currentCanvas()?.focus();
});

/* -------------------------------------------------------------- fullscreen */

const viewportEl = document.getElementById("screen");

function isFullscreen() {
  return document.fullscreenElement === viewportEl;
}

function applyFullscreenState() {
  const on = isFullscreen();
  if (ui.toggleFullscreen) {
    ui.toggleFullscreen.classList.toggle("active", on);
    const label = on ? "Exit Fullscreen" : "Enter Fullscreen";
    ui.toggleFullscreen.title = label;
    ui.toggleFullscreen.setAttribute("aria-label", label);
    ui.toggleFullscreen.setAttribute("aria-pressed", String(on));
  }
  if (magnifierOn) scheduleLens();
}

async function toggleFullscreen() {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else if (viewportEl) await viewportEl.requestFullscreen();
  } catch {
    // The browser can refuse; the UI simply stays as it was, which is the truth.
  }
  applyFullscreenState();
}

ui.toggleFullscreen?.addEventListener("click", toggleFullscreen);
ui.exitFullscreen?.addEventListener("click", toggleFullscreen);
document.addEventListener("fullscreenchange", applyFullscreenState);

/**
 * New Session has three buttons — the toolbar's, the strip's "+" and the one on
 * the idle screen — and exactly one code path behind them.
 */
function setStartEnabled(enabled) {
  ui.startSession.disabled = !enabled;
  ui.startSession.title = enabled
    ? "Create a new support session"
    : `Session limit reached (${manager.maxSessions}). Disconnect a session to start another.`;
  if (ui.idleNewSession) ui.idleNewSession.disabled = !enabled;
}

ui.idleNewSession?.addEventListener("click", startSession);

/* ---- right-panel tabs (Tools / Scripts / Chat / Notes / Info) ------------ */

const tabs = [...document.querySelectorAll(".panel-tab")];

function selectTab(name) {
  for (const tab of tabs) {
    const active = tab.dataset.tab === name;
    tab.setAttribute("aria-selected", String(active));
    const panel = document.getElementById(tab.getAttribute("aria-controls"));
    if (panel) panel.hidden = !active;
  }
  // Opening Chat is what "reads" the SELECTED session's chat.
  if (name === "chat" && sel()) {
    sel().unread = 0;
    setChatUnreadBadge(0);
    renderTab(sel());
  }
  if (name === "info") renderInfo();
}

for (const tab of tabs) {
  tab.addEventListener("click", () => selectTab(tab.dataset.tab));
}

if (ui.toolbarScripts && ui.scriptsSection) {
  ui.toolbarScripts.addEventListener("click", () => {
    setPanelCollapsed(ui.rightPanel, ui.rightPanelToggle, false);
    selectTab("scripts");
    ui.scriptsSection.scrollIntoView({ behavior: "smooth", block: "nearest" });
    ui.script.focus();
  });
}

/* ---- toolbar "More" overflow ---------------------------------------------- */

function setMoreOpen(open) {
  if (!ui.toolbarMoreWrap || !ui.toolbarMore) return;
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

/* =====================================================================
   FEATURE BATCH 2 — chat, Send URL, predefined replies, history & notes
   =====================================================================
 *
 * Per session: each session has its own transcript (parked while unselected),
 * pending/failed bubble maps, unread count and composer draft. Chat is
 * deliberately NOT gated by Hold (`shared/protocol.md` "agent.chat").
 */

let chatClientSeq = 0;
function nextClientId() {
  return `c${Date.now().toString(36)}${(chatClientSeq++).toString(36)}`;
}

/** Chat/Notes availability follows `live`, independent of Hold. */
function chatAllowed(s = sel()) {
  return !!s && s.phase === "live" && s.state === "connected" && s.open;
}

function isNearChatBottom() {
  if (!ui.chatLog) return true;
  return ui.chatLog.scrollHeight - ui.chatLog.scrollTop - ui.chatLog.clientHeight < 48;
}

function setChatConnection(state, label) {
  if (!ui.chatConnection) return;
  ui.chatConnection.dataset.state = state;
  ui.chatConnection.textContent = label;
}

function updateChatAvailability() {
  const s = sel();
  const allowed = chatAllowed(s);
  const liveOrHeld = s?.phase === "live";
  if (ui.chatInput) ui.chatInput.disabled = !allowed;
  if (ui.chatSend) ui.chatSend.disabled = !allowed;
  if (ui.quickReplySelect) ui.quickReplySelect.disabled = !allowed;
  if (ui.sessionNotes) ui.sessionNotes.disabled = !liveOrHeld;
  if (ui.saveNotes) ui.saveNotes.disabled = !liveOrHeld;
  const label = allowed ? "Connected" : s?.state === "reconnecting" ? "Reconnecting" : "Unavailable";
  setChatConnection(allowed ? "connected" : "unavailable", label);
}

function setChatUnreadBadge(n) {
  if (!ui.chatUnreadBadge) return;
  ui.chatUnreadBadge.textContent = String(n);
  ui.chatUnreadBadge.hidden = n === 0;
}

function isChatTabOpen() {
  return ui.chatSection ? !ui.chatSection.hidden : false;
}

/**
 * Render one chat bubble into `s`'s transcript. TEXT and LABEL always via
 * `textContent`; a URL only ever as an anchor's href/text, never auto-opened.
 */
function appendChatMessage(s, msg, opts = {}) {
  if (msg.kind !== "text" && msg.kind !== "url") return null;

  const log = target(s, "chatLog");
  const emptyNotice = log.querySelector(".chat-empty");
  if (emptyNotice) emptyNotice.remove();

  const wasNear = s.isSelected ? isNearChatBottom() : true;

  const row = document.createElement("div");
  row.className = `chat-msg chat-msg-${msg.senderRole === "host" ? "host" : "agent"}`;
  if (opts.pending) row.classList.add("chat-msg-pending");
  if (msg.clientId) row.dataset.clientId = msg.clientId;
  if (msg.id) row.dataset.messageId = msg.id;

  if (msg.kind === "url") {
    const card = document.createElement("div");
    card.className = "chat-url-card";
    const kicker = document.createElement("p");
    kicker.className = "chat-url-kicker";
    kicker.textContent = msg.senderRole === "host" ? "Shared a link" : "You shared a link";
    card.appendChild(kicker);
    if (msg.label) {
      const label = document.createElement("p");
      label.className = "chat-url-label";
      label.textContent = msg.label;
      card.appendChild(label);
    }
    const link = document.createElement("a");
    link.className = "chat-url-link";
    link.href = msg.url ?? "#";
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = msg.url ?? "";
    card.appendChild(link);
    row.appendChild(card);
  } else {
    const bubble = document.createElement("div");
    bubble.className = "chat-bubble";
    bubble.textContent = msg.text ?? "";
    row.appendChild(bubble);
  }

  const meta = document.createElement("div");
  meta.className = "chat-meta";
  const time = document.createElement("time");
  time.textContent = new Date(msg.ts ?? Date.now()).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  meta.appendChild(time);
  if (opts.pending) {
    const sending = document.createElement("span");
    sending.textContent = "Sending…";
    meta.appendChild(sending);
  }
  row.appendChild(meta);

  log.appendChild(row);

  if (s.isSelected) {
    if (wasNear || msg.senderRole !== "host") {
      if (ui.chatLog) ui.chatLog.scrollTop = ui.chatLog.scrollHeight;
      if (ui.chatJump) ui.chatJump.hidden = true;
    } else if (ui.chatJump) {
      ui.chatJump.hidden = false;
    }
  } else {
    s.chatScroll = null;  // scroll to the bottom when it is next shown
  }

  if (!s.chatHasStarted) {
    s.chatHasStarted = true;
    logEvent(s, "Chat started");
  }

  return row;
}

function markChatFailed(row, code) {
  if (!row) return;
  row.classList.remove("chat-msg-pending");
  row.classList.add("chat-msg-failed");
  const meta = row.querySelector(".chat-meta");
  if (!meta) return;
  meta.querySelectorAll("span, button").forEach((n) => n.remove());
  const failedLabel = document.createElement("span");
  failedLabel.textContent =
    code === "chat_rate_limited" ? "Not sent — slow down"
      : code === "chat_not_saved" ? "Not saved, so not sent"
        : "Not sent";
  meta.appendChild(failedLabel);
  const retry = document.createElement("button");
  retry.type = "button";
  retry.className = "chat-retry";
  retry.textContent = "Retry";
  retry.addEventListener("click", () => retryChatRow(row));
  meta.appendChild(retry);
}

/** Retry goes to the session that owns the bubble — which is the selected one, since only it is on screen. */
function retryChatRow(row) {
  const s = sel();
  const clientId = row.dataset.clientId;
  const payload = clientId ? s?.failedChatPayloads.get(clientId) : undefined;
  if (!s || !payload || !chatAllowed(s)) return;

  row.classList.remove("chat-msg-failed");
  row.classList.add("chat-msg-pending");
  const meta = row.querySelector(".chat-meta");
  meta?.querySelectorAll("span, button").forEach((n) => n.remove());
  const sending = document.createElement("span");
  sending.textContent = "Sending…";
  meta?.appendChild(sending);

  s.pendingChatRows.set(clientId, row);
  s.send(payload);
}

function sendChatPayload(s, payload, row) {
  s.pendingChatRows.set(payload.clientId, row);
  s.failedChatPayloads.set(payload.clientId, payload);
  s.send(payload);
}

/**
 * The server's canonical `chat.message` for session `s` — the echo of our own
 * send (reconciled by `clientId`), an incoming message from the customer, or a
 * replayed one after a resume (de-duplicated by the server-assigned id).
 */
function onChatMessage(s, msg, { replay = false } = {}) {
  if (typeof msg.id === "string") {
    if (s.chatIds.has(msg.id)) return;
    s.chatIds.add(msg.id);
  }

  if (msg.clientId && s.pendingChatRows.has(msg.clientId)) {
    const row = s.pendingChatRows.get(msg.clientId);
    s.pendingChatRows.delete(msg.clientId);
    s.failedChatPayloads.delete(msg.clientId);
    row.classList.remove("chat-msg-pending");
    row.dataset.messageId = msg.id ?? "";
    row.querySelector(".chat-meta")?.querySelectorAll("span, button").forEach((n) => n.remove());
    s.chatCount += 1;
    return;
  }

  appendChatMessage(s, msg);
  s.chatCount += 1;

  if (msg.senderRole === "host" && !replay) {
    if (!(s.isSelected && isChatTabOpen())) {
      s.unread += 1;
      if (s.isSelected) setChatUnreadBadge(s.unread);
    }
    if (!s.isSelected) toast(s, `${s.label}: new message from the customer`);
  }
}

function submitChatText() {
  const s = sel();
  if (!ui.chatInput || !chatAllowed(s)) return;
  const text = ui.chatInput.value;
  if (text.trim() === "") return;

  const clientId = nextClientId();
  const row = appendChatMessage(s, { senderRole: "agent", kind: "text", text, clientId }, { pending: true });
  sendChatPayload(s, { t: "agent.chat", kind: "text", text, clientId }, row);
  ui.chatInput.value = "";
  s.chatDraft = "";
}

ui.chatForm?.addEventListener("submit", (ev) => {
  ev.preventDefault();
  submitChatText();
});

// Enter sends, Shift+Enter is a newline — bound to the composer element itself.
ui.chatInput?.addEventListener("keydown", (ev) => {
  if (ev.key === "Enter" && !ev.shiftKey) {
    ev.preventDefault();
    submitChatText();
  }
});

ui.chatJump?.addEventListener("click", () => {
  if (ui.chatLog) ui.chatLog.scrollTop = ui.chatLog.scrollHeight;
  if (ui.chatJump) ui.chatJump.hidden = true;
});

/* ---- predefined / quick replies (localStorage, §8) --------------------- */

const QUICK_REPLY_STORAGE_KEY = "hda.quickReplies.v1";
const MAX_QUICK_REPLIES = 30;

const DEFAULT_QUICK_REPLIES = [
  "I'm connecting to your computer now.",
  "Please show me the issue.",
  "I may need a few minutes to investigate.",
  "Please try that action again.",
  "The issue appears to be resolved.",
  "Is there anything else I can help you with?",
];

function loadQuickReplies() {
  try {
    const raw = localStorage.getItem(QUICK_REPLY_STORAGE_KEY);
    if (!raw) return [...DEFAULT_QUICK_REPLIES];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [...DEFAULT_QUICK_REPLIES];
    return parsed.filter((s) => typeof s === "string" && s.trim() !== "").slice(0, MAX_QUICK_REPLIES);
  } catch {
    return [...DEFAULT_QUICK_REPLIES];
  }
}

function saveQuickReplies(list) {
  try {
    localStorage.setItem(QUICK_REPLY_STORAGE_KEY, JSON.stringify(list.slice(0, MAX_QUICK_REPLIES)));
  } catch {
    // Private browsing, a full quota, or storage disabled.
  }
}

let quickReplies = loadQuickReplies();
let editingQuickReplyIndex = null;

function renderQuickReplySelect() {
  if (!ui.quickReplySelect) return;
  ui.quickReplySelect.replaceChildren();
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "Quick replies…";
  ui.quickReplySelect.appendChild(placeholder);
  for (const [i, text] of quickReplies.entries()) {
    const opt = document.createElement("option");
    opt.value = String(i);
    opt.textContent = text.length > 60 ? `${text.slice(0, 60)}…` : text;
    ui.quickReplySelect.appendChild(opt);
  }
  ui.quickReplySelect.value = "";
}

function renderQuickReplyEditor() {
  if (!ui.quickReplyList) return;
  ui.quickReplyList.replaceChildren();
  quickReplies.forEach((text, i) => {
    const li = document.createElement("li");
    const span = document.createElement("span");
    span.textContent = text;
    const edit = document.createElement("button");
    edit.type = "button";
    edit.textContent = "Edit";
    edit.addEventListener("click", () => {
      editingQuickReplyIndex = i;
      if (ui.quickReplyAddInput) ui.quickReplyAddInput.value = text;
      const submit = ui.quickReplyAddForm?.querySelector("#quick-reply-add-submit");
      if (submit) submit.textContent = "Save";
      ui.quickReplyAddInput?.focus();
    });
    const del = document.createElement("button");
    del.type = "button";
    del.textContent = "Remove";
    del.addEventListener("click", () => {
      quickReplies.splice(i, 1);
      if (editingQuickReplyIndex === i) resetQuickReplyForm();
      saveQuickReplies(quickReplies);
      renderQuickReplyEditor();
      renderQuickReplySelect();
    });
    li.append(span, edit, del);
    ui.quickReplyList.appendChild(li);
  });
}

function resetQuickReplyForm() {
  editingQuickReplyIndex = null;
  if (ui.quickReplyAddInput) ui.quickReplyAddInput.value = "";
  const submit = ui.quickReplyAddForm?.querySelector("#quick-reply-add-submit");
  if (submit) submit.textContent = "Add";
}

ui.quickReplySelect?.addEventListener("change", () => {
  const idx = Number(ui.quickReplySelect.value);
  if (Number.isNaN(idx) || !quickReplies[idx]) return;
  // Populates the composer for review/edit — deliberately NOT sent automatically.
  if (ui.chatInput) {
    ui.chatInput.value = quickReplies[idx];
    ui.chatInput.focus();
  }
  ui.quickReplySelect.value = "";
});

ui.quickReplyManage?.addEventListener("click", () => {
  if (!ui.quickReplyEditor) return;
  const opening = ui.quickReplyEditor.hidden;
  ui.quickReplyEditor.hidden = !opening;
  if (opening) renderQuickReplyEditor();
  else resetQuickReplyForm();
});

ui.quickReplyEditorClose?.addEventListener("click", () => {
  if (ui.quickReplyEditor) ui.quickReplyEditor.hidden = true;
  resetQuickReplyForm();
});

ui.quickReplyAddForm?.addEventListener("submit", (ev) => {
  ev.preventDefault();
  const text = ui.quickReplyAddInput?.value.trim();
  if (!text) return;

  if (editingQuickReplyIndex !== null) {
    quickReplies[editingQuickReplyIndex] = text;
  } else {
    if (quickReplies.length >= MAX_QUICK_REPLIES) return;
    quickReplies.push(text);
  }
  saveQuickReplies(quickReplies);
  resetQuickReplyForm();
  renderQuickReplyEditor();
  renderQuickReplySelect();
});

renderQuickReplySelect();

/* ---- session notes (technician-private, §9B/§9C), per session ----------- */

ui.saveNotes?.addEventListener("click", () => {
  const s = sel();
  if (!ui.sessionNotes || !s || !s.open) return;
  const body = ui.sessionNotes.value;
  const sessionId = s.sessionId;
  const showHint = (text) => {
    if (!ui.notesSavedHint || !s.isSelected) return;
    ui.notesSavedHint.textContent = text;
    setTimeout(() => { if (ui.notesSavedHint && ui.notesSavedHint.textContent === text) ui.notesSavedHint.textContent = ""; }, 3000);
  };
  // The relay gets the LENGTH (never the text) for the JSONL security log.
  s.send({ t: "agent.notes.save", length: body.length });

  // The text goes over the authenticated HTTPS notes API into THIS session's
  // record — never over the socket the customer's applet shares.
  if (!sessionId || !window.hdaConsole) {
    showHint("Not saved — no session record");
    return;
  }
  ui.saveNotes.disabled = true;
  window.hdaConsole.api(`/api/agent/sessions/${encodeURIComponent(sessionId)}/notes`, { method: "POST", body: { body } })
    .then(() => { showHint("Saved"); logEvent(s, "Notes saved"); })
    .catch(() => showHint("Not saved — try again"))
    .finally(() => { ui.saveNotes.disabled = sel()?.phase !== "live"; });
});

/* ---- toolbar shortcuts: History & Notes, Chat, Predefined Replies ------- */

function openInspectorTab(name, section, focusEl) {
  setPanelCollapsed(ui.rightPanel, ui.rightPanelToggle, false);
  selectTab(name);
  section?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  focusEl?.focus();
}

ui.toolbarChat?.addEventListener("click", () => openInspectorTab("chat", ui.chatSection, ui.chatInput));
ui.toolbarHistory?.addEventListener("click", () => openInspectorTab("notes", ui.notesSection));
ui.toolbarQuickReplies?.addEventListener("click", () => {
  openInspectorTab("chat", ui.chatSection);
  ui.quickReplySelect?.focus();
});

/* ---- Send URL (a specialised chat item, §7) ----------------------------- */

function isAcceptableUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/** The session the open Send URL dialog was opened FOR — fixed at open, never re-read. */
let urlTarget = null;

function openUrlModal() {
  if (!ui.urlModal) return;
  urlTarget = sel();
  if (ui.urlInput) ui.urlInput.value = "";
  if (ui.urlLabelInput) ui.urlLabelInput.value = "";
  if (ui.urlError) ui.urlError.textContent = "";
  ui.urlModal.showModal();
  ui.urlInput?.focus();
}

ui.toolbarSendUrl?.addEventListener("click", openUrlModal);
ui.urlCancel?.addEventListener("click", () => ui.urlModal?.close());

ui.urlForm?.addEventListener("submit", (ev) => {
  ev.preventDefault();
  if (!ui.urlInput) return;

  const url = ui.urlInput.value.trim();
  const label = ui.urlLabelInput?.value.trim() || undefined;

  // Client-side validation is a courtesy; the relay refuses the same thing.
  if (!isAcceptableUrl(url)) {
    if (ui.urlError) ui.urlError.textContent = "Enter a valid http:// or https:// link.";
    return;
  }
  const s = urlTarget;
  if (!s || !manager.sessions.includes(s) || !chatAllowed(s)) {
    if (ui.urlError) ui.urlError.textContent = "No active session to send this to.";
    return;
  }

  const clientId = nextClientId();
  const row = appendChatMessage(s, { senderRole: "agent", kind: "url", url, label, clientId }, { pending: true });
  sendChatPayload(s, { t: "agent.chat", kind: "url", url, clientId, ...(label ? { label } : {}) }, row);

  ui.urlModal?.close();
  if (s.isSelected) openInspectorTab("chat", ui.chatSection);
});

/* =====================================================================
   STARTUP
   ===================================================================== */

applyZoom("fit");
applyFullscreenState();
setMagnifier(false);
applyLayout();
goIdle({ text: "Idle", state: "idle" });

// The limit the relay will hold this technician to; the relay stays the authority.
window.hdaConsole?.ready?.then((me) => {
  const n = me?.user?.maxSessions;
  if (typeof n === "number" && n > 0) manager.maxSessions = n;
  renderChrome();
}).catch(() => { /* identity.js handles sign-in failures itself */ });

resumeStoredSessions();

// Test and diagnostics hook: read-only view of the session list (no sockets, no tokens).
window.hdaSessions = {
  list: () => manager.sessions.map((s) => ({
    key: s.key, sessionId: s.sessionId, state: s.state, selected: s.isSelected, label: s.label,
    unread: s.unread, held: s.held, elevated: s.elevated, reconnects: s.reconnect.count, bytesIn: s.bytesIn,
  })),
  get layout() { return manager.layout; },
  get maxSessions() { return manager.maxSessions; },
};

export { ui, setStatus };
