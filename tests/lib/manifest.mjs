/**
 * The Windows application manifest: a strict XML well-formedness check, a
 * reader for the RT_MANIFEST resource actually embedded in a built PE, and the
 * assertions that say what this project's manifest has to contain.
 *
 * Why any of this exists — MT-01, 2026-09-05. `windows/Applet/app.manifest`
 * contained `--install-service` inside an XML comment. XML 1.0 section 2.5
 * forbids a double hyphen inside a comment, so the file was not well-formed
 * XML. MSBuild never parses it: `<ApplicationManifest>` copies the bytes
 * verbatim into the executable's RT_MANIFEST resource. So the defect
 * cross-compiled on Ubuntu, passed every test here, produced a valid-looking
 * 65 MB PE — and then Windows' side-by-side loader, which does parse it,
 * refused to build an activation context and killed the process before `Main`:
 *
 *     "The application has failed to start because its side-by-side
 *      configuration is incorrect."
 *
 * Nothing on Linux could have caught that, because nothing on Linux was
 * looking. Checking the source XML alone is still not enough — a later build
 * step could substitute or damage the resource — so `readPeManifest` pulls the
 * bytes back out of the finished .exe and they get checked too.
 *
 * The XML scanner here is deliberately hand-written and dependency-free: the
 * non-browser test blocks add no dependency of their own (tests/lib/harness.mjs),
 * and this has to run inside scripts/build-windows.sh, which cannot assume a
 * `npm install` has happened.
 */
import { readFileSync } from "node:fs";

/* ------------------------------------------------------------------ XML ---- */

/** Thrown with a line/column so a failure points at the character, not the file. */
export class XmlError extends Error {
  constructor(message, source, index) {
    const upto = source.slice(0, index);
    const line = upto.split("\n").length;
    const column = index - (upto.lastIndexOf("\n") + 1) + 1;
    super(`line ${line}, column ${column}: ${message}`);
    this.line = line;
    this.column = column;
  }
}

const NAME_START = /[A-Za-z_:À-˿Ͱ-῿‌-‍⁰-↏]/;
const NAME_CHAR = /[-.0-9A-Za-z_:·À-˿̀-ͯͰ-῿‌-‍‿-⁀⁰-↏]/;

/**
 * Parse XML strictly enough to reject everything Windows' manifest parser
 * rejects, and return a tree of {name, ns, attrs, children, text}.
 *
 * Strict about the things that have actually bitten, or that the brief for this
 * fix called out: a double hyphen in a comment, an unterminated comment, an
 * unquoted or duplicated attribute, a raw `<` or a bare `&` in text, a stray
 * `]]>`, mismatched or unclosed tags, an XML declaration anywhere but the very
 * first byte, and an undeclared namespace prefix.
 */
export function parseXml(src) {
  let i = 0;
  const fail = (msg, at = i) => { throw new XmlError(msg, src, at); };

  if (src.charCodeAt(0) === 0xfeff) fail("byte-order mark: the manifest must be plain UTF-8", 0);

  let decl = null;
  if (src.startsWith("<?xml")) {
    const end = src.indexOf("?>");
    if (end < 0) fail("XML declaration is never closed");
    const body = src.slice(5, end);
    decl = {
      version: /\bversion\s*=\s*"([^"]*)"|\bversion\s*=\s*'([^']*)'/.exec(body)?.slice(1).find(Boolean) ?? null,
      encoding: /\bencoding\s*=\s*"([^"]*)"|\bencoding\s*=\s*'([^']*)'/.exec(body)?.slice(1).find(Boolean) ?? null,
    };
    i = end + 2;
  }
  if (src.indexOf("<?xml", i) >= 0) fail("a second XML declaration", src.indexOf("<?xml", i));

  const stack = [];
  let root = null;

  const skipMisc = () => {
    for (;;) {
      const before = i;
      while (i < src.length && /\s/.test(src[i])) i++;
      if (src.startsWith("<!--", i)) {
        // XML 1.0 section 2.5: the content may not contain "--", so the first
        // "--" after the opener has to be the terminator. This is the check
        // that MT-01 needed and nothing had.
        const dash = src.indexOf("--", i + 4);
        if (dash < 0) fail("comment is never closed", i);
        if (src[dash + 2] !== ">") {
          fail("double hyphen inside a comment (XML 1.0 section 2.5 forbids it; " +
               "Windows' side-by-side loader rejects the whole manifest)", dash);
        }
        i = dash + 3;
      } else if (src.startsWith("<?", i)) {
        const end = src.indexOf("?>", i);
        if (end < 0) fail("processing instruction is never closed", i);
        i = end + 2;
      } else if (src.startsWith("<!DOCTYPE", i)) {
        fail("a DOCTYPE has no place in an application manifest", i);
      }
      if (i === before) return;
    }
  };

  const readName = () => {
    const start = i;
    if (i >= src.length || !NAME_START.test(src[i])) fail("expected a name");
    i++;
    while (i < src.length && NAME_CHAR.test(src[i])) i++;
    return src.slice(start, i);
  };

  /** Resolve a qualified name against the namespace bindings in scope. */
  const resolve = (qname, scope, isAttr) => {
    const colon = qname.indexOf(":");
    if (colon < 0) return { ns: isAttr ? null : (scope[""] ?? null), local: qname };
    const prefix = qname.slice(0, colon);
    if (prefix === "xml") return { ns: "http://www.w3.org/XML/1998/namespace", local: qname.slice(colon + 1) };
    if (!(prefix in scope)) fail(`namespace prefix "${prefix}" is not declared`);
    return { ns: scope[prefix], local: qname.slice(colon + 1) };
  };

  const checkText = (text, at) => {
    let m;
    const amp = /&(#[0-9]+;|#x[0-9a-fA-F]+;|(?:amp|lt|gt|quot|apos);)?/g;
    while ((m = amp.exec(text))) {
      if (!m[1]) fail("a bare '&' must be written '&amp;'", at + m.index);
    }
    const cdataEnd = text.indexOf("]]>");
    if (cdataEnd >= 0) fail("the literal ']]>' must be written ']]&gt;'", at + cdataEnd);
  };

  skipMisc();

  while (i < src.length) {
    if (src[i] !== "<") {
      const next = src.indexOf("<", i);
      const end = next < 0 ? src.length : next;
      const text = src.slice(i, end);
      if (stack.length === 0) {
        if (text.trim()) fail("text outside the root element");
      } else {
        checkText(text, i);
        stack[stack.length - 1].node.text += text;
      }
      i = end;
      continue;
    }

    if (src.startsWith("<!--", i) || src.startsWith("<?", i) || src.startsWith("<!DOCTYPE", i)) {
      skipMisc();
      continue;
    }

    if (src.startsWith("<![CDATA[", i)) {
      const end = src.indexOf("]]>", i);
      if (end < 0) fail("CDATA section is never closed", i);
      if (stack.length === 0) fail("CDATA outside the root element", i);
      stack[stack.length - 1].node.text += src.slice(i + 9, end);
      i = end + 3;
      continue;
    }

    if (src.startsWith("</", i)) {
      const at = i;
      i += 2;
      const qname = readName();
      while (i < src.length && /\s/.test(src[i])) i++;
      if (src[i] !== ">") fail("expected '>' to close an end tag");
      i++;
      const open = stack.pop();
      if (!open) fail(`</${qname}> closes nothing`, at);
      if (open.qname !== qname) fail(`</${qname}> does not match <${open.qname}>`, at);
      if (stack.length === 0) { skipMisc(); }
      continue;
    }

    // Start tag.
    const at = i;
    i++;
    const qname = readName();
    const parentScope = stack.length ? stack[stack.length - 1].scope : {};
    const scope = Object.create(null);
    for (const k of Object.keys(parentScope)) scope[k] = parentScope[k];
    const rawAttrs = [];

    for (;;) {
      const hadSpace = /\s/.test(src[i] ?? "");
      while (i < src.length && /\s/.test(src[i])) i++;
      if (src[i] === ">" || src.startsWith("/>", i)) break;
      if (!hadSpace) fail("attributes must be separated by whitespace");
      const aname = readName();
      while (i < src.length && /\s/.test(src[i])) i++;
      if (src[i] !== "=") fail(`attribute "${aname}" has no value (XML has no bare attributes)`);
      i++;
      while (i < src.length && /\s/.test(src[i])) i++;
      const quote = src[i];
      if (quote !== '"' && quote !== "'") fail(`attribute "${aname}" value must be quoted`);
      i++;
      const close = src.indexOf(quote, i);
      if (close < 0) fail(`attribute "${aname}" value is never closed`);
      const value = src.slice(i, close);
      if (value.includes("<")) fail(`a raw '<' in attribute "${aname}" must be written '&lt;'`, i);
      checkText(value, i);
      i = close + 1;
      if (rawAttrs.some((a) => a.qname === aname)) fail(`attribute "${aname}" appears twice`, at);
      rawAttrs.push({ qname: aname, value });
      if (aname === "xmlns") scope[""] = value;
      else if (aname.startsWith("xmlns:")) scope[aname.slice(6)] = value;
    }

    const selfClosing = src.startsWith("/>", i);
    i += selfClosing ? 2 : 1;

    const { ns, local } = resolve(qname, scope, false);
    const attrs = Object.create(null);
    for (const a of rawAttrs) {
      if (a.qname === "xmlns" || a.qname.startsWith("xmlns:")) continue;
      attrs[resolve(a.qname, scope, true).local] = a.value;
    }
    const node = { name: local, qname, ns, attrs, children: [], text: "" };

    if (stack.length === 0) {
      if (root) fail("a second root element", at);
      root = node;
    } else {
      stack[stack.length - 1].node.children.push(node);
    }
    if (!selfClosing) stack.push({ qname, node, scope });
    else if (stack.length === 0) skipMisc();
  }

  if (stack.length) throw new XmlError(`<${stack[stack.length - 1].qname}> is never closed`, src, src.length - 1);
  if (!root) fail("no root element", 0);
  return { decl, root };
}

/** Every element in document order. */
export function* walk(node) {
  yield node;
  for (const c of node.children) yield* walk(c);
}

/* ------------------------------------------------------------- PE reader ---- */

const RT_MANIFEST = 24;

/**
 * Read the RT_MANIFEST resource out of a built PE, plus the machine type, so
 * the manifest that ships can be checked rather than the one that was written.
 * Returns {machine, manifests: [{id, lang, bytes}]}.
 */
export function readPeManifest(path) {
  const d = readFileSync(path);
  if (d.readUInt16LE(0) !== 0x5a4d) throw new Error(`${path}: not a PE (no MZ)`);
  const pe = d.readUInt32LE(0x3c);
  if (d.readUInt32LE(pe) !== 0x00004550) throw new Error(`${path}: not a PE (no PE\\0\\0)`);

  const machine = d.readUInt16LE(pe + 4);
  const nsec = d.readUInt16LE(pe + 6);
  const optSize = d.readUInt16LE(pe + 20);
  const opt = pe + 24;
  const plus = d.readUInt16LE(opt) === 0x20b;
  const numRva = d.readUInt32LE(opt + (plus ? 108 : 92));
  const ddOff = opt + (plus ? 112 : 96);

  const secOff = pe + 24 + optSize;
  const sections = [];
  for (let s = 0; s < nsec; s++) {
    const o = secOff + 40 * s;
    sections.push({
      vsize: d.readUInt32LE(o + 8),
      vaddr: d.readUInt32LE(o + 12),
      rsize: d.readUInt32LE(o + 16),
      raddr: d.readUInt32LE(o + 20),
    });
  }
  const toOffset = (rva) => {
    for (const s of sections) {
      const span = Math.max(s.vsize, s.rsize);
      if (rva >= s.vaddr && rva < s.vaddr + span) return s.raddr + (rva - s.vaddr);
    }
    throw new Error(`${path}: RVA ${rva.toString(16)} is in no section`);
  };

  if (numRva < 3) return { machine, manifests: [] };
  const rsrcRva = d.readUInt32LE(ddOff + 16);
  if (!rsrcRva) return { machine, manifests: [] };
  const base = toOffset(rsrcRva);

  const manifests = [];
  const walkDir = (off, path_) => {
    const named = d.readUInt16LE(off + 12);
    const ids = d.readUInt16LE(off + 14);
    for (let e = 0; e < named + ids; e++) {
      const ent = off + 16 + 8 * e;
      const nameField = d.readUInt32LE(ent);
      const dataField = d.readUInt32LE(ent + 4);
      let key;
      if (nameField & 0x80000000) {
        const no = base + (nameField & 0x7fffffff);
        key = d.toString("utf16le", no + 2, no + 2 + d.readUInt16LE(no) * 2);
      } else {
        key = nameField;
      }
      if (dataField & 0x80000000) {
        walkDir(base + (dataField & 0x7fffffff), [...path_, key]);
      } else if (path_[0] === RT_MANIFEST) {
        const de = base + dataField;
        const off_ = toOffset(d.readUInt32LE(de));
        const size = d.readUInt32LE(de + 4);
        manifests.push({ id: path_[1], lang: key, bytes: d.subarray(off_, off_ + size) });
      }
    }
  };
  walkDir(base, []);
  return { machine, manifests };
}

/* ------------------------------------------------------- the assertions ---- */

export const ASM_V1 = "urn:schemas-microsoft-com:asm.v1";
export const ASM_V2 = "urn:schemas-microsoft-com:asm.v2";
export const ASM_V3 = "urn:schemas-microsoft-com:asm.v3";
export const COMPAT_V1 = "urn:schemas-microsoft-com:compatibility.v1";
export const SMI_2005 = "http://schemas.microsoft.com/SMI/2005/WindowsSettings";
export const SMI_2016 = "http://schemas.microsoft.com/SMI/2016/WindowsSettings";

/** The only levels Windows accepts. */
export const EXECUTION_LEVELS = ["asInvoker", "highestAvailable", "requireAdministrator"];

/**
 * Everything this project's applet manifest must satisfy, as a list of
 * {name, ok, detail}. Takes the raw bytes so the encoding checks are real.
 *
 * `expectLevel` stays "asInvoker" on purpose: CLAUDE.md constraint #1 puts the
 * consent dialog before anything else, and a manifest that asks for elevation
 * puts a UAC prompt in front of the end user before they have seen it.
 */
export function validateManifest(bytes, { where, expectLevel = "asInvoker" } = {}) {
  const results = [];
  const add = (name, ok, detail = "") => results.push({ name, ok, detail });
  const label = where ? `${where}: ` : "";

  /* --- bytes, before it is even text ------------------------------------- */
  add(`${label}no UTF-8 byte-order mark`,
    !(bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf));
  add(`${label}no NUL bytes (not UTF-16, not truncated)`, !bytes.includes(0));

  const src = bytes.toString("utf8");
  add(`${label}valid UTF-8`, Buffer.from(src, "utf8").equals(bytes));

  // Shell heredocs and hand-built XML leave these behind. None can be legal here.
  for (const [what, needle] of [
    ['backslash-escaped quote (\\")', '\\"'],
    ["backslash-escaped single quote (\\')", "\\'"],
    ["literal \\n instead of a newline", "\\n"],
    ["literal \\r", "\\r"],
    ["literal \\t", "\\t"],
  ]) {
    add(`${label}no ${what}`, !src.includes(needle));
  }
  add(`${label}no CRLF-only or missing final newline oddities`, src.trimEnd().endsWith(">"));

  /* --- well-formedness ---------------------------------------------------- */
  let doc = null;
  try {
    doc = parseXml(src);
    add(`${label}well-formed XML`, true);
  } catch (e) {
    add(`${label}well-formed XML`, false, e.message);
    return results; // nothing below can be evaluated
  }

  add(`${label}declares version 1.0 and utf-8`,
    doc.decl?.version === "1.0" && /^utf-8$/i.test(doc.decl?.encoding ?? ""),
    JSON.stringify(doc.decl));

  const root = doc.root;
  const all = [...walk(root)];
  const first = (name, ns) => all.find((n) => n.name === name && (!ns || n.ns === ns));

  /* --- the assembly element ----------------------------------------------- */
  add(`${label}root is <assembly> in ${ASM_V1}`,
    root.name === "assembly" && root.ns === ASM_V1, `${root.qname} in ${root.ns}`);
  add(`${label}manifestVersion is 1.0`, root.attrs.manifestVersion === "1.0", root.attrs.manifestVersion);

  /* --- identity and architecture ------------------------------------------ */
  const identity = first("assemblyIdentity", ASM_V1);
  add(`${label}<assemblyIdentity> present and in ${ASM_V1}`, !!identity);
  if (identity) {
    add(`${label}identity type is win32`, identity.attrs.type === "win32", identity.attrs.type);
    add(`${label}identity has a name`, !!identity.attrs.name, identity.attrs.name);
    add(`${label}identity version is four numeric parts`,
      /^\d+\.\d+\.\d+\.\d+$/.test(identity.attrs.version ?? ""), identity.attrs.version);
    add(`${label}processorArchitecture is amd64 (the applet publishes win-x64 only)`,
      identity.attrs.processorArchitecture === "amd64", identity.attrs.processorArchitecture);
  }

  /* --- elevation ----------------------------------------------------------- */
  const trust = first("trustInfo", ASM_V2);
  add(`${label}<trustInfo> present and in ${ASM_V2}`, !!trust);
  const privs = first("requestedPrivileges", ASM_V3);
  add(`${label}<requestedPrivileges> present and in ${ASM_V3}`, !!privs);
  const level = first("requestedExecutionLevel", ASM_V3);
  add(`${label}<requestedExecutionLevel> present and in ${ASM_V3}`, !!level);
  if (level) {
    add(`${label}level is one Windows accepts`,
      EXECUTION_LEVELS.includes(level.attrs.level), level.attrs.level);
    // Constraint #1: consent comes first. Elevation is a separate, separately
    // consented step (PLAN 5.2), not something the loader does on startup.
    add(`${label}level is ${expectLevel} — elevation stays a separate consented step`,
      level.attrs.level === expectLevel, level.attrs.level);
    add(`${label}uiAccess is false`, level.attrs.uiAccess === "false", level.attrs.uiAccess);
  }

  /* --- DPI (PLAN 4.2: capture coordinates must be physical pixels) --------- */
  const dpiAware = first("dpiAware", SMI_2005);
  const dpiAwareness = first("dpiAwareness", SMI_2016);
  add(`${label}dpiAware declared in the 2005 SMI namespace`, !!dpiAware);
  add(`${label}dpiAwareness declared in the 2016 SMI namespace`, !!dpiAwareness);
  add(`${label}per-monitor DPI, not system-scaled`,
    dpiAware?.text.trim() === "true/pm" && dpiAwareness?.text.trim() === "permonitorv2",
    `${dpiAware?.text.trim()} / ${dpiAwareness?.text.trim()}`);

  /* --- supportedOS --------------------------------------------------------- */
  const compat = first("compatibility", COMPAT_V1);
  add(`${label}<compatibility> present and in ${COMPAT_V1}`, !!compat);
  const oses = all.filter((n) => n.name === "supportedOS");
  add(`${label}Windows 10/11 declared supported`,
    oses.some((n) => n.attrs.Id?.toLowerCase() === "{8e0f7a12-bfb3-4fe8-b9a5-48fd50a15a9a}"));
  add(`${label}every supportedOS Id is a braced GUID`,
    oses.every((n) => /^\{[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\}$/.test(n.attrs.Id ?? "")));

  /* --- nothing that would need a side-by-side assembly to be installed ----- */
  add(`${label}no <dependency> on a side-by-side assembly`,
    !all.some((n) => n.name === "dependentAssembly"));

  return results;
}

export const IMAGE_FILE_MACHINE_AMD64 = 0x8664;
