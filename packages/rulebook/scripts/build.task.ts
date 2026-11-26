// Builds the rulebook data files from pinned public sources (M5 step 3, D45):
//   data/gdpr.json  GDPR's Official Journal text from the Publications Office (Cellar), SHA-256
//                   checked, parsed into rules by parseOjRegulation;
//   data/nda.json   ContractNLI's 17 hypotheses (needs `npm run fetch:contractnli -w
//                   @lexguard/evals` first), one rule each.
// The outputs are committed (the Worker serves them); re-running gives identical bytes.
//
// Usage: npm run build:data -w @lexguard/rulebook (config: scripts/vitest.config.ts)
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { expect, it } from "vitest";
import { parseOjRegulation } from "../src/parse-oj";
import { parseRulebook, type Rulebook } from "../src/rulebook";

const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

// The English XHTML manifestation of CELEX 32016R0679 (OJ L 119, 4.5.2016), the URL that
// http://publications.europa.eu/resource/celex/32016R0679 redirects to.
const GDPR_URL =
  "https://publications.europa.eu/resource/cellar/3e485e15-11bd-11e6-ba9a-01aa75ed71a1.0006.03/DOC_1";
const GDPR_SHA256 = "962539af03738bf552319ff4ce42d69e5f95a576307c4dfed7bf87e81b646b9d";

const CONTRACTNLI_URL =
  "https://raw.githubusercontent.com/stanfordnlp/contract-nli/3d2a4d47da022de1f1d740b8eea16930e55c21a1/resources/contract-nli.zip";
const TRAIN_SHA256 = "dbceb356cd6203b35b27be94a5fa85e499a81c34c42c89ad53060b39f0257ba5";

const write = (name: string, book: Rulebook) => {
  parseRulebook(book); // never write a file the loader would refuse
  writeFileSync(new URL(`../data/${name}`, import.meta.url), JSON.stringify(book, null, 1) + "\n");
};

it("builds data/gdpr.json", async () => {
  const response = await fetch(GDPR_URL, { headers: { "Accept-Language": "eng" } });
  expect(response.ok).toBe(true);
  const bytes = new Uint8Array(await response.arrayBuffer());
  expect(sha256(bytes)).toBe(GDPR_SHA256);
  const { text, rules } = parseOjRegulation(new TextDecoder().decode(bytes), "gdpr");
  write("gdpr.json", {
    source: {
      id: "gdpr",
      title:
        "Regulation (EU) 2016/679 (General Data Protection Regulation), OJ L 119, 4.5.2016, p. 1-88",
      url: GDPR_URL,
      sourceSha256: GDPR_SHA256,
      licence: "EU reuse policy, Commission Decision 2011/833/EU (EUR-Lex legal notice)",
      attribution:
        "Source: EUR-Lex / Publications Office of the European Union, (c) European Union. " +
        "Changes: articles only (no recitals or annexes), converted from XHTML to plain text, " +
        "whitespace normalised, footnote markers and paragraph numbers removed (the numbers " +
        "are in the rule IDs). Corrigenda published after 2016 are not applied.",
    },
    text,
    rules,
  });
  console.log(`gdpr: ${String(rules.length)} rules, ${String(text.length)} characters`);
}, 120_000);

it("builds data/nda.json", () => {
  const bytes = readFileSync(
    new URL("../../../evals/data/contractnli/train.json", import.meta.url),
  );
  expect(sha256(bytes)).toBe(TRAIN_SHA256);
  const labels = (
    JSON.parse(bytes.toString("utf8")) as {
      labels: Record<string, { short_description: string; hypothesis: string }>;
    }
  ).labels;
  const keys = Object.keys(labels).sort((a, b) => Number(a.slice(4)) - Number(b.slice(4)));
  let text = "";
  const rules = keys.map((key) => {
    const label = labels[key];
    if (label === undefined || !/^nda-\d+$/.test(key)) throw new Error(`odd key ${key}`);
    if (text !== "") text += "\n";
    const start = text.length;
    text += label.hypothesis.replace(/\s+/g, " ").trim();
    return {
      id: `nda:${key.slice(4)}`,
      article: key.slice(4),
      title: label.short_description,
      start,
      end: text.length,
    };
  });
  write("nda.json", {
    source: {
      id: "nda",
      title: "ContractNLI hypotheses as an NDA playbook (17 rules)",
      url: CONTRACTNLI_URL,
      sourceSha256: TRAIN_SHA256,
      licence: "CC BY 4.0",
      attribution:
        "ContractNLI, (c) Hitachi America, Ltd.; Koreeda and Manning, Findings of EMNLP 2021. " +
        "Changes: the 17 hypotheses and their short descriptions only, whitespace normalised.",
    },
    text,
    rules,
  });
  console.log(`nda: ${String(rules.length)} rules`);
});
