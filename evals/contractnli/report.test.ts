// Reports from real checker claims (M5 step 7, D51): for each of the 20 pinned test NDAs,
// all 17 playbook rules -> checker -> verifier -> report. Invariants that must hold for every
// report, with the oracle's claims (CI) and the cached Groq claims (locally):
//   - one finding per rule, statuses add up;
//   - every quoted passage is exactly the NDA's text at its offsets;
//   - the report survives a JSON round trip unchanged;
//   - the Markdown contains no raw "<" from the contract (escaped, D51).
// Also writes one example report (public ContractNLI text, CC BY 4.0) to read.
import { buildCheckPrompt, checkRule } from "@lexguard/checker";
import { chunkDocument } from "@lexguard/chunker";
import { buildReport, renderMarkdown, type Report } from "@lexguard/report";
import { getRule, ndaPlaybook, ruleText } from "@lexguard/rulebook";
import { verifyClaims, type Claim } from "@lexguard/verifier";
import { writeFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { pinnedSubset } from "../extraction/dataset";
import { AnswerCache } from "../extraction/models";
import { keywordRankings } from "./baselines";
import { caseNonce, checkerCases, oracleAnswer, passagesOf, type CheckCase } from "./checker";
import { contractNliAvailable, loadContractNli, type NliDoc, type NliSplit } from "./load";

const rulebooks = new Map([["nda", ndaPlaybook]]);
const STATUS_TO_LABEL = {
  meets: "Entailment",
  breaks: "Contradiction",
  missing: "NotMentioned",
} as const;

const ruleOf = (id: string) => {
  const rule = getRule(ndaPlaybook, id);
  if (rule === undefined) throw new Error(`no rule ${id}`);
  return { id, text: ruleText(ndaPlaybook, rule) };
};

async function reportFor(
  doc: NliDoc,
  cases: readonly CheckCase[],
  answerOf: (c: CheckCase) => string | undefined,
  model: string,
) {
  const claims: Claim[] = [];
  let answered = 0;
  for (const c of cases) {
    const answer = answerOf(c);
    if (answer === undefined) continue;
    answered++;
    const rule = ruleOf(c.ruleId);
    const passages = passagesOf(c);
    const result = await checkRule(rule, passages, () => Promise.resolve(answer), {
      nonce: caseNonce(rule.text, passages),
    });
    if (!result.ok) continue;
    claims.push({
      ruleId: c.ruleId,
      verdict: result.verdict,
      evidence: result.evidence.map((e) => {
        const [spanStart] = doc.spans[c.spans[e.passage] ?? -1] ?? [0];
        return { start: spanStart + e.start, end: spanStart + e.end, text: e.text };
      }),
      ruleQuote: result.ruleQuote,
      reason: result.reason,
    });
  }
  const { verified, rejected } = verifyClaims(claims, {
    text: doc.text,
    rulebooks,
    sections: chunkDocument(doc.text).sections,
  });
  const report = buildReport({
    document: { id: doc.title, title: `ContractNLI test NDA ${String(doc.id)}` },
    text: doc.text,
    rulebooks,
    scope: cases.map((c) => ({ ruleId: c.ruleId })),
    verified,
    rejected,
    versions: { checker: "check/1", model },
    generatedAt: "2026-11-26T00:00:00.000Z",
  });
  return { report, answered };
}

function checkInvariants(report: Report, doc: NliDoc) {
  expect(report.findings).toHaveLength(17);
  const s = report.summary;
  expect(s.meets + s.breaks + s.missing).toBe(s.rules);
  for (const f of report.findings) {
    for (const e of f.evidence) expect(doc.text.slice(e.start, e.end)).toBe(e.text);
  }
  expect(JSON.parse(JSON.stringify(report))).toEqual(report);
  expect(renderMarkdown(report)).not.toMatch(/<(?!-)/u); // no raw "<" (the summary uses none)
}

describe.skipIf(!contractNliAvailable())("reports from real checker claims", () => {
  let test: NliSplit;
  let docs: NliDoc[];
  let casesOf: Map<number, CheckCase[]>;
  const summary: Record<string, unknown> = {};
  beforeAll(() => {
    test = loadContractNli("test");
    docs = pinnedSubset(test.docs, 20);
    const all = checkerCases(
      docs,
      [...test.hypotheses.keys()],
      keywordRankings(docs, test.hypotheses, 50),
    );
    casesOf = new Map(docs.map((d) => [d.id, all.filter((c) => c.doc.id === d.id)]));
  });

  const agreement = (pairs: { report: Report; doc: NliDoc }[]) => {
    let right = 0;
    let total = 0;
    for (const { report, doc } of pairs) {
      for (const f of report.findings) {
        total++;
        if (doc.answers.get(f.ruleId.replace(":", "-"))?.choice === STATUS_TO_LABEL[f.status])
          right++;
      }
    }
    return {
      findings: total,
      matchExpert: Math.round((right / Math.max(total, 1)) * 10_000) / 10_000,
    };
  };

  it("builds a valid report for every NDA from the oracle's claims", async () => {
    const pairs = [];
    for (const doc of docs) {
      const { report } = await reportFor(doc, casesOf.get(doc.id) ?? [], oracleAnswer, "oracle");
      checkInvariants(report, doc);
      expect(report.rejectedClaims.count).toBe(0);
      pairs.push({ report, doc });
    }
    summary.oracle = agreement(pairs);
  }, 120_000);

  it("builds a valid report for every fully answered NDA from the cached Groq claims", async () => {
    const cache = new AnswerCache(
      "groq-openai/gpt-oss-20b-json-low-t0",
      "check/1",
      new URL("../data/contractnli/answers/", import.meta.url),
    );
    const answerOf = (c: CheckCase) => {
      const rule = ruleOf(c.ruleId);
      const passages = passagesOf(c);
      return cache.get(buildCheckPrompt(rule, passages, caseNonce(rule.text, passages)).user)?.text;
    };
    const pairs = [];
    let example: Report | null = null;
    for (const doc of docs) {
      const { report, answered } = await reportFor(
        doc,
        casesOf.get(doc.id) ?? [],
        answerOf,
        "groq openai/gpt-oss-20b",
      );
      if (answered < 17) continue; // only NDAs whose 17 rules all have an answer
      checkInvariants(report, doc);
      pairs.push({ report, doc });
      const mixed = (r: Report) => Math.min(r.summary.meets, r.summary.breaks, r.summary.missing);
      if (example === null || mixed(report) > mixed(example)) example = report;
    }
    summary.groq = { ndas: pairs.length, ...agreement(pairs) };
    if (example !== null) {
      writeFileSync(
        new URL("../results/contractnli-example-report.md", import.meta.url),
        `<!-- Generated by evals/contractnli/report.test.ts from public ContractNLI data (CC BY 4.0, Hitachi America, Ltd.). Not legal advice. -->\n\n${renderMarkdown(example)}\n`,
      );
    }
    writeFileSync(
      new URL("../results/contractnli-reports.json", import.meta.url),
      `${JSON.stringify(summary, null, 2)}\n`,
    );
  }, 120_000);
});
