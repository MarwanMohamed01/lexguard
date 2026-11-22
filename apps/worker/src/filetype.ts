// Decides what an uploaded file really is from its bytes. The filename and Content-Type
// header are chosen by the sender and are trivial to fake, so they are never trusted.
//
// Only PDF and DOCX are accepted: they are the contract formats, and toMarkdown converts
// them for free (image conversion would spend Workers AI neurons).

export type FileKind = "pdf" | "docx";

export const MIME_TYPES: Readonly<Record<FileKind, string>> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

const ascii = (text: string) => Uint8Array.from(text, (char) => char.charCodeAt(0));
const PDF_MAGIC = ascii("%PDF-");
const DOCX_MAIN_PART = "word/document.xml";

function startsWith(bytes: Uint8Array, prefix: Uint8Array, at = 0): boolean {
  if (bytes.length < at + prefix.length) return false;
  return prefix.every((byte, i) => bytes[at + i] === byte);
}

export function detectFileKind(bytes: Uint8Array): FileKind | null {
  if (startsWith(bytes, PDF_MAGIC)) return "pdf";
  if (zipEntryNames(bytes)?.includes(DOCX_MAIN_PART)) return "docx";
  return null;
}

/**
 * Names of the files inside a ZIP archive (DOCX is a ZIP), read from its central directory:
 * the table of contents at the end of the archive. Reads only that small table, never the
 * compressed contents, so the CPU cost stays tiny even for a large file. Returns null when
 * the bytes are not a well-formed ZIP.
 */
export function zipEntryNames(bytes: Uint8Array): string[] | null {
  if (!startsWith(bytes, ascii("PK\x03\x04"))) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  // End-of-central-directory record: 22 bytes plus a comment of up to 65,535 bytes.
  const EOCD = 0x06054b50;
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65_535); i--) {
    if (view.getUint32(i, true) === EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;

  const count = view.getUint16(eocd + 10, true);
  const size = view.getUint32(eocd + 12, true);
  const offset = view.getUint32(eocd + 16, true);
  if (offset + size > eocd) return null;

  const names: string[] = [];
  const decoder = new TextDecoder();
  let at = offset;
  for (let entry = 0; entry < count; entry++) {
    if (at + 46 > offset + size || view.getUint32(at, true) !== 0x02014b50) return null;
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    if (at + 46 + nameLength > offset + size) return null;
    names.push(decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength)));
    at += 46 + nameLength + extraLength + commentLength;
  }
  return names;
}
