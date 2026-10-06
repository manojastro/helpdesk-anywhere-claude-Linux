/**
 * Remote file manager and file transfer (Platform 2.0, Phase 2b), console side.
 *
 * One dialog, two halves. Left: THIS computer — browsers cannot list local
 * folders, so it is a drop zone / file picker for uploads, plus the transfer
 * list. Right: the REMOTE computer's folders, browsed through the applet.
 *
 * Everything is per session (`s.files`): the folder shown, the transfers, the
 * pending requests. The dialog always shows the SELECTED session, and every
 * message goes out on that session's own socket.
 *
 * Wire (shared/protocol.md "Phase 2b"): JSON only. Uploads send 48 KiB base64
 * chunks with at most 8 unacknowledged; downloads ack every chunk. Nothing here
 * logs file contents; every string from the remote side is rendered as text.
 */

const el = (id) => document.getElementById(id);
const CHUNK = 48 * 1024;
const WINDOW = 8;
/** Downloads are assembled in browser memory; past this, the browser could struggle. */
export const MAX_DOWNLOAD_BYTES = 256 * 1024 * 1024;
/** Uploads above this skip the end-to-end SHA-256 (it needs the whole file in memory). */
const MAX_HASHED_UPLOAD = 256 * 1024 * 1024;

function fmtBytes(n) {
  if (n == null) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

function b64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function unb64(text) {
  const bin = atob(text);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function sha256Hex(buffer) {
  const d = await crypto.subtle.digest("SHA-256", buffer);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * @param {object} hooks
 * @param {() => any} hooks.selected      the selected RemoteSession or null
 * @param {(s:any, text:string) => void} hooks.log   per-session event log + chat system line
 * @param {(s:any) => {ok:boolean, why?:string}} hooks.allowed  whether files may be used now
 */
export function initFiles(hooks) {
  const modal = el("files-modal");
  const ui = {
    list: el("files-list")?.querySelector("tbody"),
    path: el("files-path"),
    status: el("files-status"),
    transfers: el("files-transfers"),
    machine: el("files-machine"),
    unsupported: el("files-unsupported"),
    input: el("files-input"),
    drop: el("files-drop"),
  };

  function state(s) {
    s.files ??= { cwd: "", parent: null, entries: [], transfers: new Map(), pending: new Map(), seq: 0 };
    return s.files;
  }

  /* ------------------------------------------------------------- requests */

  function request(s, msg, timeoutMs = 20_000) {
    const f = state(s);
    const rid = `r${Date.now().toString(36)}${(f.seq++).toString(36)}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => { f.pending.delete(rid); resolve({ ok: false, error: "The remote computer did not answer." }); }, timeoutMs);
      f.pending.set(rid, (res) => { clearTimeout(timer); resolve(res); });
      if (!s.send({ ...msg, rid })) {
        clearTimeout(timer);
        f.pending.delete(rid);
        resolve({ ok: false, error: "The session is not connected." });
      }
    });
  }

  async function browse(s, path) {
    const f = state(s);
    setStatus("Loading…");
    const res = await request(s, { t: "agent.fs.list", path });
    if (!res.ok) { setStatus(res.error ?? "Could not open that folder.", true); return; }
    f.cwd = res.path ?? "";
    f.parent = res.parent ?? (f.cwd ? "" : null);
    f.entries = Array.isArray(res.entries) ? res.entries : [];
    if (s === hooks.selected()) {
      render(s);
      setStatus(res.truncated ? "This folder has more items than can be shown; only the first 2000 are listed." : "");
    }
  }

  async function change(s, msg, verb) {
    const res = await request(s, msg);
    if (!res.ok) { setStatus(res.error ?? `Could not ${verb}.`, true); return; }
    hooks.log(s, `Remote file ${verb}: ${res.newName ?? (res.path ?? "").split("\\").pop()}`);
    await browse(s, state(s).cwd);
  }

  /* ------------------------------------------------------------ transfers */

  function addTransfer(s, t) {
    state(s).transfers.set(t.tid, t);
    t.startedAt = performance.now();
    renderTransfers(s);
  }

  function finish(s, t, status, message) {
    if (t.status !== "active" && t.status !== "waiting") return;
    t.status = status;
    t.message = message ?? "";
    t.endedAt = performance.now();
    t.resolve?.();
    for (const w of t.waiters ?? []) w();
    hooks.log(s, `${t.direction === "upload" ? "Upload" : "Download"} ${status}: ${t.name}${message && status !== "completed" ? ` — ${message}` : ""}`);
    renderTransfers(s);
  }

  async function upload(s, file) {
    const f = state(s);
    const t = { tid: crypto.randomUUID(), direction: "upload", name: file.name, size: file.size, bytes: 0, status: "waiting", acked: 0, inFlight: 0, waiters: [] };
    addTransfer(s, t);
    const ready = new Promise((resolve) => { t.onReady = resolve; });
    if (!s.send({ t: "agent.file.put", tid: t.tid, name: file.name, size: file.size, dir: f.cwd || "" })) {
      finish(s, t, "failed", "The session is not connected.");
      return;
    }
    const ok = await Promise.race([ready, new Promise((r) => { t.resolve = () => r(false); })]);
    if (!ok || t.status !== "waiting") return;
    t.status = "active";
    renderTransfers(s);

    let seq = 0;
    for (let off = 0; off < file.size && t.status === "active"; off += CHUNK) {
      while (t.inFlight >= WINDOW && t.status === "active") await new Promise((r) => t.waiters.push(r));
      if (t.status !== "active") return;
      const bytes = new Uint8Array(await file.slice(off, off + CHUNK).arrayBuffer());
      t.inFlight += 1;
      if (!s.send({ t: "agent.file.chunk", tid: t.tid, seq: ++seq, data: b64(bytes) })) {
        finish(s, t, "failed", "The session disconnected.");
        return;
      }
      t.bytes += bytes.length;
      if (s === hooks.selected()) renderTransfers(s);
    }
    while (t.inFlight > 0 && t.status === "active") await new Promise((r) => t.waiters.push(r));
    if (t.status !== "active") return;
    const sha256 = file.size <= MAX_HASHED_UPLOAD ? await sha256Hex(await file.arrayBuffer()) : undefined;
    s.send({ t: "agent.file.end", tid: t.tid, ...(sha256 ? { sha256 } : {}) });
  }

  function download(s, entry) {
    const f = state(s);
    const path = `${f.cwd}${f.cwd.endsWith("\\") ? "" : "\\"}${entry.name}`;
    if (entry.size != null && entry.size > MAX_DOWNLOAD_BYTES) {
      setStatus(`${entry.name} is ${fmtBytes(entry.size)}; the browser can download files up to ${fmtBytes(MAX_DOWNLOAD_BYTES)}.`, true);
      return;
    }
    const t = { tid: crypto.randomUUID(), direction: "download", name: entry.name, size: entry.size ?? 0, bytes: 0, status: "waiting", parts: [] };
    addTransfer(s, t);
    if (!s.send({ t: "agent.file.get", tid: t.tid, path })) finish(s, t, "failed", "The session is not connected.");
  }

  function cancel(s, t) {
    if (t.status !== "active" && t.status !== "waiting") return;
    s.send({ t: "agent.file.cancel", tid: t.tid });
    finish(s, t, "cancelled", "Cancelled");
  }

  /** Called for every server message of session `s`; true if it was a file message. */
  function onMessage(s, msg) {
    const f = state(s);
    if (msg.t === "host.fs.result") {
      const done = f.pending.get(msg.rid);
      if (done) { f.pending.delete(msg.rid); done(msg); }
      return true;
    }
    const t = typeof msg.tid === "string" ? f.transfers.get(msg.tid) : undefined;
    switch (msg.t) {
      case "host.file.ready":
        if (t) { t.remotePath = msg.path; t.onReady?.(true); }
        return true;
      case "host.file.ack":
        if (t) { t.inFlight = Math.max(0, t.inFlight - 1); t.acked = msg.seq; t.waiters.splice(0).forEach((w) => w()); }
        return true;
      case "host.file.meta":
        if (t) {
          if (typeof msg.size === "number" && msg.size > MAX_DOWNLOAD_BYTES) {
            s.send({ t: "agent.file.cancel", tid: t.tid });
            finish(s, t, "failed", `Too large to download in the browser (${fmtBytes(msg.size)}).`);
          } else {
            t.size = msg.size;
            t.status = "active";
            renderTransfers(s);
          }
        }
        return true;
      case "host.file.chunk":
        if (t && t.status === "active") {
          const bytes = unb64(msg.data);
          t.parts.push(bytes);
          t.bytes += bytes.length;
          s.send({ t: "agent.file.ack", tid: t.tid, seq: msg.seq });
          if (s === hooks.selected()) renderTransfers(s);
        }
        return true;
      case "host.file.done":
        if (!t) return true;
        if (t.direction === "upload") {
          if (msg.path) t.remotePath = msg.path;
          finish(s, t, "completed", t.remotePath ? `Saved as ${t.remotePath}` : "");
          if (state(s).cwd && s === hooks.selected()) void browse(s, state(s).cwd);
        } else {
          void completeDownload(s, t, msg.sha256);
        }
        return true;
      case "host.file.error":
        if (t) finish(s, t, "failed", String(msg.error ?? "Failed on the remote computer."));
        return true;
      case "error":
        if (t) { finish(s, t, "failed", String(msg.message ?? msg.code)); return true; }
        if (typeof msg.rid === "string" && f.pending.has(msg.rid)) {
          const done = f.pending.get(msg.rid);
          f.pending.delete(msg.rid);
          done({ ok: false, error: String(msg.message ?? msg.code) });
          return true;
        }
        return false;
      default:
        return false;
    }
  }

  async function completeDownload(s, t, expected) {
    const blob = new Blob(t.parts);
    t.parts = [];
    if (expected && blob.size <= MAX_DOWNLOAD_BYTES) {
      const got = await sha256Hex(await blob.arrayBuffer());
      if (got !== String(expected).toLowerCase()) {
        finish(s, t, "failed", "The file did not arrive intact (checksum mismatch).");
        return;
      }
    }
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = t.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 30_000);
    finish(s, t, "completed", "Saved by your browser");
  }

  /** The session ended or its socket was replaced: nothing in flight can finish. */
  function sessionInterrupted(s, why) {
    if (!s.files) return;
    for (const t of s.files.transfers.values()) finish(s, t, "failed", why);
    for (const done of s.files.pending.values()) done({ ok: false, error: why });
    s.files.pending.clear();
  }

  /* ------------------------------------------------------------- rendering */

  function setStatus(text, error = false) {
    if (!ui.status) return;
    ui.status.textContent = text;
    ui.status.classList.toggle("hint-error", error);
  }

  function render(s) {
    const f = state(s);
    if (ui.path) ui.path.value = f.cwd;
    el("files-up").disabled = f.parent === null;
    el("files-mkdir").disabled = !f.cwd;
    if (!ui.list) return;
    ui.list.replaceChildren(...f.entries.map((e) => {
      const tr = document.createElement("tr");
      tr.dataset.type = e.type;
      const name = document.createElement("td");
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "files-name";
      btn.append(icon(e.type === "file" ? "i-file" : e.type === "drive" ? "i-drive" : "i-folder"), document.createTextNode(e.name));
      btn.title = e.type === "file" ? "Download" : "Open";
      btn.addEventListener("click", () => {
        if (e.type === "file") download(s, e);
        else void browse(s, e.path ?? `${f.cwd}${f.cwd.endsWith("\\") ? "" : "\\"}${e.name}`);
      });
      name.appendChild(btn);
      const size = Object.assign(document.createElement("td"), { className: "dash-num", textContent: e.type === "file" ? fmtBytes(e.size) : e.type === "drive" ? fmtBytes(e.size) : "" });
      const mod = Object.assign(document.createElement("td"), { className: "dash-num", textContent: e.modified ? new Date(e.modified).toLocaleString() : "" });
      const act = document.createElement("td");
      act.className = "files-actions";
      if (f.cwd) {
        const full = `${f.cwd}${f.cwd.endsWith("\\") ? "" : "\\"}${e.name}`;
        if (e.type === "file") act.appendChild(actionBtn("Download", () => download(s, e)));
        act.appendChild(actionBtn("Rename", () => {
          const n = prompt(`Rename "${e.name}" to:`, e.name);
          if (n && n !== e.name) void change(s, { t: "agent.fs.rename", path: full, newName: n }, "renamed");
        }));
        act.appendChild(actionBtn("Delete", () => {
          if (confirm(`Delete "${e.name}" on the remote computer?${e.type === "dir" ? " (Only empty folders can be deleted.)" : ""}`)) {
            void change(s, { t: "agent.fs.delete", path: full }, "deleted");
          }
        }, true));
      }
      tr.append(name, size, mod, act);
      return tr;
    }));
    if (f.entries.length === 0) {
      const tr = document.createElement("tr");
      tr.appendChild(Object.assign(document.createElement("td"), { colSpan: 4, className: "dash-empty", textContent: f.cwd ? "This folder is empty." : "Loading…" }));
      ui.list.appendChild(tr);
    }
    renderTransfers(s);
  }

  function icon(id) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "btn-icon");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
    use.setAttribute("href", `#${id}`);
    svg.appendChild(use);
    return svg;
  }

  function actionBtn(label, fn, danger = false) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = `btn btn-sm${danger ? " btn-danger-quiet" : ""}`;
    b.textContent = label;
    b.addEventListener("click", fn);
    return b;
  }

  function renderTransfers(s) {
    if (!ui.transfers || s !== hooks.selected() || !modal?.open) return;
    const items = [...state(s).transfers.values()].reverse();
    if (items.length === 0) {
      ui.transfers.replaceChildren(Object.assign(document.createElement("li"), { className: "dash-empty", textContent: "No transfers yet." }));
      return;
    }
    ui.transfers.replaceChildren(...items.map((t) => {
      const li = document.createElement("li");
      li.className = "files-transfer";
      li.dataset.status = t.status;
      li.dataset.tid = t.tid;
      const head = document.createElement("div");
      head.className = "files-transfer-head";
      head.append(
        Object.assign(document.createElement("span"), { className: "files-transfer-name", textContent: `${t.direction === "upload" ? "↑" : "↓"} ${t.name}` }),
        Object.assign(document.createElement("span"), { className: "files-transfer-pct", textContent: t.size > 0 ? `${Math.floor((t.bytes / t.size) * 100)}%` : t.status === "completed" ? "100%" : "" }),
      );
      const bar = document.createElement("progress");
      bar.max = Math.max(1, t.size);
      bar.value = t.bytes;
      const secs = ((t.endedAt ?? performance.now()) - t.startedAt) / 1000;
      const rate = secs > 0.2 ? `${fmtBytes(Math.round(t.bytes / secs))}/s` : "";
      const meta = Object.assign(document.createElement("span"), {
        className: "files-transfer-meta",
        textContent: t.status === "active" ? `${fmtBytes(t.bytes)} / ${fmtBytes(t.size)}${rate ? ` · ${rate}` : ""}`
          : t.status === "waiting" ? "Starting…"
            : `${t.status[0].toUpperCase()}${t.status.slice(1)}${t.message ? ` — ${t.message}` : ""}`,
      });
      li.append(head, bar, meta);
      if (t.status === "active" || t.status === "waiting") li.appendChild(actionBtn("Cancel", () => cancel(s, t)));
      return li;
    }));
  }

  /* ------------------------------------------------------------- wiring */

  function open() {
    const s = hooks.selected();
    if (!s || !modal) return;
    const allowed = hooks.allowed(s);
    if (ui.machine) ui.machine.textContent = s.host?.machine ? `Remote: ${s.host.machine}` : "";
    ui.unsupported.hidden = allowed.ok;
    ui.unsupported.textContent = allowed.why ?? "";
    for (const id of ["files-up", "files-go", "files-refresh", "files-mkdir", "files-path", "files-input"]) {
      if (el(id)) el(id).disabled = !allowed.ok;
    }
    if (!modal.open) modal.showModal();
    if (!allowed.ok) return;
    render(s);
    void browse(s, state(s).cwd);
  }

  el("files-close")?.addEventListener("click", () => modal?.close());
  el("files-refresh")?.addEventListener("click", () => { const s = hooks.selected(); if (s) void browse(s, state(s).cwd); });
  el("files-up")?.addEventListener("click", () => { const s = hooks.selected(); if (s && state(s).parent !== null) void browse(s, state(s).parent); });
  el("files-go")?.addEventListener("click", () => { const s = hooks.selected(); if (s) void browse(s, ui.path.value.trim()); });
  ui.path?.addEventListener("keydown", (ev) => { if (ev.key === "Enter") { ev.preventDefault(); el("files-go").click(); } });
  el("files-mkdir")?.addEventListener("click", () => {
    const s = hooks.selected();
    if (!s || !state(s).cwd) return;
    const n = prompt("New folder name:");
    if (n) void change(s, { t: "agent.fs.mkdir", path: `${state(s).cwd}${state(s).cwd.endsWith("\\") ? "" : "\\"}${n}` }, "folder created");
  });
  const startUploads = (fileList) => {
    const s = hooks.selected();
    if (!s || !hooks.allowed(s).ok) return;
    for (const file of fileList) void upload(s, file);
  };
  ui.input?.addEventListener("change", () => { startUploads([...ui.input.files]); ui.input.value = ""; });
  ui.drop?.addEventListener("dragover", (ev) => { ev.preventDefault(); ui.drop.classList.add("dragging"); });
  ui.drop?.addEventListener("dragleave", () => ui.drop.classList.remove("dragging"));
  ui.drop?.addEventListener("drop", (ev) => { ev.preventDefault(); ui.drop.classList.remove("dragging"); startUploads([...ev.dataTransfer.files]); });
  // Speed and progress keep moving while the dialog is open.
  setInterval(() => { const s = hooks.selected(); if (s?.files && modal?.open) renderTransfers(s); }, 1000);

  return { open, onMessage, sessionInterrupted, upload: (s, f) => upload(s, f), browse };
}
