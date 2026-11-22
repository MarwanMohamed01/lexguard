import { describe, expect, it } from "vitest";
import { chunkDocument, detectWindow, planChunks, planWindows } from "../src/index";

const windowed = (text: string, size: number) =>
  planChunks(
    text,
    planWindows(text, size).map((w) => detectWindow(text, w)),
  );

describe("planWindows", () => {
  it("covers the text exactly, each window starting at a line start", () => {
    const text = "line one\nline two\nline three\nline four\n";
    const windows = planWindows(text, 10);

    expect(windows[0]?.from).toBe(0);
    expect(windows.at(-1)?.to).toBe(text.length);
    for (let i = 1; i < windows.length; i++) {
      expect(windows[i]?.from).toBe(windows[i - 1]?.to);
      expect(text[(windows[i]?.from ?? 0) - 1]).toBe("\n");
    }
  });

  it("keeps a text without line breaks as one window", () => {
    expect(planWindows("x".repeat(1000), 100)).toEqual([{ from: 0, to: 1000 }]);
  });

  it("returns no windows for empty text, and rejects a bad size", () => {
    expect(planWindows("")).toEqual([]);
    expect(() => planWindows("abc", 0)).toThrow(RangeError);
  });

  it("refuses a window that does not start at a line start", () => {
    expect(() => detectWindow("abc\ndef", { from: 1, to: 7 })).toThrow(RangeError);
  });
});

describe("windowed detection gives the same chunks as one pass", () => {
  const contract = [
    "MASTER AGREEMENT",
    "",
    "1. Definitions",
    '"Affiliate" means any entity that controls a Party.',
    '"Territory" shall mean the United States.',
    "2. Term",
    "2.1 Initial Term. This Agreement starts on the Effective Date.",
    "2.2 Renewal. It renews (a) yearly; (b) unless terminated.",
    "ARTICLE 3",
    "PAYMENT",
    "3.1 Fees. As set out in Section 2.1 above.",
    "9. PROPRIETARY MARKS 9.1 Use of Marks. Licensee may use the marks.",
    "# Background",
    "EXHIBIT A",
    "1. Scope",
  ].join("\n");

  it.each([1, 7, 20, 64, 200])("with windows of %i chars on a small contract", (size) => {
    expect(windowed(contract, size)).toEqual(chunkDocument(contract));
  });

  it("when a heading's look-ahead crosses the window edge through a long whitespace run", () => {
    // "7.1" is a heading only because "Title" follows after 5,000 spaces and newlines.
    const text = `7. Start\nIntro.\n7.1${" \n".repeat(2_500)}Title. Body text.\n7.2 Next. More.\n`;
    const size = text.indexOf("7.1") + 1;

    expect(windowed(text, size)).toEqual(chunkDocument(text));
  });

  it("on generated contract-like text, at many window sizes", () => {
    let seed = 7;
    const random = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed / 2_147_483_648;
    };
    const pieces = [
      "\n",
      "\n\n",
      ". ",
      "ARTICLE ",
      "Section ",
      "EXHIBIT B\n",
      "# Heading\n",
      "(a) ",
      "(iv) ",
      '"Term" means ',
      "the Supplier shall deliver ",
      "WITHIN 30 DAYS ",
      "Title",
      "   ",
    ];
    let text = "";
    let clause = 1;
    while (text.length < 20_000) {
      const roll = random();
      if (roll < 0.08) text += `\n${String(clause++)}. Clause Title\n`;
      else if (roll < 0.16) text += `${String(clause)}.${String(Math.ceil(random() * 9))} `;
      else text += pieces[Math.floor(random() * pieces.length)] ?? "";
    }
    const whole = chunkDocument(text);

    for (const size of [50, 333, 1_000, 4_096, 9_999]) {
      expect(windowed(text, size)).toEqual(whole);
    }
  });
});
