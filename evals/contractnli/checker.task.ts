// Runs the checker on a pinned ContractNLI subset and scores it (M5 step 5, D49). Not part
// of `npm test`: run on purpose; it resumes from the answer cache.
//   npm run check:contractnli -w @lexguard/evals
// Environment: SUBSET=<test NDAs, default 20 = 340 pairs>, TOPK=<passages, default 10>,
//   LIMIT=<pairs to ask this run>, PROVIDER=groq|workers-ai|ollama (default groq),
//   MODEL=<defaults openai/gpt-oss-20b, @cf/google/gemma-4-26b-a4b-it, llama3.1:8b>,
//   NEURON_CAP=<Workers AI, default 9,000, shared ledger with the other runs (D26)>.
// ContractNLI is public (CC BY 4.0), so Groq may read it (D34). Groq reads GROQ_API_KEY from
// evals/.env (git-ignored), loaded into this process only, never printed.
// Scores only pairs that have an answer, and says how many those are. LIMIT=0 scores the
// cache without calling any model (and without loading the key), e.g. while a run is going.
import { checkRule, CHECK_PROMPT_VERSION, buildCheckPrompt } from "@lexguard/checker";
import { getRule, ndaPlaybook, ruleText } from "@lexguard/rulebook";
import { existsSync, writeFileSync } from "node:fs";
import { it } from "vitest";
import { pinnedSubset } from "../extraction/dataset";
import { NeuronLedger } from "../retrieval/embeddings";
import {
  AnswerCache,
  groqChat,
  neuronsFor,
  ollamaChat,
  workersAiChat,
  type ChatModel,
} from "../extraction/models";
import { keywordRankings, perHypothesisLabels } from "./baselines";
import { caseNonce, checkerCases, passagesOf, toPrediction, TOP_K } from "./checker";
import { loadContractNli } from "./load";
import { scoreEvidence, scoreLabels, type NliCase } from "./score";

const CACHE_DIR = new URL("../data/contractnli/answers/", import.meta.url);

it(
  "checks and scores the pinned ContractNLI subset",
  async () => {
    const subset = Number(process.env.SUBSET ?? 20);
    const topK = Number(process.env.TOPK ?? TOP_K);
    const limit = Number(process.env.LIMIT ?? Infinity);
    const envFile = new URL("../.env", import.meta.url);
    // LIMIT=0 only scores cached answers: no model call, so the key file is not even loaded.
    const scoreOnly = limit === 0;
    if (!scoreOnly && existsSync(envFile)) process.loadEnvFile(envFile);
    const provider = process.env.PROVIDER ?? "groq";
    const model: ChatModel =
      provider === "workers-ai"
        ? workersAiChat(process.env.MODEL ?? "@cf/google/gemma-4-26b-a4b-it")
        : provider === "ollama"
          ? ollamaChat(process.env.MODEL ?? "llama3.1:8b")
          : groqChat(
              process.env.MODEL ?? "openai/gpt-oss-20b",
              scoreOnly ? "unused-when-scoring-only" : undefined,
            );
    const ledger =
      provider === "workers-ai" ? new NeuronLedger(Number(process.env.NEURON_CAP ?? 9_000)) : null;
    const cache = new AnswerCache(model.name, CHECK_PROMPT_VERSION, CACHE_DIR);

    const train = loadContractNli("train");
    const test = loadContractNli("test");
    const docs = pinnedSubset(test.docs, subset);
    const keys = [...test.hypotheses.keys()];
    const cases = checkerCases(docs, keys, keywordRankings(docs, test.hypotheses, 50), topK).map(
      (c) => {
        const rule = getRule(ndaPlaybook, c.ruleId);
        if (rule === undefined) throw new Error(`no playbook rule ${c.ruleId}`);
        const ruleInput = { id: c.ruleId, text: ruleText(ndaPlaybook, rule) };
        const passages = passagesOf(c);
        const nonce = caseNonce(ruleInput.text, passages);
        // The cache key is the exact prompt: a new rule text, passage set or prompt version
        // means a new answer.
        const prompt = buildCheckPrompt(ruleInput, passages, nonce);
        return { c, ruleInput, passages, nonce, prompt, key: prompt.user };
      },
    );

    // 1. Ask the model for every pair not yet cached (in order, so LIMIT gives a fixed prefix).
    const todo = cases.filter((x) => cache.get(x.key) === undefined).slice(0, limit);
    console.log(
      `${model.name}: ${String(todo.length)} pairs to ask, ${String(cases.length)} in subset`,
    );
    let asked = 0;
    for (const [i, x] of todo.entries()) {
      const chars = x.prompt.system.length + x.prompt.user.length;
      if (ledger !== null && !ledger.canSpend(neuronsFor(model.name, chars / 3, 2_048))) {
        console.log(`stopped at today's Neuron cap (${ledger.spentToday().toFixed(0)} spent)`);
        break;
      }
      const answer = await model.answer(x.prompt);
      cache.put(x.key, answer);
      asked++;
      if (ledger !== null) {
        ledger.record(
          neuronsFor(model.name, answer.inputTokens ?? chars / 3, answer.outputTokens ?? 2_048),
        );
      }
      console.log(
        `${String(i + 1)}/${String(todo.length)}  ${(answer.ms / 1000).toFixed(1)} s  in ${String(answer.inputTokens)} out ${String(answer.outputTokens)}`,
      );
    }
    const left = cases.filter((x) => cache.get(x.key) === undefined).length;
    console.log(
      left === 0 ? "every pair answered" : `${String(asked)} asked, ${String(left)} left`,
    );

    // 2. Score with the real checker code: the cached answer stands in for the model.
    const scored: NliCase[] = [];
    const baseline: NliCase[] = [];
    const perHyp = perHypothesisLabels(train);
    const totals = {
      failed: 0,
      downgraded: 0,
      quotesNotFound: 0,
      quotesTooShort: 0,
      labelsStripped: 0,
      ruleQuoteFound: 0,
      inputTokens: 0,
      outputTokens: 0,
      ms: 0,
    };
    for (const x of cases) {
      const answer = cache.get(x.key);
      if (answer === undefined) continue;
      totals.inputTokens += answer.inputTokens ?? 0;
      totals.outputTokens += answer.outputTokens ?? 0;
      totals.ms += answer.ms;
      const result = await checkRule(x.ruleInput, x.passages, () => Promise.resolve(answer.text), {
        nonce: x.nonce,
      });
      if (!result.ok) totals.failed++;
      else {
        if (result.downgraded) totals.downgraded++;
        totals.quotesNotFound += result.quotesNotFound;
        totals.quotesTooShort += result.quotesTooShort;
        totals.labelsStripped += result.labelsStripped;
        if (result.ruleQuote !== null) totals.ruleQuoteFound++;
      }
      scored.push({ gold: x.c.gold, predicted: toPrediction(x.c, result) });
      baseline.push({
        gold: x.c.gold,
        predicted: { choice: perHyp.get(x.c.key) ?? "Entailment", evidence: [] },
      });
    }

    const n = scored.length;
    const report = {
      model: model.name,
      promptVersion: CHECK_PROMPT_VERSION,
      subset: {
        ndas: docs.length,
        pairs: cases.length,
        answered: n,
        ids: docs.map((d) => d.id),
        topK,
      },
      ...totals,
      secondsPerPair: n === 0 ? null : totals.ms / 1000 / n,
      tokensPerPair:
        n === 0 ? null : { input: totals.inputTokens / n, output: totals.outputTokens / n },
      checker: { labels: scoreLabels(scored), evidence: scoreEvidence(scored) },
      barPerHypothesisSamePairs: scoreLabels(baseline),
    };
    const name = `contractnli-checker-${model.name.replace(/[^a-zA-Z0-9._-]+/gu, "_")}-${String(subset)}-k${String(topK)}.json`;
    writeFileSync(
      new URL(`../results/${name}`, import.meta.url),
      `${JSON.stringify(report, null, 2)}\n`,
    );
    console.log(
      JSON.stringify({
        answered: n,
        failed: totals.failed,
        downgraded: totals.downgraded,
        accuracy: report.checker.labels.accuracy,
        macroF1: report.checker.labels.macroF1,
        contradictionF1: report.checker.labels.perClass.Contradiction.f1,
        evidence: { p: report.checker.evidence.precision, r: report.checker.evidence.recall },
        barMacroF1SamePairs: report.barPerHypothesisSamePairs.macroF1,
        tokensPerPair: report.tokensPerPair,
      }),
    );
  },
  48 * 3_600_000,
);
