// Section cross-references (M5 step 6, D50; open since D40): "as set out in Section 5.3".
//
//   findSectionReferences("subject to Sections 3, 4 and 9.1(b)")
//     -> Section 3, Section 4, Section 9.1 (point "(b)"), each with its exact offsets
//   resolveReference(ref, sections) -> the chunker's section numbered 9.1, or null
//
// A reference to another document ("Section 11.5 of the Supply Agreement") is marked
// external and never resolved inside this one. Measured on 510 CUAD contracts before
// building: 14,199 references in 419 contracts; about 5% point to another document.
import { parseClauseNumber, type Section } from "@lexguard/chunker";

export interface SectionReference {
  /** [start, end) of the reference in the text, e.g. "Section 9.1(b)" or just "4" in a list. */
  start: number;
  end: number;
  /** "section" | "clause" | "article" | "paragraph". */
  kind: string;
  /** [9, 1] for 9.1; roman numerals too: "Article IV" -> [4]. */
  number: readonly number[];
  /** A trailing point such as "(b)" or "(a)(ii)", or "" when there is none. */
  point: string;
  /** Points to another document ("of the Supply Agreement"): not resolved here. */
  external: boolean;
}

const KIND = "(Sections?|Clauses?|Articles?|Paragraphs?)";
// Not followed by another digit, ".digit" or a letter: "Section 10.6.1.2.3.4" is no match
// (not "Section 1"), and "Section Liability" is not Roman numeral L.
const NUM = "(\\d{1,3}(?:\\.\\d{1,3}){0,4}|[IVXLC]{1,6})(?!\\d|\\.\\d|[A-Za-z])";
const POINT = "((?:\\([a-z0-9]{1,4}\\))*)";
/** The first number after the kind word, then any ", 4", " and 9.1(b)" that follow. */
const HEAD = new RegExp(`\\b${KIND}\\s+${NUM}${POINT}`, "gu");
const MORE = new RegExp(`^(\\s*(?:,|,?\\s+(?:and|or|through|to))\\s+)${NUM}${POINT}`, "u");
/**
 * "of the Supply Agreement", "of the Code", "of Exhibit B": another document. "of this
 * Agreement" and "of the Agreement" mean this one (the usual drafting), so they stay internal.
 */
const EXTERNAL = /^\s+of\s+(?!this\b|the\s+Agreement\b)(?:the\s+)?[A-Z]/u;

const kindOf = (word: string) => word.toLowerCase().replace(/s$/u, "");

export function findSectionReferences(text: string): SectionReference[] {
  const found: SectionReference[] = [];
  for (const head of text.matchAll(HEAD)) {
    const kind = kindOf(head[1] ?? "");
    const group: SectionReference[] = [];
    const push = (start: number, raw: string, point: string, end: number) => {
      const number = parseClauseNumber(raw);
      if (number !== null) group.push({ start, end, kind, number, point, external: false });
    };
    const start = head.index;
    let end = start + head[0].length;
    push(start, head[2] ?? "", head[3] ?? "", end);
    // A list continues while the next item is a number: "Sections 3, 4 and 9.1(b)".
    for (;;) {
      const more = MORE.exec(text.slice(end, end + 40));
      if (more === null) break;
      const itemStart = end + (more[1] ?? "").length;
      end += more[0].length;
      push(itemStart, more[2] ?? "", more[3] ?? "", end);
    }
    // "of the X Agreement" after the last item makes the whole list external.
    const external = EXTERNAL.test(text.slice(end, end + 80));
    for (const ref of group) found.push({ ...ref, external });
  }
  return found;
}

/**
 * The number a section heading carries: "1.1 Grant" -> [1, 1], "ARTICLE IV Payment" -> [4],
 * "Section 5.3. Term" -> [5, 3]. Null when the label has no number ("EXHIBIT 10.6" is not a
 * section of this contract, so a word other than article/section/clause/part blocks it).
 */
export function sectionNumber(label: string | null): readonly number[] | null {
  if (label === null) return null;
  const words = label.trim().split(/\s+/u);
  const first = /^(article|section|clause|part)$/iu.test(words[0] ?? "") ? words[1] : words[0];
  return parseClauseNumber((first ?? "").replace(/[.:)]+$/u, ""));
}

const sameNumber = (a: readonly number[], b: readonly number[]) =>
  a.length === b.length && a.every((n, i) => n === b[i]);

/** The section with exactly this number (the first one, if a number repeats), or null. */
export function resolveReference(
  ref: SectionReference,
  sections: readonly Section[],
): Section | null {
  if (ref.external) return null;
  return (
    sections.find((s) => {
      const n = sectionNumber(s.label);
      return n !== null && sameNumber(n, ref.number);
    }) ?? null
  );
}
