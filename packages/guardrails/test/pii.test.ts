import { describe, expect, it } from "vitest";
import {
  findPii,
  ibanValid,
  luhnValid,
  redactPii,
  restorePii,
  type PhoneRegion,
} from "../src/index";

// Public test values: 4111 1111 1111 1111 is a standard test card number; the IBANs are
// the examples published in the IBAN standard documentation.
const CARD = "4111 1111 1111 1111";
const IBAN_GB = "GB82 WEST 1234 5698 7654 32";

describe("luhnValid", () => {
  it.each([
    ["4111111111111111", true],
    ["79927398713", true],
    ["4111111111111112", false],
    ["12a4", false],
    ["", false],
  ])("%s → %s", (digits, expected) => {
    expect(luhnValid(digits)).toBe(expected);
  });
});

describe("ibanValid", () => {
  it.each([
    [IBAN_GB, true],
    ["DE89370400440532013000", true],
    ["gb82 west 1234 5698 7654 32", true],
    ["GB82 WEST 1234 5698 7654 33", false],
    ["GB82", false],
  ])("%s → %s", (iban, expected) => {
    expect(ibanValid(iban)).toBe(expected);
  });
});

describe("findPii", () => {
  it("finds each supported type", () => {
    const text = `Contact jane.doe@acme.co.uk or +44 20 7946 0958. Pay to ${IBAN_GB} Card ${CARD}.`;

    expect(findPii(text).map((m) => [m.type, m.value])).toEqual([
      ["EMAIL", "jane.doe@acme.co.uk"],
      ["PHONE", "+44 20 7946 0958"],
      ["IBAN", IBAN_GB],
      ["CARD", CARD],
    ]);
  });

  const phonesIn = (text: string, phoneRegions: PhoneRegion[] = []) =>
    findPii(text, { types: ["PHONE"], phoneRegions }).map((m) => m.value);

  it.each([
    ["UK", "+44 20 7946 0958"],
    ["Egypt", "+20 2 2795 1234"],
    ["France", "+33 1 23 45 67 89"],
    ["US", "+1 213-373-4253"],
    ["Germany", "+49 30 901820"],
  ])("finds an international %s number with no configuration", (_label, phone) => {
    expect(findPii(`Call ${phone} today`)).toEqual([
      { type: "PHONE", start: 5, end: 5 + phone.length, value: phone },
    ]);
  });

  it.each<[string, PhoneRegion, string]>([
    ["UK", "GB", "020 7946 0958"],
    ["Egypt", "EG", "02 2795 1234"],
    ["US", "US", "(213) 373-4253"],
  ])("finds a national %s number only when that region is configured", (_label, region, phone) => {
    const text = `Call ${phone} today`;
    expect(phonesIn(text)).toEqual([]);
    expect(phonesIn(text, [region])).toEqual([phone]);
  });

  it("checks several configured regions in one call", () => {
    expect(phonesIn("UK 020 7946 0958, US (213) 373-4253", ["GB", "US"])).toEqual([
      "020 7946 0958",
      "(213) 373-4253",
    ]);
  });

  it("includes an extension in the redacted span", () => {
    expect(phonesIn("Call (213) 373-4253 ext. 1234 now", ["US"])).toEqual([
      "(213) 373-4253 ext. 1234",
    ]);
  });

  it("never lets a phone match run across a line break", () => {
    expect(phonesIn("Tel +1 213 373 4253.\n3. Term")).toEqual(["+1 213 373 4253"]);
  });

  it.each([
    ["company number", "company number 01234567"],
    ["register entry", "register entry 0123456789"],
    ["social security number shape", "ref 123-45-6789"],
    ["ISO date", "on 2026-11-10"],
    ["clause numbers", "Sections 12.3.4 and 14.1.2.7"],
    ["amount", "EUR 1,250,000.00"],
  ])("does not treat a %s as a phone, even with regions configured", (_label, text) => {
    expect(phonesIn(text, ["GB", "US", "EG"])).toEqual([]);
  });

  it("ignores contract numbers, amounts and dates", () => {
    const text =
      "Section 12.3.4: fee EUR 1,250,000.00, dated 2026-11-10, ref 4111111111111112, clause 2048.";
    expect(findPii(text)).toEqual([]);
  });

  it("can be limited to some types", () => {
    const text = `jane@acme.com ${CARD}`;
    expect(findPii(text, { types: ["CARD"] }).map((m) => m.type)).toEqual(["CARD"]);
  });
});

describe("redactPii / restorePii", () => {
  it("replaces values with stable placeholders and restores them", () => {
    const text = "Email jane@acme.com, cc jane@acme.com and bob@acme.com.";
    const redaction = redactPii(text);

    expect(redaction.text).toBe("Email [EMAIL_1], cc [EMAIL_1] and [EMAIL_2].");
    expect(redaction.counts.EMAIL).toBe(3);
    expect(redaction.mapping.size).toBe(2);
    expect(restorePii(redaction.text, redaction.mapping)).toBe(text);
  });

  it("restores placeholders the model reuses in its own output", () => {
    const { mapping } = redactPii("Notices to legal@acme.com");
    expect(restorePii("Clause 9 sends notices to [EMAIL_1].", mapping)).toBe(
      "Clause 9 sends notices to legal@acme.com.",
    );
  });

  it("leaves text without PII unchanged", () => {
    const text = "The Supplier shall deliver within 30 days.";
    expect(redactPii(text)).toMatchObject({ text, mapping: new Map() });
  });
});
