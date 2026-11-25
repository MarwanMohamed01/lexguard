import { describe, expect, it } from "vitest";
import { mergeClauses, type ClausePiece } from "../src";

// Document text for the examples; chunk 0 ends right after "Agreement " (offset 43).
const TEXT =
  "1. Either party may terminate this Agreement " + // chunk 0: 0-45
  "upon 30 days' written notice.\n\n" + //            chunk 1 starts at 45
  "2. This Agreement is governed by the laws of New York. " +
  "Signed by Acme Inc. and Beta LLC.";

const at = (s: string) => TEXT.indexOf(s);
const whitespaceOnly = (from: number, to: number) => /^\s*$/u.test(TEXT.slice(from, to));

function piece(type: string, quote: string, chunk: number, extra: Partial<ClausePiece> = {}) {
  const start = at(quote);
  if (start === -1) throw new Error(`quote not in TEXT: ${quote}`);
  return {
    type,
    start,
    end: start + quote.length,
    chunk,
    parties: [],
    obligations: [],
    dates: [],
    riskFlags: [],
    ...extra,
  } satisfies ClausePiece;
}

describe("mergeClauses", () => {
  it("joins a clause cut by a chunk boundary into one span across both chunks", () => {
    const merged = mergeClauses(
      [
        piece("Termination For Convenience", "Either party may terminate this Agreement", 0),
        piece("Termination For Convenience", "upon 30 days' written notice.", 1),
      ],
      whitespaceOnly,
    );
    expect(merged).toHaveLength(1);
    const [m] = merged;
    expect(TEXT.slice(m?.start, m?.end)).toBe(
      "Either party may terminate this Agreement upon 30 days' written notice.",
    );
    expect(m).toMatchObject({ chunks: [0, 1], pieces: 2 });
  });

  it("joins overlapping quotes of the same type", () => {
    const merged = mergeClauses(
      [
        piece("Governing Law", "governed by the laws of New York", 1),
        piece("Governing Law", "This Agreement is governed by the laws", 1),
      ],
      whitespaceOnly,
    );
    expect(merged.map((m) => TEXT.slice(m.start, m.end))).toEqual([
      "This Agreement is governed by the laws of New York",
    ]);
  });

  it("keeps one copy of a quote seen twice", () => {
    const law = piece("Governing Law", "governed by the laws of New York", 1);
    expect(mergeClauses([law, { ...law }], whitespaceOnly)).toHaveLength(1);
  });

  it("keeps same-type clauses with real text between them apart", () => {
    const merged = mergeClauses(
      [piece("Parties", "Either party", 0), piece("Parties", "Acme Inc. and Beta LLC", 1)],
      whitespaceOnly,
    );
    expect(merged).toHaveLength(2);
  });

  it("never merges different types, even on the same text", () => {
    const quote = "Either party may terminate this Agreement";
    const merged = mergeClauses(
      [piece("Termination For Convenience", quote, 0), piece("Anti-Assignment", quote, 0)],
      whitespaceOnly,
    );
    expect(merged.map((m) => m.type).sort()).toEqual([
      "Anti-Assignment",
      "Termination For Convenience",
    ]);
  });

  it("combines details without duplicates (case-insensitive) and sorts risk flags", () => {
    const [m] = mergeClauses(
      [
        piece("Termination For Convenience", "Either party may terminate this Agreement", 0, {
          parties: ["Acme"],
          obligations: [{ party: "Acme", action: "give notice" }],
          riskFlags: ["short_notice"],
        }),
        piece("Termination For Convenience", "upon 30 days' written notice.", 1, {
          parties: ["ACME", "Beta"],
          obligations: [{ party: "acme", action: "Give notice" }],
          dates: ["30 days"],
          riskFlags: ["one_sided", "short_notice"],
        }),
      ],
      whitespaceOnly,
    );
    expect(m).toMatchObject({
      parties: ["Acme", "Beta"],
      obligations: [{ party: "Acme", action: "give notice" }],
      dates: ["30 days"],
      riskFlags: ["one_sided", "short_notice"],
    });
  });

  it("chains several touching pieces and sorts the result by position", () => {
    const merged = mergeClauses(
      [
        piece("Governing Law", "laws of New York.", 1),
        piece("Termination For Convenience", "Either party", 0),
        piece("Governing Law", "This Agreement is governed by the", 1),
        piece("Governing Law", "governed by the laws", 1),
      ],
      whitespaceOnly,
    );
    expect(merged.map((m) => [m.type, TEXT.slice(m.start, m.end)])).toEqual([
      ["Termination For Convenience", "Either party"],
      ["Governing Law", "This Agreement is governed by the laws of New York."],
    ]);
    expect(merged[1]?.pieces).toBe(3);
  });

  it("drops empty spans and handles no input", () => {
    expect(mergeClauses([], whitespaceOnly)).toEqual([]);
    expect(
      mergeClauses([{ ...piece("Parties", "Acme Inc.", 1), end: at("Acme Inc.") }], whitespaceOnly),
    ).toEqual([]);
  });

  it("is stable: merging its own output again changes nothing", () => {
    const input = [
      piece("Termination For Convenience", "Either party may terminate this Agreement", 0),
      piece("Termination For Convenience", "upon 30 days' written notice.", 1),
      piece("Governing Law", "governed by the laws of New York", 1),
      piece("Parties", "Acme Inc.", 1),
      piece("Parties", "Beta LLC", 1),
    ];
    const once = mergeClauses(input, whitespaceOnly);
    const again = mergeClauses(
      once.map((m) => ({ ...m, chunk: m.chunks[0] ?? 0 })),
      whitespaceOnly,
    );
    expect(again.map((m) => [m.type, m.start, m.end])).toEqual(
      once.map((m) => [m.type, m.start, m.end]),
    );
  });

  it("covers exactly the text its pieces covered, plus only whitespace gaps", () => {
    const input = [
      piece("Termination For Convenience", "Either party may terminate this Agreement", 0),
      piece("Termination For Convenience", "upon 30 days' written notice.", 1),
      piece("Parties", "Acme Inc.", 1),
      piece("Parties", "Beta LLC", 1),
    ];
    for (const m of mergeClauses(input, whitespaceOnly)) {
      for (let i = m.start; i < m.end; i++) {
        const covered = input.some((p) => p.type === m.type && p.start <= i && i < p.end);
        expect(covered || /\s/u.test(TEXT[i] ?? "")).toBe(true);
      }
    }
  });
});

describe("mergeClauses, contained spans", () => {
  it("keeps the group's end at the longest span when a shorter one sits inside it", () => {
    const law = "This Agreement is governed by the laws of New York.";
    const merged = mergeClauses(
      [
        piece("Governing Law", law, 1),
        piece("Governing Law", "governed by", 1), // inside the first
        piece("Governing Law", "Signed by Acme Inc.", 1), // touches the first after a space
      ],
      whitespaceOnly,
    );
    expect(merged.map((m) => TEXT.slice(m.start, m.end))).toEqual([`${law} Signed by Acme Inc.`]);
  });
});
