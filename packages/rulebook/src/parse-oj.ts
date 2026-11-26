// Turns the Official Journal's XHTML of an EU regulation (as served by the Publications
// Office's Cellar) into plain text plus citable rules (M5 step 3, D45).
//
// The XHTML is regular: each article is <div class="eli-subdivision" id="art_28">, each
// numbered paragraph <div id="028.003">, each point a two-cell table row whose first cell is
// the label "(a)" and whose second cell holds the point's text (and maybe nested points).
//
//   <div id="028.003"><p>3.   Processing by a processor shall ... that the processor:</p>
//     <table><tr><td><p>(a)</p></td><td><p>processes the personal data only on ...</p></td></tr>
//
// becomes two rules:
//   gdpr:28(3)     "Processing by a processor shall ... that the processor:"
//   gdpr:28(3)(a)  "processes the personal data only on ..."
// Each rule is one line of the output text, with exact offsets, so a quote can be checked by
// code. A second block of text at the same level (a subparagraph) gets "/2": gdpr:28(3)/2.
// An unnumbered list item ("—", an "indent" in legal citation) gets "-1", "-2": gdpr:53(1)-2.
//
// Pure and standard JS (no DOM), so it runs in tests, Node and Workers alike. The input is the
// verified download only; anything unexpected throws instead of producing a silent gap.

export interface ParsedRule {
  id: string;
  /** Article number as printed, e.g. "28". */
  article: string;
  /** Article heading, e.g. "Processor". */
  title: string;
  start: number;
  end: number;
}

export interface ParsedRegulation {
  text: string;
  rules: ParsedRule[];
}

interface Element {
  tag: string;
  attrs: Map<string, string>;
  /** For <tr>: how many <td> opened so far. */
  cells: number;
  /** For <td>: its position in the row (1-based). */
  cell: number;
  /** Set on the element that opened an article / paragraph / point, to undo it on close. */
  opens?: "article" | "paragraph" | "point";
}

const TOKEN =
  /<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:\s+[^\s=>/]+(?:\s*=\s*"[^"]*")?)*)\s*(\/?)>|<!--[\s\S]*?-->|<[!?][^>]*>|([^<]+)/g;
const ATTR = /([^\s=>/]+)\s*=\s*"([^"]*)"/g;

const VOID = new Set(["col", "br", "hr", "img", "meta", "link"]);

function attributes(raw: string): Map<string, string> {
  const attrs = new Map<string, string>();
  for (const m of raw.matchAll(ATTR)) attrs.set(m[1] ?? "", m[2] ?? "");
  return attrs;
}

/** U+00A0, written as a code so no editor or formatter can turn it into an invisible character. */
const NBSP = String.fromCharCode(160);

function decode(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos|nbsp);/g, (_, e: string) => {
    if (e.startsWith("#x")) return String.fromCodePoint(parseInt(e.slice(2), 16));
    if (e.startsWith("#")) return String.fromCodePoint(parseInt(e.slice(1), 10));
    return { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: NBSP }[e] ?? "";
  });
}

/** One line of text: every run of whitespace becomes one space (\s includes no-break spaces). */
const clean = (text: string) => text.replace(/\s+/g, " ").trim();

const hasClass = (el: Element, name: string) =>
  (el.attrs.get("class") ?? "").split(/\s+/).includes(name);

export function parseOjRegulation(xhtml: string, prefix: string): ParsedRegulation {
  const stack: Element[] = [];
  const lines: { id: string; article: string; title: string; text: string }[] = [];
  const used = new Map<string, number>();
  /** Unnumbered indents ("—") seen per parent ID. */
  const indents = new Map<string, number>();

  let article: string | null = null;
  let title = "";
  let paragraph: string | null = null;
  const points: string[] = [];
  /** Text of the <p> being read, or null outside a <p>. */
  let buffer: string[] | null = null;
  let pClass: Element | null = null;
  /** Label read from the first cell of the current row, waiting for the second cell. */
  let pendingLabel: string | null = null;
  let skipDepth = 0; // inside a footnote marker

  const inLabelCell = () => {
    for (let i = stack.length - 1; i >= 0; i--) {
      const el = stack[i];
      if (el?.tag === "td") return el.cell === 1;
    }
    return false;
  };

  const baseId = () => {
    if (article === null) throw new Error("text outside an article");
    return `${prefix}:${article}${paragraph === null ? "" : `(${paragraph})`}${points.join("")}`;
  };

  const emit = (raw: string) => {
    let text = clean(raw);
    if (text === "") return;
    // "3.   Processing by ..." -> the number is in the rule ID instead.
    if (paragraph !== null && points.length === 0 && !used.has(baseId())) {
      const lead = `${String(Number(paragraph))}.`;
      if (text.startsWith(lead)) text = text.slice(lead.length).trim();
    }
    const base = baseId();
    const n = (used.get(base) ?? 0) + 1;
    used.set(base, n);
    lines.push({
      id: n === 1 ? base : `${base}/${String(n)}`,
      article: article ?? "",
      title,
      text,
    });
  };

  for (const m of xhtml.matchAll(TOKEN)) {
    const [, closing, rawTag, rawAttrs, selfClosing, textPart] = m;
    if (textPart !== undefined) {
      if (buffer !== null && skipDepth === 0) buffer.push(decode(textPart));
      continue;
    }
    if (rawTag === undefined) continue; // comment, doctype, processing instruction
    const tag = rawTag.toLowerCase();

    if (closing !== "/") {
      const el: Element = { tag, attrs: attributes(rawAttrs ?? ""), cells: 0, cell: 0 };
      if (VOID.has(tag) || selfClosing === "/") continue;
      stack.push(el);
      const id = el.attrs.get("id") ?? "";
      if (tag === "div" && hasClass(el, "eli-subdivision") && /^art_\d+$/.test(id)) {
        if (article !== null) throw new Error(`article ${id} inside article ${article}`);
        article = id.slice(4);
        title = "";
        paragraph = null;
        el.opens = "article";
      } else if (tag === "div" && article !== null && /^\d{3}\.\d{3}$/.test(id)) {
        if (Number(id.slice(0, 3)) !== Number(article)) {
          throw new Error(`paragraph ${id} inside article ${article}`);
        }
        paragraph = String(Number(id.slice(4)));
        el.opens = "paragraph";
      } else if (tag === "tr") {
        pendingLabel = null;
      } else if (tag === "td") {
        const row = [...stack].reverse().find((e) => e.tag === "tr");
        if (row !== undefined) el.cell = ++row.cells;
        if (el.cell === 2 && article !== null) {
          if (pendingLabel === null) throw new Error(`point without a label in ${baseId()}`);
          points.push(pendingLabel);
          el.opens = "point";
        }
      } else if (tag === "p") {
        buffer = [];
        pClass = el;
      } else if (tag === "span" && hasClass(el, "oj-note-tag")) {
        skipDepth++;
      }
      continue;
    }

    // Closing tag: pop to the matching element (the XHTML is well formed; check anyway).
    const el = stack.pop();
    if (el?.tag !== tag) throw new Error(`unbalanced </${tag}>`);
    if (tag === "span" && hasClass(el, "oj-note-tag")) skipDepth--;
    if (tag === "p" && buffer !== null && pClass !== null) {
      const text = buffer.join("");
      buffer = null;
      if (article !== null) {
        if (hasClass(pClass, "oj-sti-art")) title = clean(text);
        else if (hasClass(pClass, "oj-normal")) {
          if (inLabelCell()) {
            const label = clean(text);
            if (/^[—–-]$/.test(label)) {
              // An unnumbered "indent": numbered in order within its parent, "-1", "-2", ...
              const parent = baseId();
              const n = (indents.get(parent) ?? 0) + 1;
              indents.set(parent, n);
              pendingLabel = `-${String(n)}`;
            } else if (/^\([0-9a-z]+\)$/.test(label)) pendingLabel = label;
            else throw new Error(`odd point label "${label}"`);
          } else emit(text);
        }
      }
      pClass = null;
    }
    if (el.opens === "point") points.pop();
    if (el.opens === "paragraph") paragraph = null;
    if (el.opens === "article") {
      article = null;
      paragraph = null;
    }
  }
  if (stack.length > 0) throw new Error("unclosed elements at the end");

  let text = "";
  const rules: ParsedRule[] = [];
  for (const line of lines) {
    if (text !== "") text += "\n";
    const start = text.length;
    text += line.text;
    rules.push({ id: line.id, article: line.article, title: line.title, start, end: text.length });
  }
  return { text, rules };
}
