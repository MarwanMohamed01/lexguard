// toMarkdown wraps a PDF's text like this (seen on all 30 CUAD PDFs in M2 step 6):
//
//   # document.pdf
//   ## Metadata              <- only when PDF metadata is requested
//   - Producer=...
//   ## Contents
//   ### Page 1
//   ...text...
//   ### Page 2
//   ...text that often continues mid-sentence...
//
// Left in place, every "### Page N" is a Markdown heading, so the chunker starts a section at
// every page break and cuts clauses that run across pages. So the wrapper and the markers are
// removed, pages are joined with one line break (a page break is not a paragraph break), and
// where each page starts is kept as data: any offset can then be mapped to its PDF page for
// citations.
//
// Strict on purpose: only markers numbered 1, 2, 3... in order, after the wrapper, are
// removed. Anything else (a format change, a "### Page 9" written inside a contract) leaves
// the text untouched and returns no page map, rather than risk mangling contract text.

export interface PagedText {
  text: string;
  /** Offset in `text` where each page starts (index 0 = page 1), or null if not paged. */
  pageStarts: number[] | null;
}

const WRAPPER = /^(?:# [^\n]*\n)?(?:## Metadata\n(?:- [^\n]*\n)*\s*)?## Contents\n(?=### Page 1\n)/;

export function extractPages(markdown: string): PagedText {
  const wrapper = WRAPPER.exec(markdown);
  if (wrapper === null) return { text: markdown, pageStarts: null };

  const body = markdown.slice(wrapper[0].length);
  const pages: string[] = [];
  let at = "### Page 1\n".length; // body starts with the first marker (checked by WRAPPER)
  for (let page = 1; ; page++) {
    const marker = `\n### Page ${String(page + 1)}\n`;
    const next = body.indexOf(marker, at - 1); // "- 1": a page may be empty
    if (next === -1) {
      pages.push(body.slice(at).trimEnd());
      break;
    }
    pages.push(body.slice(at, next).trimEnd());
    at = next + marker.length;
  }

  const pageStarts: number[] = [];
  let offset = 0;
  for (const page of pages) {
    pageStarts.push(offset);
    offset += page.length + 1; // + the "\n" that joins pages
  }
  return { text: pages.join("\n"), pageStarts };
}

/** The 1-based PDF page that contains `offset`, by binary search over the page starts. */
export function pageAt(pageStarts: readonly number[], offset: number): number {
  let low = 0;
  let high = pageStarts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if ((pageStarts[mid] ?? Infinity) <= offset) low = mid;
    else high = mid - 1;
  }
  return low + 1;
}
