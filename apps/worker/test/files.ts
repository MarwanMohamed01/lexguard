// Tiny synthetic files for upload tests. Only the structure matters (the converter is fake),
// and random content keeps every file's SHA-256 unique across tests.

export function makePdf(): Uint8Array {
  return new TextEncoder().encode(`%PDF-1.7\n% ${crypto.randomUUID()}\n%%EOF\n`);
}

/**
 * A minimal ZIP archive with the given entry names: local file headers, a central directory
 * and its end record. Contents are stored uncompressed; CRCs are left at 0 because only the
 * structure is read (the real converter never sees these files).
 */
export function makeZip(names: readonly string[]): Uint8Array {
  const encoder = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;

  for (const name of names) {
    const nameBytes = encoder.encode(name);
    const content = encoder.encode(crypto.randomUUID());

    const local = new Uint8Array(30 + nameBytes.length + content.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint32(18, content.length, true); // compressed size
    lv.setUint32(22, content.length, true); // uncompressed size
    lv.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    local.set(content, 30 + nameBytes.length);

    const central = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint32(20, content.length, true);
    cv.setUint32(24, content.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true); // where the local header starts
    central.set(nameBytes, 46);

    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }

  const centralSize = centrals.reduce((sum, c) => sum + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, names.length, true);
  ev.setUint16(10, names.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);

  const parts = [...locals, ...centrals, end];
  const out = new Uint8Array(parts.reduce((sum, p) => sum + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

export const makeDocx = () => makeZip(["[Content_Types].xml", "_rels/.rels", "word/document.xml"]);

/** Contract-like text of at least `minChars`, with numbered clauses, definitions and emoji. */
export function contractText(minChars: number): string {
  const parts = ["MASTER SERVICES AGREEMENT\n\n"];
  let length = parts[0]?.length ?? 0;
  for (let article = 1; length < minChars; article++) {
    const part =
      `${String(article)}. Article Title ${String(article)}\n` +
      `"Term ${String(article)}" means the period set out in this clause 📄.\n` +
      `${String(article)}.1 Scope. The Supplier shall provide the services (a) on time; ` +
      `(b) with care. ${"Further obligations apply. ".repeat(20)}\n` +
      `${String(article)}.2 Fees. Payable within 30 days of invoice.\n\n`;
    parts.push(part);
    length += part.length;
  }
  return parts.join("");
}
