import { findPhoneNumbersInText, type CountryCode } from "libphonenumber-js/max";

// Threat model T12: limit personal data sent to third-party model providers.
// Detected values are swapped for placeholders like [EMAIL_1] before a model call, and
// restored afterwards.
//
// Every detector is country-neutral: emails, IBANs (ISO 13616) and card numbers (Luhn) are
// international formats, and phone numbers use Google's libphonenumber metadata for ~240
// regions instead of hand-written country patterns. Checksums keep clause numbers and amounts
// from being mistaken for card or bank numbers.
//
// Known limit: regex cannot reliably find people's names; that needs an ML model (NER),
// too heavy for a Worker's CPU budget. The PII evals measure what we do and do not catch.

export type PiiType = "EMAIL" | "IBAN" | "CARD" | "PHONE";

export const PII_TYPES: readonly PiiType[] = ["EMAIL", "IBAN", "CARD", "PHONE"];

// ISO 3166-1 alpha-2 region code, e.g. "EG", "GB", "US".
export type PhoneRegion = CountryCode;

export interface PiiOptions {
  types?: readonly PiiType[];
  // Regions whose national phone formats to recognise (numbers written without "+").
  // International "+..." numbers are always recognised, for every region. This is
  // configuration (e.g. per tenant or document), not code: no country is built in.
  phoneRegions?: readonly PhoneRegion[];
  // "valid": the number must fall in a currently allocated range of a region's numbering plan.
  // "possible": it only needs a plausible length for the region, so new, outdated or unusual
  // numbers are still redacted, at the cost of more false alarms.
  phoneMatching?: PhoneMatching;
}

export type PhoneMatching = "valid" | "possible";

export interface PiiMatch {
  type: PiiType;
  start: number;
  end: number;
  value: string;
}

export interface Redaction {
  text: string;
  // placeholder → original value, needed by restorePii. Keep it server-side only.
  mapping: ReadonlyMap<string, string>;
  counts: Readonly<Record<PiiType, number>>;
}

// Card numbers: the last digit is a checksum over the others.
export function luhnValid(digits: string): boolean {
  if (!/^\d{2,}$/.test(digits)) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let digit = digits.charCodeAt(i) - 48;
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

// IBAN (ISO 13616): move the first 4 chars to the end, letters → numbers (A=10…Z=35),
// and the resulting number mod 97 must be 1. Computed digit by digit to avoid big integers.
export function ibanValid(input: string): boolean {
  const iban = input.replace(/\s+/g, "").toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(iban)) return false;
  let remainder = 0;
  for (const char of iban.slice(4) + iban.slice(0, 4)) {
    const code = char.charCodeAt(0);
    const value = code >= 65 ? String(code - 55) : char;
    for (const digit of value) remainder = (remainder * 10 + Number(digit)) % 97;
  }
  return remainder === 1;
}

const digitsOf = (value: string) => value.replace(/\D/g, "");

// Issuer prefixes of payment cards (ISO/IEC 7812): 3 (Amex, Diners, JCB), 4 (Visa),
// 5 (Mastercard, Maestro), 6 (Discover, UnionPay, Maestro), 2221-2720 (Mastercard 2-series).
// Rejects reference numbers such as patent numbers "2015109813242" that pass Luhn by chance.
const CARD_ISSUER = /^(?:[3-6]|2(?:22[1-9]|2[3-9]\d|[3-6]\d\d|7[01]\d|720))/;

interface RegexDetector {
  type: PiiType;
  pattern: RegExp;
  accept: (value: string) => boolean;
}

const REGEX_DETECTORS: readonly RegexDetector[] = [
  {
    type: "EMAIL",
    pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g,
    accept: () => true,
  },
  {
    type: "IBAN",
    // Groups of 4 (how IBANs are written) so the match stops at the IBAN's end instead of
    // swallowing a following capitalised word, which would then fail the checksum.
    pattern: /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,4})?\b/g,
    accept: ibanValid,
  },
  {
    // Card numbers are printed in standard layouts (ISO/IEC 7812 conventions): compact,
    // groups of 4, or 4-6-5 / 4-6-4 (Amex, Diners). Allowing a space between any digits made
    // rows of table figures ("62 23 78 21 11 41 133 42") match and pass Luhn by chance.
    type: "CARD",
    // The separator is captured once and reused (\1, \2), so "4111 1111-1111 1111" is rejected.
    pattern:
      /\b(?:\d{13,19}|\d{4}([ -])\d{4}(?:\1\d{4}){1,2}(?:\1\d{1,4})?|\d{4}([ -])\d{6}\2\d{4,5})\b/g,
    accept: (value) => {
      const digits = digitsOf(value);
      return (
        digits.length >= 13 && digits.length <= 19 && CARD_ISSUER.test(digits) && luhnValid(digits)
      );
    },
  },
];

// Country-neutral shapes that are never phone numbers in a document, whatever the region.
// libphonenumber alone accepts some of them (e.g. "1379.50" or "04.04.2016" as a possible
// number), which would redact prices and deadlines in contracts.
const NOT_A_PHONE: readonly RegExp[] = [
  /^\d{1,4}[./-]\d{1,2}[./-]\d{1,4}$/, // dates: 04.04.2016, 2026-11-10, 31/12/2029
  /^\d{1,4}[./-]\d{1,2}[./-]\d{1,4}[ T]\d{1,2}(?::\d{2})?$/, // date + hour: 2023-03-14 12
  /^\d{1,3}(?:\.\d{1,3}){3}$/, // IPv4 addresses: 66.12.77.156
  /^\d{8}$/, // compact dates such as 20230501 (and other bare 8-digit references)
  /^\d+[.,]\d{1,2}$/, // amounts with cents: 650.00, 1379,50
  /^\d{1,3}(?:[.,\s]\d{3})+(?:[.,]\d{1,2})?$/, // grouped amounts: 1,250,000.00
  /^\d+\.\d+$/, // any plain decimal: 89.8062105
];

// A number without "+" and without any separator (5635402307, 01234567) is indistinguishable
// from an account, customer or company number, so it is not treated as a phone.
const hasStructure = (value: string) => value.startsWith("+") || /\d[\s().-]+\d/.test(value);

const looksLikePhone = (value: string) =>
  hasStructure(value) && !NOT_A_PHONE.some((pattern) => pattern.test(value));

// One pass with no region finds international numbers; one pass per configured region adds
// that region's national formats, using Google's metadata, then the shape filter above.
function findPhones(
  text: string,
  regions: readonly PhoneRegion[],
  matching: PhoneMatching,
): PiiMatch[] {
  const passes: (PhoneRegion | undefined)[] = regions.length > 0 ? [...regions] : [undefined];
  const extended = matching === "possible";
  const seen = new Set<string>();
  const matches: PiiMatch[] = [];
  for (const region of passes) {
    const options = region === undefined ? { extended } : { defaultCountry: region, extended };
    for (const found of findPhoneNumbersInText(text, options)) {
      const key = `${String(found.startsAt)}:${String(found.endsAt)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const value = text.slice(found.startsAt, found.endsAt);
      if (!looksLikePhone(value)) continue;
      matches.push({ type: "PHONE", start: found.startsAt, end: found.endsAt, value });
    }
  }
  return matches;
}

export function findPii(text: string, options: PiiOptions = {}): PiiMatch[] {
  const types = options.types ?? PII_TYPES;
  const candidates: PiiMatch[] = [];
  for (const detector of REGEX_DETECTORS) {
    if (!types.includes(detector.type)) continue;
    for (const match of text.matchAll(detector.pattern)) {
      const value = match[0];
      if (!detector.accept(value)) continue;
      candidates.push({
        type: detector.type,
        start: match.index,
        end: match.index + value.length,
        value,
      });
    }
  }
  if (types.includes("PHONE")) {
    const matching = options.phoneMatching ?? "valid";
    candidates.push(...findPhones(text, options.phoneRegions ?? [], matching));
  }

  // Resolve overlaps: earliest match wins, longer match wins on a tie.
  candidates.sort((a, b) => a.start - b.start || b.end - a.end);
  const result: PiiMatch[] = [];
  let lastEnd = -1;
  for (const candidate of candidates) {
    if (candidate.start < lastEnd) continue;
    result.push(candidate);
    lastEnd = candidate.end;
  }
  return result;
}

const PLACEHOLDER = /\[(EMAIL|IBAN|CARD|PHONE)_(\d+)\]/g;

export function redactPii(text: string, options: PiiOptions = {}): Redaction {
  // If the input already contains placeholder-like text (e.g. an attacker writes "[EMAIL_1]"),
  // start numbering above it, so restorePii can never swap a real value into attacker text.
  let counter = 0;
  for (const match of text.matchAll(PLACEHOLDER)) {
    counter = Math.max(counter, Number(match[2]));
  }

  const placeholderFor = new Map<string, string>(); // "TYPE:value" → placeholder
  const mapping = new Map<string, string>();
  const counts: Record<PiiType, number> = { EMAIL: 0, IBAN: 0, CARD: 0, PHONE: 0 };
  let out = "";
  let cursor = 0;

  for (const match of findPii(text, options)) {
    const key = `${match.type}:${match.value}`;
    let placeholder = placeholderFor.get(key);
    if (placeholder === undefined) {
      placeholder = `[${match.type}_${String(++counter)}]`;
      placeholderFor.set(key, placeholder);
      mapping.set(placeholder, match.value);
    }
    counts[match.type]++;
    out += text.slice(cursor, match.start) + placeholder;
    cursor = match.end;
  }
  out += text.slice(cursor);

  return { text: out, mapping, counts };
}

export function restorePii(text: string, mapping: ReadonlyMap<string, string>): string {
  return text.replace(PLACEHOLDER, (placeholder) => mapping.get(placeholder) ?? placeholder);
}
