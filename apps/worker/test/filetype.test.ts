import { describe, expect, it } from "vitest";
import { detectFileKind, zipEntryNames } from "../src/filetype";
import { parseFilename } from "../src/upload";
import { makeDocx, makePdf, makeZip } from "./files";

const text = (s: string) => new TextEncoder().encode(s);

function lastIndexOf(haystack: Uint8Array, needle: Uint8Array): number {
  for (let i = haystack.length - needle.length; i >= 0; i--) {
    if (needle.every((byte, j) => haystack[i + j] === byte)) return i;
  }
  return -1;
}

describe("detectFileKind (from bytes, never the name)", () => {
  it("recognises a PDF by its %PDF- header", () => {
    expect(detectFileKind(makePdf())).toBe("pdf");
  });

  it("recognises a DOCX: a ZIP whose table of contents lists word/document.xml", () => {
    expect(detectFileKind(makeDocx())).toBe("docx");
  });

  it.each([
    [
      "an XLSX (ZIP without word/document.xml)",
      makeZip(["[Content_Types].xml", "xl/workbook.xml"]),
    ],
    ["plain text", text("This Agreement is made between ...")],
    ["a PNG image", Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)],
    ["%PDF not at the start", text(" %PDF-1.7")],
    ["an empty file", new Uint8Array()],
  ])("rejects %s", (_label, bytes) => {
    expect(detectFileKind(bytes)).toBeNull();
  });

  it("rejects a truncated ZIP (end record cut off)", () => {
    const docx = makeDocx();
    expect(zipEntryNames(docx.subarray(0, docx.length - 10))).toBeNull();
  });

  it("rejects a ZIP whose central directory points outside the file", () => {
    const docx = makeDocx();
    new DataView(docx.buffer).setUint32(docx.length - 6, 0xffff_ff00, true);
    expect(zipEntryNames(docx)).toBeNull();
  });

  it("rejects a fake DOCX that names word/document.xml only in an entry's own header", () => {
    // The table of contents (central directory, at the end) is what counts. Here the
    // entry's local header says word/document.xml but the table of contents disagrees.
    const zip = makeZip(["[Content_Types].xml", "word/document.xml"]);
    const name = new TextEncoder().encode("word/document.xml");
    const last = lastIndexOf(zip, name); // the central directory copy comes last
    zip[last + 5] = "X".charCodeAt(0); // "word/Xocument.xml"

    expect(lastIndexOf(zip, name)).toBeLessThan(last); // the local header still has it
    expect(detectFileKind(zip)).toBeNull();
  });

  it("rejects quickly a ZIP whose end record claims 65,535 entries it does not have", () => {
    const zip = makeDocx();
    const view = new DataView(zip.buffer);
    view.setUint16(zip.length - 22 + 8, 0xffff, true);
    view.setUint16(zip.length - 22 + 10, 0xffff, true);

    const started = Date.now();
    expect(zipEntryNames(zip)).toBeNull();
    expect(Date.now() - started).toBeLessThan(50);
  });

  it("lists entry names in order", () => {
    expect(zipEntryNames(makeZip(["a.txt", "dir/b.xml"]))).toEqual(["a.txt", "dir/b.xml"]);
  });
});

describe("parseFilename (display only)", () => {
  it.each([
    ["contract.pdf", "contract.pdf"],
    ["Contrat%20de%20bail%20%C3%A9t%C3%A9.pdf", "Contrat de bail été.pdf"],
    ["..%2F..%2Fetc%2Fpasswd", "passwd"],
    ["C:%5CUsers%5Cme%5Cnda.docx", "nda.docx"],
    ["nda%E2%80%8B.pdf", "nda.pdf"], // zero-width space removed
  ])("%s -> %s", (header, expected) => {
    expect(parseFilename(header)).toBe(expected);
  });

  it.each([
    ["missing", null],
    ["empty", ""],
    ["bad percent-encoding", "%E0%A4%A"],
    ["only a path", "folder%2F"],
    ["too long", "a".repeat(256)],
  ])("rejects %s", (_label, header) => {
    expect(parseFilename(header)).toBeNull();
  });
});
