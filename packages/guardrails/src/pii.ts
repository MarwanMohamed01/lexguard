// Threat model T12: limit personal data sent to third-party model providers.
// Detected values are swapped for placeholders like [EMAIL_1] before a model call, and
// restored afterwards. Patterns are paired with checksums (Luhn, IBAN mod-97) so clause
// numbers and amounts are not mistaken for card or bank numbers.
//
// Known limit: regex cannot reliably find people's names; that needs an ML model (NER),
// too heavy for a Worker's CPU budget. The PII eval measures what we do and do not catch.

export type PiiType = "EMAIL" | "IBAN" | "CARD" | "PHONE";

export const PII_TYPES: readonly PiiType[] = ["EMAIL", "IBAN", "CARD", "PHONE"];

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

interface Detector {
  type: PiiType;
  pattern: RegExp;
  accept: (value: string) => boolean;
}

const DETECTORS: readonly Detector[] = [
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
    type: "CARD",
    pattern: /\b(?:\d[ -]?){12,18}\d\b/g,
    accept: (value) => {
      const digits = digitsOf(value);
      return digits.length >= 13 && digits.length <= 19 && luhnValid(digits);
    },
  },
  {
    // International (+44 20 7946 0958) or national with a leading 0 (020 7946 0958).
    // Dates such as 2026-11-10 never start with + or 0, so they are not matched.
    type: "PHONE",
    pattern: /\+\d[\d\s().-]{6,}\d|\b0\d{1,4}[\s.-]?\d{3,4}[\s.-]?\d{3,4}\b/g,
    accept: (value) => {
      const count = digitsOf(value).length;
      return count >= 8 && count <= 15;
    },
  },
];

export function findPii(text: string, types: readonly PiiType[] = PII_TYPES): PiiMatch[] {
  const candidates: PiiMatch[] = [];
  for (const detector of DETECTORS) {
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

export function redactPii(text: string, types: readonly PiiType[] = PII_TYPES): Redaction {
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

  for (const match of findPii(text, types)) {
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
