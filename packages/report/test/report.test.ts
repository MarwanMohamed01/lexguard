import { chunkDocument } from "@lexguard/chunker";
import { getRule, ndaPlaybook, ruleText } from "@lexguard/rulebook";
import { verifyClaim, type Claim, type VerifiedClaim } from "@lexguard/verifier";
import { describe, expect, it } from "vitest";
import {
  buildReport,
  citationOf,
  escapeMarkdown,
  pageAt,
  renderMarkdown,
  REPORT_VERSION,
  type ReportInput,
} from "../src/index";

// A small hand-written NDA (unit-test input, not a dataset), with a hostile line in it.
const TEXT = [
  "1. Confidentiality",
  "1.1 The Recipient shall not decompile, disassemble or reverse engineer the Materials.",
  "1.2 The Recipient may keep copies after termination, as allowed by Section 1.1.",
  "2. Notes",
  "<img src=x onerror=alert(1)> [click here](javascript:alert(2)) # Fake heading",
].join("\n");
const PAGE_STARTS = [0, TEXT.indexOf("2. Notes")];
const rulebooks = new Map([["nda", ndaPlaybook]]);
const sections = chunkDocument(TEXT).sections;

const span = (text: string) => {
  const start = TEXT.indexOf(text);
  if (start < 0) throw new Error(`not in the text: ${text}`);
  return { start, end: start + text.length, text };
};

function verified(claim: Claim): VerifiedClaim {
  const result = verifyClaim(claim, { text: TEXT, rulebooks, sections });
  if (!result.ok) throw new Error(result.problems.join());
  return result.claim;
}

const AGREES_11 = verified({
  ruleId: "nda:11",
  verdict: "agrees",
  evidence: [span("shall not decompile, disassemble or reverse engineer the Materials")],
  reason: "Forbidden in 1.1.",
});
const AGREES_20 = verified({
  ruleId: "nda:20",
  verdict: "agrees",
  evidence: [span("The Recipient may keep copies after termination, as allowed by Section 1.1.")],
  reason: "<b>Retention</b> allowed",
});

const input = (over: Partial<ReportInput> = {}): ReportInput => ({
  document: { id: "doc-1", title: "Test NDA" },
  text: TEXT,
  pageStarts: PAGE_STARTS,
  rulebooks,
  scope: [{ ruleId: "nda:11" }, { ruleId: "nda:20", policy: "forbid" }, { ruleId: "nda:16" }],
  verified: [AGREES_11, AGREES_20],
  rejected: [
    {
      claim: { ruleId: "nda:99", verdict: "agrees", evidence: [] },
      problems: ["unknown_rule", "no_evidence"],
    },
  ],
  versions: { checker: "check/1", model: "test" },
  generatedAt: "2026-11-26T00:00:00.000Z",
  ...over,
});

const rule16 = getRule(ndaPlaybook, "nda:16");
if (rule16 === undefined) throw new Error("no nda:16");
const RULE_16_TEXT = ruleText(ndaPlaybook, rule16);

describe("buildReport", () => {
  const report = buildReport(input());
  const byId = new Map(report.findings.map((f) => [f.ruleId, f]));

  it("has one finding per rule in scope, in scope order, and a summary that adds up", () => {
    expect(report.version).toBe(REPORT_VERSION);
    expect(report.findings.map((f) => f.ruleId)).toEqual(["nda:11", "nda:20", "nda:16"]);
    expect(report.summary).toEqual({ rules: 3, meets: 1, breaks: 1, missing: 1 });
    expect(report.rejectedClaims).toEqual({
      count: 1,
      problems: { unknown_rule: 1, no_evidence: 1 },
    });
    expect(report.rulebooks[0]).toMatchObject({
      id: "nda",
      sourceSha256: ndaPlaybook.source.sourceSha256,
    });
  });

  it("maps verdicts through the rule's policy", () => {
    expect(byId.get("nda:11")).toMatchObject({
      verdict: "agrees",
      status: "meets",
      risk: "none",
      redline: null,
    });
    // nda:20 ("may retain ... after termination") is forbidden by policy: stating it breaks.
    expect(byId.get("nda:20")).toMatchObject({ verdict: "agrees", status: "breaks", risk: "high" });
    // nda:16 has no verified claim: missing, never guessed.
    expect(byId.get("nda:16")).toMatchObject({
      verdict: null,
      status: "missing",
      risk: "medium",
      evidence: [],
    });
  });

  it("cites evidence with offsets and pages, and the contract's exact text", () => {
    const [e] = byId.get("nda:11")?.evidence ?? [];
    expect(e).toMatchObject({ page: 1 });
    expect(TEXT.slice(e?.start, e?.end)).toBe(e?.text);
    expect(pageAt(PAGE_STARTS, PAGE_STARTS[1] ?? 0)).toBe(2);
    expect(pageAt(PAGE_STARTS, (PAGE_STARTS[1] ?? 0) - 1)).toBe(1);
    expect(buildReport(input({ pageStarts: [] })).findings[0]?.evidence[0]?.page).toBeNull();
  });

  it("carries resolved section references from the verifier", () => {
    const refs = byId.get("nda:20")?.references ?? [];
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ text: "Section 1.1", external: false });
    expect(refs[0]?.section).toMatch(/^1\.1\b/);
  });

  it("builds redlines from the rulebook's wording only", () => {
    // Forbidden and stated: delete the passage.
    expect(byId.get("nda:20")?.redline).toMatchObject({
      kind: "delete",
      original: AGREES_20.evidence[0]?.text,
      source: "rulebook",
    });
    // Required and missing: add the rule's own text at the end.
    expect(byId.get("nda:16")?.redline).toMatchObject({
      kind: "insert",
      at: TEXT.length,
      text: RULE_16_TEXT,
    });
    // Required and contradicted: replace the passage with the rule's text.
    const conflicting = verified({
      ...AGREES_11,
      verdict: "conflicts",
      references: undefined,
    } as Claim);
    const broken = buildReport(input({ verified: [conflicting] })).findings[0];
    expect(broken).toMatchObject({
      status: "breaks",
      redline: { kind: "replace", original: AGREES_11.evidence[0]?.text },
    });
    expect(broken?.redline?.kind === "replace" && broken.redline.text).toBe(broken?.ruleText);
  });

  it("lets a break outweigh a meet when several claims concern one rule", () => {
    const conflicting = verified({
      ...AGREES_11,
      verdict: "conflicts",
      references: undefined,
    } as Claim);
    for (const order of [
      [AGREES_11, conflicting],
      [conflicting, AGREES_11],
    ]) {
      expect(buildReport(input({ verified: order })).findings[0]?.status).toBe("breaks");
    }
  });

  it("refuses a scope rule that is not in any rulebook", () => {
    expect(() => buildReport(input({ scope: [{ ruleId: "nda:99" }] }))).toThrow(
      /not in any rulebook/,
    );
  });

  it("names rules the way people cite them", () => {
    expect(citationOf("gdpr:28(3)(a)")).toBe("GDPR Art. 28(3)(a)");
    expect(citationOf("nda:11")).toBe("NDA playbook rule 11");
  });
});

describe("renderMarkdown", () => {
  const markdown = renderMarkdown(buildReport(input()));

  it("lists breaks first, then missing, then meets, with the summary", () => {
    // Finding headings, not the summary table (which names every status first).
    const at = (s: string) => markdown.indexOf(`### ${s}`);
    expect(at("❌ Breaks: NDA playbook rule 20")).toBeGreaterThan(-1);
    expect(at("❌ Breaks")).toBeLessThan(at("⚠️ Not addressed"));
    expect(at("⚠️ Not addressed")).toBeLessThan(at("✅ Meets"));
    expect(markdown).toContain("| Claims rejected by the verifier | 1 |");
    expect(markdown).toContain("page 1, characters");
  });

  it("marks the model's note as unverified and the wording as a rulebook template", () => {
    expect(markdown).toContain("*Model note (written by the model, not verified):*");
    expect(markdown).toContain("template from the rulebook, adapt before use");
  });

  it("escapes contract text and model notes so nothing in them can act", () => {
    const hostile = verified({
      ruleId: "nda:11",
      verdict: "agrees",
      evidence: [
        span("<img src=x onerror=alert(1)> [click here](javascript:alert(2)) # Fake heading"),
      ],
      reason: "</p><script>alert(3)</script>",
    });
    const md = renderMarkdown(
      buildReport(input({ verified: [hostile], scope: [{ ruleId: "nda:11" }] })),
    );
    expect(md).not.toMatch(/<img|<script|\]\(javascript/u);
    expect(md).toContain("&lt;img src=x onerror=alert\\(1\\)&gt;");
    expect(md).toContain("\\[click here\\]\\(javascript:alert\\(2\\)\\)");
    // The fake heading stays inside the quote: no line of the report starts with "# Fake".
    expect(md.split("\n").some((line) => line.startsWith("# Fake"))).toBe(false);
    // That passage is on page 2 of the page map.
    expect(md).toContain("page 2, characters");
  });

  it("keeps every line of a quoted passage inside the block quote", () => {
    const twoLines = verified({
      ruleId: "nda:11",
      verdict: "agrees",
      evidence: [span("reverse engineer the Materials.\n1.2 The Recipient may keep copies")],
    });
    const md = renderMarkdown(
      buildReport(input({ verified: [twoLines], scope: [{ ruleId: "nda:11" }] })),
    );
    const quoted = md
      .split("\n")
      .filter((l) => l.includes("reverse engineer the Materials") || l.includes("may keep copies"));
    expect(quoted).toHaveLength(2);
    for (const line of quoted) expect(line.startsWith("> ")).toBe(true);
  });

  it("shows no model note when the checker gave no reason", () => {
    const silentReason = verified({ ...AGREES_11, reason: "", references: undefined } as Claim);
    const report = buildReport(input({ verified: [silentReason], scope: [{ ruleId: "nda:11" }] }));
    expect(report.findings[0]?.modelNote).toBeNull();
    expect(renderMarkdown(report)).not.toContain("Model note");
  });
});

describe("escapeMarkdown", () => {
  it("escapes Markdown and HTML characters and drops control characters", () => {
    expect(escapeMarkdown("a*b_c [x](y) <z> & `q` #h |t| ~s~ 1. -")).toBe(
      "a\\*b\\_c \\[x\\]\\(y\\) &lt;z&gt; &amp; \\`q\\` \\#h \\|t\\| \\~s\\~ 1\\. \\-",
    );
    expect(escapeMarkdown(`a${String.fromCharCode(0)}b${String.fromCharCode(27)}c\td`)).toBe(
      "abc\td",
    );
  });
});
