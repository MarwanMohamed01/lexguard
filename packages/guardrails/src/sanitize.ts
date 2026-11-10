// Threat model T2: attackers hide instructions in characters a human reviewer cannot see
// but a model still reads. Sanitize document text once, at ingestion, before chunking:
// citation offsets then refer to the sanitized text that is stored.

export type HiddenCharKind = "zero_width" | "bidi_control" | "tag_char" | "control_char";

export interface SanitizeResult {
  text: string;
  removed: Readonly<Record<HiddenCharKind, number>>;
  // True when characters with no legitimate use in a contract were found. Ingestion should
  // flag such documents for the red-team log rather than silently accept them.
  suspicious: boolean;
}

/* eslint-disable no-control-regex -- these patterns exist to match control characters */
const HIDDEN_CHARS: readonly (readonly [HiddenCharKind, RegExp])[] = [
  // Zero-width space/joiners, word joiner, BOM, Mongolian vowel separator, soft hyphen.
  ["zero_width", /[\u200B-\u200D\u2060\uFEFF\u180E\u00AD]/gu],
  // Bidirectional overrides and isolates ("Trojan Source"): reorder how text is displayed.
  ["bidi_control", /[\u202A-\u202E\u2066-\u2069\u200E\u200F\u061C]/gu],
  // Unicode tag characters: an invisible copy of ASCII, used for "ASCII smuggling".
  ["tag_char", /[\u{E0000}-\u{E007F}]/gu],
  // C0/C1 control characters, except tab, line feed and carriage return.
  ["control_char", /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/gu],
];
/* eslint-enable no-control-regex */

export function sanitizeText(input: string): SanitizeResult {
  // NFC only joins equivalent forms (e + accent → é). We avoid NFKC: it rewrites
  // characters like "ﬁ" or "²", which can change the meaning of legal text.
  let text = input.normalize("NFC");
  const removed: Record<HiddenCharKind, number> = {
    zero_width: 0,
    bidi_control: 0,
    tag_char: 0,
    control_char: 0,
  };
  for (const [kind, pattern] of HIDDEN_CHARS) {
    text = text.replace(pattern, () => {
      removed[kind]++;
      return "";
    });
  }
  return { text, removed, suspicious: removed.tag_char > 0 || removed.bidi_control > 0 };
}
