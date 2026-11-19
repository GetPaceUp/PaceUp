// Reads a phone-book export (.vcf) in the browser and keeps only names and
// numbers. Photos and every other field stay on the device, so even a large
// export with contact pictures becomes a small upload.

function decodeQP(value, charset = "utf-8") {
  const text = value.replace(/=\r?\n/g, "");
  const bytes = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "=" && /^[0-9A-F]{2}$/i.test(text.slice(i + 1, i + 3))) { bytes.push(parseInt(text.slice(i + 1, i + 3), 16)); i += 2; }
    else bytes.push(...new TextEncoder().encode(text[i]));
  }
  try { return new TextDecoder(/utf-?8/i.test(charset) ? "utf-8" : "latin1").decode(new Uint8Array(bytes)); } catch { return text; }
}
const unescape = (v) => v.replace(/\\n/gi, " ").replace(/\\([,;\\])/g, "$1");

/** [{ name, phones: [] }] from vCard text. */
export function readVcf(text) {
  const lines = text.replace(/^﻿/, "").replace(/=\r?\n(?=[^\r\n])/g, "=QPSOFT").replace(/\r?\n[ \t]/g, "").split(/\r?\n/).map((l) => l.replace(/=QPSOFT/g, "=\n"));
  const out = [];
  let cur = null;
  for (const line of lines) {
    if (/^BEGIN:VCARD/i.test(line)) { cur = { fn: "", n: "", phones: [] }; continue; }
    if (/^END:VCARD/i.test(line)) { if (cur && cur.phones.length) out.push({ name: (cur.fn || cur.n).trim().slice(0, 200), phones: cur.phones.slice(0, 20) }); cur = null; continue; }
    if (!cur) continue;
    const idx = line.indexOf(":");
    if (idx < 0 || idx > 200) continue;
    const [prop, ...params] = line.slice(0, idx).split(";");
    const key = prop.replace(/^item\d+\./i, "").toUpperCase();
    if (key !== "FN" && key !== "N" && key !== "TEL") continue; // skip PHOTO and everything else
    let value = line.slice(idx + 1);
    if (params.some((p) => /QUOTED-PRINTABLE/i.test(p))) value = decodeQP(value, params.find((p) => /CHARSET=/i.test(p))?.split("=")[1]);
    if (key === "FN") cur.fn = unescape(value);
    else if (key === "N") { const [last = "", first = "", middle = ""] = value.split(";").map(unescape); cur.n = [first, middle, last].filter(Boolean).join(" "); }
    else cur.phones.push(value.replace(/^tel:/i, "").slice(0, 40));
  }
  return out.filter((c) => c.name);
}
