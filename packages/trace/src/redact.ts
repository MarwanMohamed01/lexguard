import type { AttributeValue } from "./schema";

// Traces must never store secrets (threat model T13). Every string that enters a span
// (names, attribute values, error messages) passes through a Redactor first.
export type Redactor = (text: string) => string;

export const REDACTED = "[REDACTED]";

// Well-known token shapes, replaced wherever they appear in a string.
const TOKEN_PATTERNS: readonly RegExp[] = [
  /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi,
  /\bsk-[A-Za-z0-9_-]{16,}/g, // OpenAI / Anthropic style API keys
  /\bgsk_[A-Za-z0-9]{20,}/g, // Groq API keys
  /\bAIza[0-9A-Za-z_-]{35}\b/g, // Google API keys
  /\bgh[pousr]_[A-Za-z0-9]{30,}/g, // GitHub tokens
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key IDs
];

// `password=hunter22`, `"api_key": "abc123..."`: keep the key, hide the value.
const KEY_VALUE =
  /\b(api[_-]?key|secret|token|password|passwd|authorization)(["']?\s*[:=]\s*["']?)([^\s"',;}]{6,})/gi;

// Attribute keys whose value is always hidden, whatever it looks like.
// `token` only matches as a whole word or suffix, so `inputTokens` is not redacted.
const SENSITIVE_KEY = /(api[_-]?key|secret|password|passwd|authorization|cookie)|(^|[_-])token$/i;

// Specific token shapes run first: otherwise `Authorization: Bearer abc` would have only
// the word "Bearer" replaced by the generic key=value rule, leaving the token exposed.
export const scrubSecrets: Redactor = (text) => {
  let out = text;
  for (const pattern of TOKEN_PATTERNS) {
    out = out.replace(pattern, REDACTED);
  }
  return out.replace(KEY_VALUE, (_match, key: string, separator: string) => {
    return `${key}${separator}${REDACTED}`;
  });
};

export function redactAttribute(
  key: string,
  value: AttributeValue,
  redact: Redactor,
): AttributeValue {
  if (SENSITIVE_KEY.test(key)) return REDACTED;
  return typeof value === "string" ? redact(value) : value;
}
