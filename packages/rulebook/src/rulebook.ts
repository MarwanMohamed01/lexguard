// The rulebook: pinned public rule texts, each split into citable rules with exact offsets
// (M5 step 3, D45). Example:
//   getRule(gdpr, "gdpr:28(3)(a)") -> { id, article: "28", title: "Processor", start, end }
//   ruleText(gdpr, rule)           -> "processes the personal data only on documented ..."
// A checker's rule quote is accepted only if it is found inside ruleText (step 6, verifier).
import { z } from "zod";

export interface RuleSource {
  /** Short ID used as the rule-ID prefix, e.g. "gdpr". */
  id: string;
  title: string;
  /** Where the source text was downloaded from (pinned). */
  url: string;
  /** SHA-256 of the downloaded bytes the text was built from. */
  sourceSha256: string;
  licence: string;
  /** Attribution and the changes we made, as the licence asks. */
  attribution: string;
}

export interface Rule {
  /** Stable, citable ID: "gdpr:28(3)(a)", "gdpr:28(3)/2" (second subparagraph), "nda:11". */
  id: string;
  /** Article (or hypothesis) number as printed. */
  article: string;
  /** Article heading or short description, e.g. "Processor". */
  title: string;
  /** [start, end) in the rulebook's text. */
  start: number;
  end: number;
}

export interface Rulebook {
  source: RuleSource;
  text: string;
  rules: Rule[];
}

const RulebookFile = z.object({
  source: z.object({
    id: z.string().regex(/^[a-z][a-z0-9-]*$/),
    title: z.string().min(1),
    url: z.url(),
    sourceSha256: z.string().regex(/^[0-9a-f]{64}$/),
    licence: z.string().min(1),
    attribution: z.string().min(1),
  }),
  text: z.string(),
  rules: z.array(
    z.object({
      id: z.string().min(1),
      article: z.string().min(1),
      title: z.string(),
      start: z.number().int(),
      end: z.number().int(),
    }),
  ),
});

/**
 * Validates a rulebook file. Besides the shape: IDs unique and prefixed with the source ID,
 * offsets in range, non-empty, in order and not overlapping, so every rule is a distinct
 * piece of the text.
 */
export function parseRulebook(raw: unknown): Rulebook {
  const book = RulebookFile.parse(raw);
  const seen = new Set<string>();
  let previousEnd = 0;
  for (const rule of book.rules) {
    if (!rule.id.startsWith(`${book.source.id}:`)) throw new Error(`${rule.id}: wrong prefix`);
    if (seen.has(rule.id)) throw new Error(`${rule.id}: duplicate ID`);
    seen.add(rule.id);
    if (rule.start < previousEnd || rule.end <= rule.start || rule.end > book.text.length) {
      throw new Error(`${rule.id}: offsets out of order or range`);
    }
    if (book.text.slice(rule.start, rule.end).trim() === "") throw new Error(`${rule.id}: empty`);
    previousEnd = rule.end;
  }
  return book;
}

export function getRule(book: Rulebook, id: string): Rule | undefined {
  return book.rules.find((r) => r.id === id);
}

export function ruleText(book: Rulebook, rule: Rule): string {
  return book.text.slice(rule.start, rule.end);
}

/** Every rule of one article, in order: rulesOfArticle(gdpr, "28") -> 28(1), 28(2), ... */
export function rulesOfArticle(book: Rulebook, article: string): Rule[] {
  return book.rules.filter((r) => r.article === article);
}
