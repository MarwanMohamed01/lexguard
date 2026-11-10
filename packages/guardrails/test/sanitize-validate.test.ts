import { describe, expect, it } from "vitest";
import { z } from "zod";
import { parseModelOutput, sanitizeText } from "../src/index";

describe("sanitizeText", () => {
  it("keeps normal text, tabs and newlines", () => {
    const text = "1. Definitions\n\tAffiliate means…";
    expect(sanitizeText(text)).toMatchObject({ text, suspicious: false });
  });

  it("counts what it removed by kind", () => {
    const result = sanitizeText("a\u200Bb\u0007c");
    expect(result.text).toBe("abc");
    expect(result.removed).toEqual({
      zero_width: 1,
      bidi_control: 0,
      tag_char: 0,
      control_char: 1,
    });
  });

  it("normalizes to NFC without rewriting compatibility characters", () => {
    expect(sanitizeText("café").text).toBe("café");
    expect(sanitizeText("ﬁnal m²").text).toBe("ﬁnal m²");
  });
});

const Clause = z.strictObject({
  type: z.enum(["termination", "liability", "confidentiality"]),
  risk: z.enum(["low", "medium", "high"]),
});

describe("parseModelOutput", () => {
  it("accepts plain JSON", () => {
    expect(parseModelOutput(Clause, '{"type":"liability","risk":"high"}')).toEqual({
      ok: true,
      data: { type: "liability", risk: "high" },
    });
  });

  it("accepts JSON inside a ```json fence or surrounded by prose", () => {
    const fenced = '```json\n{"type":"termination","risk":"low"}\n```';
    const prose = 'Sure! Here is the result: {"type":"termination","risk":"low"} Hope it helps.';
    expect(parseModelOutput(Clause, fenced).ok).toBe(true);
    expect(parseModelOutput(Clause, prose).ok).toBe(true);
  });

  it("reports not_json", () => {
    expect(parseModelOutput(Clause, "I think it is risky")).toMatchObject({
      ok: false,
      reason: "not_json",
    });
  });

  it("reports schema failures with field paths", () => {
    const result = parseModelOutput(Clause, '{"type":"liability","risk":"kinda high"}');
    expect(result).toMatchObject({ ok: false, reason: "schema" });
    expect(!result.ok && result.issues[0]).toMatch(/^risk:/);
  });

  it("rejects oversized output before parsing it", () => {
    const huge = `{"type":"liability","risk":"high","pad":"${"x".repeat(200)}"}`;
    expect(parseModelOutput(Clause, huge, { maxChars: 100 })).toMatchObject({
      ok: false,
      reason: "too_large",
    });
  });
});
