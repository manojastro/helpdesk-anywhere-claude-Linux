/**
 * An applet-shaped implementation of the Platform 2.0 Phase 2b protocol, for the
 * Linux suite: file manager, transfers, clipboard, system info, script cancel.
 *
 * It exercises the RELAY and the CONSOLE. It is not the applet: the real one is
 * C# (windows/Applet/Features) and runs only on Windows; its path rules have
 * their own unit test (dotnet/PathPolicyTests) and its structure source/45.
 *
 * "C:\" maps to a temporary directory. Paths are mapped, not policed.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync, appendFileSync } from "node:fs";
import path from "node:path";

export const CAPS = ["files", "clipboard", "sysinfo", "execCancel"];

export function attachFeatures(host, root, { window = 8, chunk = 48 * 1024 } = {}) {
  const state = { clipboard: "", uploads: new Map(), downloads: new Map(), running: new Map(), log: [] };
  const send = (m) => host.send(JSON.stringify(m));
  const local = (p) => {
    if (typeof p !== "string" || !/^[A-Za-z]:\\/.test(p)) return null;
    return path.join(root, ...p.slice(3).split("\\").filter(Boolean));
  };

  host.on("message", (data, isBinary) => {
    if (isBinary) return;
    let m;
    try { m = JSON.parse(data.toString()); } catch { return; }
    state.log.push(m.t);
    try { handle(m); } catch (e) { state.log.push(`error:${e.message}`); }
  });

  function handle(m) {
    switch (m.t) {
      case "agent.fs.list": {
        if (m.path === "") {
          send({ t: "host.fs.result", rid: m.rid, op: "list", ok: true, path: "", entries: [
            { name: "Documents", type: "dir", path: "C:\\Documents" },
            { name: "Local Disk (C:)", type: "drive", path: "C:\\", size: 500e9 },
          ] });
          return;
        }
        const dir = local(m.path);
        if (!dir || !existsSync(dir)) { send({ t: "host.fs.result", rid: m.rid, op: "list", ok: false, path: m.path, error: "That folder does not exist." }); return; }
        const entries = readdirSync(dir).filter((n) => !n.endsWith(".hdapart")).map((n) => {
          const st = statSync(path.join(dir, n));
          return st.isDirectory() ? { name: n, type: "dir", modified: Math.floor(st.mtimeMs) } : { name: n, type: "file", size: st.size, modified: Math.floor(st.mtimeMs) };
        }).sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));
        const canon = m.path.replace(/\\$/, "") || "C:\\";
        const parent = canon.length <= 3 ? "" : canon.slice(0, canon.lastIndexOf("\\")) || "C:\\";
        send({ t: "host.fs.result", rid: m.rid, op: "list", ok: true, path: canon.length === 2 ? "C:\\" : canon, parent: parent.length === 2 ? "C:\\" : parent, entries });
        return;
      }
      case "agent.fs.mkdir": {
        const p = local(m.path);
        if (!p || existsSync(p)) { send({ t: "host.fs.result", rid: m.rid, op: "mkdir", ok: false, path: m.path, error: "Something with that name already exists." }); return; }
        mkdirSync(p);
        send({ t: "host.fs.result", rid: m.rid, op: "mkdir", ok: true, path: m.path });
        return;
      }
      case "agent.fs.rename": {
        const p = local(m.path);
        const to = p && path.join(path.dirname(p), m.newName);
        if (!p || !existsSync(p) || existsSync(to)) { send({ t: "host.fs.result", rid: m.rid, op: "rename", ok: false, path: m.path, error: "Cannot rename." }); return; }
        renameSync(p, to);
        send({ t: "host.fs.result", rid: m.rid, op: "rename", ok: true, path: m.path, newName: m.newName });
        return;
      }
      case "agent.fs.delete": {
        const p = local(m.path);
        if (!p || !existsSync(p)) { send({ t: "host.fs.result", rid: m.rid, op: "delete", ok: false, path: m.path, error: "That item no longer exists." }); return; }
        if (statSync(p).isDirectory()) {
          if (readdirSync(p).length > 0) { send({ t: "host.fs.result", rid: m.rid, op: "delete", ok: false, path: m.path, error: "Only empty folders can be deleted." }); return; }
          rmdirSync(p);
        } else unlinkSync(p);
        send({ t: "host.fs.result", rid: m.rid, op: "delete", ok: true, path: m.path });
        return;
      }

      case "agent.file.put": {
        const dirWin = m.dir || "C:\\Users\\customer\\Downloads\\Helpdesk Anywhere";
        const dir = local(dirWin);
        mkdirSync(dir, { recursive: true });
        let name = m.name, i = 0;
        while (existsSync(path.join(dir, name))) name = m.name.replace(/(\.[^.]*)?$/, (ext) => ` (${++i})${ext ?? ""}`);
        const final = path.join(dir, name);
        writeFileSync(`${final}.hdapart`, "");
        state.uploads.set(m.tid, { final, winPath: `${dirWin}\\${name}`, size: m.size, bytes: 0, hash: createHash("sha256") });
        send({ t: "host.file.ready", tid: m.tid, path: `${dirWin}\\${name}` });
        return;
      }
      case "agent.file.chunk": {
        const u = state.uploads.get(m.tid);
        if (!u) return;
        const bytes = Buffer.from(m.data, "base64");
        appendFileSync(`${u.final}.hdapart`, bytes);
        u.hash.update(bytes);
        u.bytes += bytes.length;
        send({ t: "host.file.ack", tid: m.tid, seq: m.seq });
        return;
      }
      case "agent.file.end": {
        const u = state.uploads.get(m.tid);
        if (!u) return;
        state.uploads.delete(m.tid);
        const sha = u.hash.digest("hex");
        if (u.bytes !== u.size || (m.sha256 && m.sha256 !== sha)) {
          unlinkSync(`${u.final}.hdapart`);
          send({ t: "host.file.error", tid: m.tid, error: "The file did not arrive intact (size or checksum mismatch) and was discarded." });
          return;
        }
        renameSync(`${u.final}.hdapart`, u.final);
        send({ t: "host.file.done", tid: m.tid, bytes: u.bytes, sha256: sha, path: u.winPath });
        return;
      }
      case "agent.file.get": {
        const p = local(m.path);
        if (!p || !existsSync(p) || statSync(p).isDirectory()) { send({ t: "host.file.error", tid: m.tid, error: "That file does not exist." }); return; }
        const buf = readFileSync(p);
        const d = { buf, off: 0, seq: 0, inFlight: 0, cancelled: false };
        state.downloads.set(m.tid, d);
        send({ t: "host.file.meta", tid: m.tid, name: path.basename(p), size: buf.length });
        pump(m.tid);
        return;
      }
      case "agent.file.ack": {
        const d = state.downloads.get(m.tid);
        if (d) { d.inFlight -= 1; pump(m.tid); }
        return;
      }
      case "agent.file.cancel": {
        const u = state.uploads.get(m.tid);
        if (u) { state.uploads.delete(m.tid); try { unlinkSync(`${u.final}.hdapart`); } catch { /* gone */ } }
        const d = state.downloads.get(m.tid);
        if (d) { d.cancelled = true; state.downloads.delete(m.tid); }
        return;
      }

      case "agent.clipboard.set":
        state.clipboard = m.text;
        send({ t: "host.clipboard.result", rid: m.rid, op: "set", ok: true });
        return;
      case "agent.clipboard.get":
        send({ t: "host.clipboard.result", rid: m.rid, op: "get", ok: true, text: state.clipboard });
        return;
      case "agent.sysinfo.get":
        send({ t: "host.sysinfo", rid: m.rid, info: {
          hostname: "MOCK-PC", user: "customer", osName: "Windows 11 Pro", osVersion: "23H2", osBuild: "22631.4317",
          architecture: "X64", cpu: "Mock CPU @ 3.0GHz", cpuLogicalCores: 8,
          memory: { totalBytes: 16 * 1024 ** 3, availableBytes: 9 * 1024 ** 3 },
          disks: [{ name: "C:", label: "OS", format: "NTFS", totalBytes: 512 * 1024 ** 3, freeBytes: 200 * 1024 ** 3 }],
          network: [{ name: "Ethernet", type: "Ethernet", ipv4: ["192.168.1.20"], gateway: "192.168.1.1", primary: true, speedMbps: 1000 }],
          uptimeSeconds: 93784, timeZone: "(UTC) Coordinated Universal Time", battery: null, agentVersion: "2.0.0.0", agentStartedAt: Date.now() - 60000, protocolVersion: 2,
        } });
        return;
      case "agent.exec":
        // Long-running until cancelled (or 30 s).
        state.running.set(m.id, setTimeout(() => {
          state.running.delete(m.id);
          send({ t: "host.execResult", id: m.id, exitCode: 0, stdout: "done\n", stderr: "" });
        }, 30_000));
        send({ t: "host.execResult", id: m.id, exitCode: -1, stdout: "working…\n", stderr: "", partial: true });
        return;
      case "agent.exec.cancel": {
        const timer = state.running.get(m.id);
        if (!timer) return;
        clearTimeout(timer);
        state.running.delete(m.id);
        send({ t: "host.execResult", id: m.id, exitCode: -1, stdout: "", stderr: "\n[stopped by the technician]\n" });
        return;
      }
    }
  }

  function pump(tid) {
    const d = state.downloads.get(tid);
    if (!d || d.cancelled) return;
    while (d.inFlight < window && d.off < d.buf.length) {
      const part = d.buf.subarray(d.off, d.off + chunk);
      d.off += part.length;
      d.inFlight += 1;
      send({ t: "host.file.chunk", tid, seq: ++d.seq, data: part.toString("base64") });
    }
    if (d.off >= d.buf.length && d.inFlight === 0) {
      state.downloads.delete(tid);
      send({ t: "host.file.done", tid, bytes: d.buf.length, sha256: createHash("sha256").update(d.buf).digest("hex") });
    }
  }

  return state;
}
