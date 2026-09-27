/**
 * Extract the text a pdfkit-generated PDF draws, for assertions — no PDF
 * library needed (the suite adds no dependencies to the product).
 *
 * Reports embed TrueType fonts (Noto Sans, Noto Sans Tamil), so text is written
 * as 2-byte glyph ids; each font carries a /ToUnicode CMap mapping them back to
 * Unicode. This walks the objects, parses those CMaps, and decodes every Tj/TJ
 * with the font selected by the preceding Tf. Order is VISUAL glyph order: a
 * Tamil prefix vowel sign (e.g. ே in வேலை) comes out before its consonant, so
 * assertions should use words without prefix vowel signs.
 */
import { inflateSync } from "node:zlib";

function objects(src) {
  const out = new Map();
  for (const m of src.matchAll(/(\d+) 0 obj([\s\S]*?)endobj/g)) {
    const body = m[2];
    const si = body.search(/stream\r?\n/);
    let dict = body, stream = null;
    if (si !== -1) {
      dict = body.slice(0, si);
      const start = si + body.slice(si).match(/stream\r?\n/)[0].length;
      // Cut by the declared /Length. Trimming a trailing "\r?\n" instead would
      // eat a real 0x0D when compressed data happens to end with one — which
      // made decoding fail intermittently.
      const len = dict.match(/\/Length\s+(\d+)(?!\s+\d+\s+R)/);
      const end = len ? start + Number(len[1]) : body.lastIndexOf("endstream");
      let bytes = Buffer.from(body.slice(start, end), "latin1");
      if (/\/FlateDecode/.test(dict)) {
        try { bytes = inflateSync(bytes); } catch (err) { throw new Error(`pdftext: stream ${m[1]} did not inflate: ${err.message}`); }
      }
      stream = bytes.toString("latin1");
    }
    out.set(Number(m[1]), { dict, stream });
  }
  return out;
}

// Hex strings may contain whitespace: a ligature maps to several code units,
// e.g. the "fi" glyph is <0066 0069>. Missing that shifts every later entry.
const utf16 = (hex) => {
  const b = Buffer.from(hex.replace(/\s+/g, ""), "hex");
  let s = "";
  for (let i = 0; i + 1 < b.length; i += 2) s += String.fromCharCode(b.readUInt16BE(i));
  return s;
};

function parseCmap(text) {
  const map = new Map();
  for (const block of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const [, src, dst] of block[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F\s]+)>/g)) map.set(parseInt(src, 16), utf16(dst));
  }
  for (const block of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const [, lo, hi, rest] of block[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(\[[^\]]*\]|<[0-9a-fA-F\s]+>)/g)) {
      const a = parseInt(lo, 16), z = parseInt(hi, 16);
      if (rest.startsWith("[")) {
        [...rest.matchAll(/<([0-9a-fA-F\s]+)>/g)].forEach((d, i) => map.set(a + i, utf16(d[1])));
      } else {
        const base = Buffer.from(rest.slice(1, -1).replace(/\s+/g, ""), "hex");
        for (let c = a; c <= z; c++) {
          const b = Buffer.from(base);
          b.writeUInt16BE((b.readUInt16BE(b.length - 2) + (c - a)) & 0xffff, b.length - 2);
          map.set(c, utf16(b.toString("hex")));
        }
      }
    }
  }
  return map;
}

/** { text, fonts } — the drawn text (runs joined, TJ ops separated by newlines) and the BaseFont names. */
export function pdfContent(buf) {
  const objs = objects(buf.toString("latin1"));
  const fontCmap = new Map();   // font object number → Map(code → string) | null (simple font)
  const baseFonts = [];
  for (const [num, o] of objs) {
    if (!/\/Type\s*\/Font/.test(o.dict) || /\/Subtype\s*\/CIDFontType/.test(o.dict)) continue;
    const bf = o.dict.match(/\/BaseFont\s*\/([^\s/>]+)/);
    if (bf) baseFonts.push(bf[1]);
    const tu = o.dict.match(/\/ToUnicode\s+(\d+)\s+0\s+R/);
    fontCmap.set(num, tu ? parseCmap(objs.get(Number(tu[1]))?.stream ?? "") : null);
  }
  const names = new Map();      // /F1 → font object number
  for (const o of objs.values()) {
    for (const fd of o.dict.matchAll(/\/Font\s*<<([\s\S]*?)>>/g)) {
      for (const [, n, ref] of fd[1].matchAll(/\/(\w+)\s+(\d+)\s+0\s+R/g)) names.set(n, Number(ref));
    }
  }
  const lines = [];
  for (const o of objs.values()) {
    if (!o.stream || !/\bTf\b/.test(o.stream)) continue;
    let cmap = null;
    let line = "";
    for (const op of o.stream.matchAll(/\/(\w+)\s+[\d.]+\s+Tf|\[((?:[^\]\\]|\\.)*)\]\s*TJ|<([0-9a-fA-F]*)>\s*Tj|\bET\b/g)) {
      if (op[1] !== undefined) { cmap = fontCmap.get(names.get(op[1])) ?? null; continue; }
      if (op[0] === "ET") { if (line) lines.push(line); line = ""; continue; }
      const hexes = op[2] !== undefined ? [...op[2].matchAll(/<([0-9a-fA-F]*)>/g)].map((x) => x[1]) : [op[3]];
      for (const hx of hexes) {
        if (cmap) for (let i = 0; i + 3 < hx.length + 0; i += 4) line += cmap.get(parseInt(hx.slice(i, i + 4), 16)) ?? "�";
        else line += Buffer.from(hx, "hex").toString("latin1");
      }
    }
    if (line) lines.push(line);
  }
  return { text: lines.join("\n"), fonts: baseFonts };
}
