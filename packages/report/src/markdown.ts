// The report as Markdown for people (M5 step 7, D51).
//
// Contract text and the model's note are untrusted: a contract can contain Markdown or HTML
// that would act when the report is viewed (a link to javascript:, an <img onerror=...>, a
// fake heading that hides a finding). Every untrusted string is escaped so it shows as text:
//   escapeMarkdown('<img src=x onerror=alert(1)> [click](javascript:x)')
//     -> '&lt;img src=x onerror=alert\(1\)&gt; \[click\]\(javascript:x\)'
import type { Finding, Report, Status } from "./build";

/** Characters that mean something in Markdown, escaped with a backslash. */
const MARKDOWN = /[\\`*_{}[\]()#+\-.!|~>]/gu;

export function escapeMarkdown(text: string): string {
  return (
    text
      // Control characters (except tab and line break) have no business in a report.
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/gu, "")
      .replace(/&/gu, "&amp;")
      .replace(/</gu, "&lt;")
      .replace(/>/gu, "&gt;")
      .replace(MARKDOWN, (c) => (c === ">" ? c : `\\${c}`))
  );
}

/** Escaped text as a block quote: every line starts with "> ", so none can end the quote. */
const quote = (text: string) =>
  escapeMarkdown(text)
    .split(/\r?\n/u)
    .map((line) => `> ${line}`)
    .join("\n");

const ICON: Record<Status, string> = { meets: "✅", breaks: "❌", missing: "⚠️" };
const LABEL: Record<Status, string> = {
  meets: "Meets",
  breaks: "Breaks",
  missing: "Not addressed",
};

const where = (s: { start: number; end: number; page: number | null }) =>
  `${s.page === null ? "" : `page ${String(s.page)}, `}characters ${String(s.start)}-${String(s.end)}`;

function finding(f: Finding): string {
  const lines = [
    `### ${ICON[f.status]} ${LABEL[f.status]}: ${escapeMarkdown(f.citation)} (${escapeMarkdown(f.ruleTitle)})`,
    "",
    `**Rule${f.policy === "forbid" ? " (should NOT be in the contract)" : ""}:** ${escapeMarkdown(f.ruleText)}`,
    "",
  ];
  if (f.evidence.length === 0) {
    lines.push("**Contract:** no verified passage addresses this rule.", "");
  }
  for (const e of f.evidence) {
    lines.push(`**Contract (${where(e)}), verified word for word:**`, "", quote(e.text), "");
  }
  for (const r of f.references) {
    const target = r.external
      ? "another document, not resolved"
      : r.section === null
        ? "no section with that number found"
        : `section "${escapeMarkdown(r.section)}"`;
    lines.push(`- Reference "${escapeMarkdown(r.text)}" -> ${target}`);
  }
  if (f.references.length > 0) lines.push("");
  if (f.modelNote !== null) {
    lines.push(
      `*Model note (written by the model, not verified):* ${escapeMarkdown(f.modelNote)}`,
      "",
    );
  }
  const r = f.redline;
  if (r !== null) {
    lines.push("**Suggested change (template from the rulebook, adapt before use):**", "");
    if (r.kind === "delete") lines.push("Delete:", "", quote(r.original), "");
    if (r.kind === "replace")
      lines.push("Replace:", "", quote(r.original), "", "With:", "", quote(r.text), "");
    if (r.kind === "insert") lines.push("Add:", "", quote(r.text), "");
  }
  return lines.join("\n");
}

export function renderMarkdown(report: Report): string {
  const s = report.summary;
  const versions = Object.entries(report.versions)
    .map(([k, v]) => `${escapeMarkdown(k)} ${escapeMarkdown(v)}`)
    .join(", ");
  const order: Status[] = ["breaks", "missing", "meets"];
  return [
    `# Lexguard review: ${escapeMarkdown(report.document.title)}`,
    "",
    `Generated ${escapeMarkdown(report.generatedAt)} (${report.version}; ${versions}).`,
    `Rulebooks: ${report.rulebooks.map((b) => escapeMarkdown(b.title)).join("; ")}.`,
    "",
    "> Not legal advice. Every contract quote below was checked character by character against",
    "> the stored contract. Suggested wording is the rulebook's own text, not generated from the",
    "> contract, and must be adapted and reviewed.",
    "",
    "## Summary",
    "",
    "| Status | Rules |",
    "| --- | --- |",
    `| ${ICON.breaks} Breaks | ${String(s.breaks)} |`,
    `| ${ICON.missing} Not addressed | ${String(s.missing)} |`,
    `| ${ICON.meets} Meets | ${String(s.meets)} |`,
    `| Claims rejected by the verifier | ${String(report.rejectedClaims.count)} |`,
    "",
    "## Findings",
    "",
    ...order.flatMap((status) => report.findings.filter((f) => f.status === status).map(finding)),
  ].join("\n");
}
