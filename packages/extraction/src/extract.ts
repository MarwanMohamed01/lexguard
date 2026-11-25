import {
  parseModelOutput,
  redactPii,
  restorePii,
  type ParseFailureReason,
} from "@lexguard/guardrails";
import { buildPrompt, PROMPT_VERSION, type Prompt } from "./prompt";
import { ExtractedClause, ExtractionEnvelope } from "./schema";

// One extractor call on one chunk (M4 step 3):
//   [redact PII] -> prompt -> model -> JSON + envelope check -> each clause checked alone ->
//   [put PII back] -> quote must be in the ORIGINAL chunk verbatim -> exact offsets.
// The model is a parameter, so the same code runs with Ollama (evals), Workers AI (the
// Worker) and fakes (tests).

export type Model = (prompt: Prompt) => Promise<string>;

export interface ExtractOptions {
  /** Fresh random letters/digits for the document wrapper (see buildPrompt). */
  nonce: string;
  /** Replace emails, phones, IBANs and cards with placeholders before the model sees the
   * text. For providers outside Cloudflare (T12); quotes are restored before checking. */
  redact?: boolean;
}

/** An accepted clause, with its quote's position inside the chunk (UTF-16 offsets). */
export interface AcceptedClause extends ExtractedClause {
  start: number;
  end: number;
}

export interface Rejections {
  /** Did not match the form (unknown type, missing quote, too long...). */
  invalid: number;
  /** Quote not in the chunk, even ignoring whitespace. */
  quoteNotFound: number;
  /** Same type and quote as an earlier entry. */
  duplicate: number;
}

export type ExtractionResult =
  | {
      ok: true;
      promptVersion: string;
      clauses: AcceptedClause[];
      rejected: Rejections;
      /** Accepted clauses whose quote matched only with whitespace ignored (see locateQuote). */
      relocated: number;
      redacted: number;
    }
  | { ok: false; promptVersion: string; reason: ParseFailureReason; message: string };

const MAX_OUTPUT_CHARS = 60_000;

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

/**
 * Where `quote` is in `text`: verbatim first; otherwise the first passage that matches it
 * when every run of whitespace may differ (a line break for a space, two spaces for one...).
 * Found in step 4: 9 of gpt-oss-20b's 13 unfound quotes differed from the contract only in
 * whitespace. The returned span is the CONTRACT's text, never the model's: the model's quote
 * only finds the passage, so what is stored and cited is still exactly the document (T3).
 * Every other difference (a word, a letter, a comma, letter case) still fails. A blank quote
 * fails: it would match anywhere. The pattern is literal words joined by \s+, so matching is
 * linear (no nested quantifiers to backtrack on).
 */
export function locateQuote(
  text: string,
  quote: string,
): { start: number; end: number; exact: boolean } | null {
  const words = quote.split(/\s+/u).filter((w) => w.length > 0);
  if (words.length === 0) return null;
  const at = text.indexOf(quote);
  if (at !== -1) return { start: at, end: at + quote.length, exact: true };
  const match = new RegExp(words.map(escapeRegExp).join("\\s+"), "u").exec(text);
  return match === null
    ? null
    : { start: match.index, end: match.index + match[0].length, exact: false };
}

export async function extractClauses(
  chunkText: string,
  model: Model,
  options: ExtractOptions,
): Promise<ExtractionResult> {
  const redaction = options.redact === true ? redactPii(chunkText) : null;
  const sent = redaction?.text ?? chunkText;
  const raw = await model(buildPrompt(sent, options.nonce));

  const envelope = parseModelOutput(ExtractionEnvelope, raw, { maxChars: MAX_OUTPUT_CHARS });
  if (!envelope.ok) {
    return {
      ok: false,
      promptVersion: PROMPT_VERSION,
      reason: envelope.reason,
      message: envelope.message,
    };
  }

  const restore = (s: string) => (redaction === null ? s : restorePii(s, redaction.mapping));
  const rejected: Rejections = { invalid: 0, quoteNotFound: 0, duplicate: 0 };
  const clauses: AcceptedClause[] = [];
  const seen = new Set<string>();
  let relocated = 0;

  for (const entry of envelope.data.clauses) {
    const parsed = ExtractedClause.safeParse(entry);
    if (!parsed.success) {
      rejected.invalid++;
      continue;
    }
    const c = parsed.data;
    const clause: ExtractedClause = {
      ...c,
      quote: restore(c.quote),
      parties: c.parties.map(restore),
      obligations: c.obligations.map((o) => ({
        party: restore(o.party),
        action: restore(o.action),
      })),
      dates: c.dates.map(restore),
    };
    // The check is against the original chunk, never the text the model saw (T3).
    const found = locateQuote(chunkText, clause.quote);
    if (found === null) {
      rejected.quoteNotFound++;
      continue;
    }
    // From here on the quote IS the document's text at that position.
    const quote = chunkText.slice(found.start, found.end);
    const key = `${clause.clauseType}\u0000${quote}`;
    if (seen.has(key)) {
      rejected.duplicate++;
      continue;
    }
    seen.add(key);
    if (!found.exact) relocated++;
    clauses.push({ ...clause, quote, start: found.start, end: found.end });
  }

  return {
    ok: true,
    promptVersion: PROMPT_VERSION,
    clauses,
    rejected,
    relocated,
    redacted: redaction === null ? 0 : redaction.mapping.size,
  };
}
