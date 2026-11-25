// @lexguard/retrieval's FTS5 queries against the real engine (node:sqlite), with generated
// hostile input. Two properties for every input:
//   1. the query never fails (a syntax error would turn any odd question into a 500);
//   2. every row it returns belongs to the requested scope (in production: the tenant and
//      document; a leak here is cross-tenant data, T11).
// A control run builds the same MATCH by plain string concatenation and must break both
// properties, which shows the generated inputs are hostile enough to catch a broken builder.
import { DatabaseSync } from "node:sqlite";
import { ftsQuery, scopedFtsQuery } from "@lexguard/retrieval";
import { describe, expect, it } from "vitest";

const PIECES = [
  '"',
  "'",
  "(",
  ")",
  "*",
  "^",
  ":",
  "-",
  "+",
  "{",
  "}",
  ",",
  ".",
  " ",
  "  ",
  "\n",
  "\t",
  "AND",
  "OR",
  "NOT",
  "NEAR",
  "NEAR(",
  "near",
  "and",
  "or",
  "text",
  "doc",
  "tenant",
  "text:",
  "doc:",
  "doc :",
  "{doc}",
  "-doc",
  "d1",
  "d2",
  '"d2"',
  "t2",
  "law",
  "laws",
  "governs",
  "termination",
  "payment",
  "*law",
  "law*",
  "^law",
  "é",
  "é",
  "\u0000",
  "\u0007",
  "\u202E",
  "\u200B",
  "\uFEFF",
  "𝔘",
  "\ud800",
  "契約",
  "Kündigung",
  "İ",
  "ß",
];

/** Deterministic xorshift, so a failure can be reproduced from its index. */
function generator(seed: number) {
  let state = seed;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4_294_967_296;
  };
}

function hostileInputs(count: number): string[] {
  const next = generator(20_261_124);
  return Array.from({ length: count }, () => {
    const parts = 1 + Math.floor(next() * 12);
    let s = "";
    for (let i = 0; i < parts; i++) s += PIECES[Math.floor(next() * PIECES.length)] ?? "";
    return s;
  });
}

const DOCS = [
  {
    tenant: "t1",
    doc: "d1",
    text: "Governing law. This Agreement is governed by the laws of New York.",
  },
  {
    tenant: "t1",
    doc: "d1",
    text: "Termination for convenience on thirty (30) days notice. NEAR AND OR NOT",
  },
  { tenant: "t1", doc: "d2", text: "Payment terms: the law of Delaware governs. text doc d1" },
  {
    tenant: "t2",
    doc: "d1",
    text: "Another tenant: governing law and termination, Kündigung, 契約, é",
  },
];

function database(tokenizer: string) {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE VIRTUAL TABLE fts USING fts5(text, tenant, doc, tokenize = '${tokenizer}')`);
  const insert = db.prepare("INSERT INTO fts (text, tenant, doc) VALUES (?, ?, ?)");
  for (const d of DOCS) insert.run(d.text, d.tenant, d.doc);
  return db.prepare(
    "SELECT tenant, doc FROM fts WHERE fts MATCH ? ORDER BY bm25(fts, 1.0, 0.0, 0.0)",
  );
}

/**
 * Targeted escapes: close the parenthesis the builder would open, then OR in a branch that
 * ignores the scope. Random fragments rarely form these, so they are listed explicitly.
 */
const ESCAPES = [
  "law) OR (governing",
  "x) OR tenant : t2 OR (x",
  "x) OR doc : d2 OR (x",
  ") OR {text tenant doc} : law OR (",
  "nothing) OR (payment",
  'x") OR ("law',
];

const INPUTS = [...ESCAPES, ...hostileInputs(5_000)];

describe.each(["unicode61", "porter unicode61"])("FTS5 query safety (%s)", (tokenizer) => {
  it("never fails and never leaves the tenant + document scope", () => {
    const search = database(tokenizer);
    const failures: string[] = [];
    let matched = 0;
    INPUTS.forEach((input, index) => {
      const match = scopedFtsQuery("text", input, { tenant: "t1", doc: "d1" });
      if (match === null) return;
      try {
        const rows = search.all(match);
        if (rows.length > 0) matched++;
        for (const row of rows) {
          if (row.tenant !== "t1" || row.doc !== "d1") {
            failures.push(`#${String(index)} out of scope: ${JSON.stringify(input)}`);
          }
        }
      } catch (error) {
        failures.push(`#${String(index)} ${String(error)}: ${JSON.stringify(input)}`);
      }
    });
    expect(failures.slice(0, 5)).toEqual([]);
    // The inputs reach the data: a safety test that never matches anything proves little.
    expect(matched).toBeGreaterThan(500);
  });

  it("control: concatenating raw input into MATCH breaks both properties", () => {
    const search = database(tokenizer);
    let errors = 0;
    let leaks = 0;
    for (const input of INPUTS) {
      try {
        const rows = search.all(`tenant : "t1" AND doc : "d1" AND text : (${input})`);
        if (rows.some((r) => r.tenant !== "t1" || r.doc !== "d1")) leaks++;
      } catch {
        errors++;
      }
    }
    expect(errors).toBeGreaterThan(1_000);
    expect(leaks).toBeGreaterThanOrEqual(3); // the targeted escapes reach other scopes
  });

  it("matches what it should: words, stems where enabled, and accents both ways", () => {
    const search = database(tokenizer);
    const docsFor = (text: string, scope = { tenant: "t2", doc: "d1" }) =>
      search.all(scopedFtsQuery("text", text, scope) ?? "").length;
    expect(docsFor("governing")).toBe(1);
    expect(docsFor("KÜNDIGUNG")).toBe(1); // case-insensitive beyond ASCII
    expect(docsFor("契約")).toBe(1);
    // "é" typed precomposed or as e + combining accent: one word either way.
    expect(ftsQuery("é")).toBe(ftsQuery("é")?.normalize("NFD") ?? null);
    expect(docsFor("é")).toBe(1);
  });
});
