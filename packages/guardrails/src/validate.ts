import type { z } from "zod";

// Every model output must match a Zod schema before anything uses it (threat model T1:
// even a fooled model can only produce well-formed data). Failures are returned, not
// thrown, because the router treats "schema" failures as a reason to escalate.

export type ParseFailureReason = "too_large" | "not_json" | "schema";

export type ParseResult<T> =
  | { ok: true; data: T }
  | { ok: false; reason: ParseFailureReason; message: string; issues: readonly string[] };

export interface ParseOptions {
  maxChars?: number;
}

const DEFAULT_MAX_CHARS = 100_000;
const MAX_ISSUES = 10;

export function parseModelOutput<T>(
  schema: z.ZodType<T>,
  raw: string,
  options: ParseOptions = {},
): ParseResult<T> {
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  if (raw.length > maxChars) {
    return fail("too_large", `output is ${String(raw.length)} chars, limit is ${String(maxChars)}`);
  }

  let value: unknown;
  try {
    value = JSON.parse(extractJson(raw));
  } catch {
    return fail("not_json", "output is not valid JSON");
  }

  const result = schema.safeParse(value);
  if (result.success) return { ok: true, data: result.data };

  const issues = result.error.issues
    .slice(0, MAX_ISSUES)
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`);
  return fail("schema", "output does not match the schema", issues);
}

// Models often wrap JSON in ```json fences or add a sentence around it.
function extractJson(raw: string): string {
  const text = raw.trim();
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n?```$/i.exec(text);
  if (fenced?.[1] !== undefined) return fenced[1];
  if (text.startsWith("{") || text.startsWith("[")) return text;
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  return first !== -1 && last > first ? text.slice(first, last + 1) : text;
}

function fail<T>(
  reason: ParseFailureReason,
  message: string,
  issues: readonly string[] = [],
): ParseResult<T> {
  return { ok: false, reason, message, issues };
}
