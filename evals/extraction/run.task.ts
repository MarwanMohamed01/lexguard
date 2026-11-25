// Runs the extractor on a pinned CUAD subset and scores it (M4 step 4). Not part of
// `npm test`: run on purpose, it resumes from the answer cache.
//   npm run extract:cuad -w @lexguard/evals
// Environment: SUBSET=<contracts, default 10>, LIMIT=<chunks to ask the model this run>,
//   PROVIDER=ollama|groq|workers-ai (default ollama), MODEL=<model; defaults llama3.1:8b,
//   openai/gpt-oss-20b, @cf/google/gemma-4-26b-a4b-it>, NEURON_CAP=<Workers AI, default 9,000>.
// Groq reads GROQ_API_KEY from evals/.env (git-ignored), loaded into this process only.
// Workers AI goes through the probe Worker (npx wrangler dev -c experiments/embed-probe/
// wrangler.jsonc) and shares the embedding run's daily Neuron ledger (D26), so the two
// together never pass the cap.
// Scores only chunks that have an answer, and says how many those are.
import { existsSync, writeFileSync } from "node:fs";
import { it } from "vitest";
import {
  buildPrompt,
  CLAUSE_TYPE_NAMES,
  extractClauses,
  PROMPT_VERSION,
} from "@lexguard/extraction";
import { loadCuad } from "../cuad/load";
import { loadQueries } from "../retrieval/sources";
import { keywordTop1 } from "./baselines";
import { extractionCorpus, pinnedSubset, type ExtractionDoc } from "./dataset";
import { NeuronLedger } from "../retrieval/embeddings";
import {
  AnswerCache,
  evalNonce,
  groqChat,
  neuronsFor,
  ollamaChat,
  workersAiChat,
  type ChatModel,
} from "./models";
import { scoreChunk, TypeTally } from "./score";

it(
  "extracts and scores the pinned subset",
  async () => {
    const subset = Number(process.env.SUBSET ?? 10);
    const limit = Number(process.env.LIMIT ?? Infinity);
    const envFile = new URL("../.env", import.meta.url);
    if (existsSync(envFile)) process.loadEnvFile(envFile);
    const provider = process.env.PROVIDER ?? "ollama";
    const model: ChatModel =
      provider === "groq"
        ? groqChat(process.env.MODEL ?? "openai/gpt-oss-20b")
        : provider === "workers-ai"
          ? workersAiChat(process.env.MODEL ?? "@cf/google/gemma-4-26b-a4b-it")
          : ollamaChat(process.env.MODEL ?? "llama3.1:8b");
    const ledger =
      provider === "workers-ai" ? new NeuronLedger(Number(process.env.NEURON_CAP ?? 9_000)) : null;
    const cache = new AnswerCache(model.name, PROMPT_VERSION);
    const docs: ExtractionDoc[] = pinnedSubset(extractionCorpus(loadCuad()), subset);
    const chunks = docs.flatMap((doc) =>
      doc.chunks.map((chunk) => ({ doc, chunk, text: doc.text.slice(chunk.start, chunk.end) })),
    );

    // 1. Ask the model for every chunk not yet cached (in order, so LIMIT gives a fixed prefix).
    const todo = chunks.filter((c) => cache.get(c.text) === undefined).slice(0, limit);
    console.log(
      `${model.name}: ${String(todo.length)} chunks to ask, ${String(chunks.length)} in subset`,
    );
    const started = Date.now();
    let asked = 0;
    for (const [i, c] of todo.entries()) {
      // The prompt the extractor builds; the extractor itself runs in step 2 below.
      const prompt = buildPrompt(c.text, evalNonce(c.text));
      if (ledger !== null) {
        // Worst case before the call (3 characters per token, 2,048 output tokens).
        const estimate = neuronsFor(
          model.name,
          (prompt.system.length + prompt.user.length) / 3,
          2_048,
        );
        if (!ledger.canSpend(estimate)) {
          console.log(`stopped at today's Neuron cap (${ledger.spentToday().toFixed(0)} spent)`);
          break;
        }
      }
      const answer = await model.answer(prompt);
      cache.put(c.text, answer);
      asked++;
      if (ledger !== null) {
        // Usage reported by the model, or the estimate from characters when there is none.
        const input = answer.inputTokens ?? (prompt.system.length + prompt.user.length) / 3;
        ledger.record(neuronsFor(model.name, input, answer.outputTokens ?? 2_048));
      }
      const avg = (Date.now() - started) / (i + 1);
      console.log(
        `${String(i + 1)}/${String(todo.length)}  ${(answer.ms / 1000).toFixed(1)} s  in ${String(answer.inputTokens)} out ${String(answer.outputTokens)}  ~${((avg * (todo.length - i - 1)) / 60_000).toFixed(0)} min left`,
      );
    }

    const left = chunks.filter((c) => cache.get(c.text) === undefined).length;
    console.log(
      left === 0
        ? "extraction: every chunk answered"
        : `extraction: ${String(asked)} asked this run, ${String(left)} chunks left`,
    );

    // 2. Score with the real extractor code: the cached answer stands in for the model.
    const known = new Set<string>(CLAUSE_TYPE_NAMES);
    const tally = new TypeTally([...CLAUSE_TYPE_NAMES]);
    const keywordTally = new TypeTally([...CLAUSE_TYPE_NAMES]);
    const keyword = keywordTop1(docs, loadQueries());
    const totals = {
      answered: 0,
      failed: { not_json: 0, schema: 0, too_large: 0 },
      accepted: 0,
      grounded: 0,
      rejected: { invalid: 0, quoteNotFound: 0, duplicate: 0 },
      relocated: 0,
      inputTokens: 0,
      outputTokens: 0,
      ms: 0,
    };
    for (const { doc, chunk, text } of chunks) {
      const answer = cache.get(text);
      if (answer === undefined) continue;
      totals.answered++;
      totals.inputTokens += answer.inputTokens ?? 0;
      totals.outputTokens += answer.outputTokens ?? 0;
      totals.ms += answer.ms;
      const result = await extractClauses(text, () => Promise.resolve(answer.text), {
        nonce: evalNonce(text),
      });
      let predicted = new Set<string>();
      if (!result.ok) {
        totals.failed[result.reason]++;
      } else {
        for (const k of Object.keys(totals.rejected) as (keyof typeof totals.rejected)[]) {
          totals.rejected[k] += result.rejected[k];
        }
        totals.relocated += result.relocated;
        // The eval's own judge re-checks every accepted clause (independent of the extractor).
        const judged = scoreChunk(chunk, text, result.clauses, known);
        totals.accepted += judged.accepted;
        totals.grounded += judged.grounded;
        predicted = judged.predicted;
      }
      tally.add(chunk.expected, predicted);
      const d = docs.indexOf(doc);
      keywordTally.add(chunk.expected, keyword[d]?.[chunk.idx] ?? new Set());
    }

    const report = {
      model: model.name,
      promptVersion: PROMPT_VERSION,
      subset: { contracts: docs.length, chunks: chunks.length, titles: docs.map((d) => d.title) },
      ...totals,
      secondsPerChunk: totals.answered === 0 ? null : totals.ms / 1000 / totals.answered,
      tokensPerChunk:
        totals.answered === 0
          ? null
          : {
              input: totals.inputTokens / totals.answered,
              output: totals.outputTokens / totals.answered,
            },
      extractor: tally.report(),
      keywordSameChunks: keywordTally.report(),
    };
    const name = `cuad-extraction-${model.name.replace(/[^a-zA-Z0-9._-]+/gu, "_")}-${String(subset)}.json`;
    writeFileSync(
      new URL(`../results/${name}`, import.meta.url),
      `${JSON.stringify(report, null, 2)}\n`,
    );
    console.log(
      JSON.stringify({
        answered: totals.answered,
        failed: totals.failed,
        accepted: totals.accepted,
        grounded: totals.grounded,
        rejected: totals.rejected,
        relocated: totals.relocated,
        secondsPerChunk: report.secondsPerChunk,
        tokensPerChunk: report.tokensPerChunk,
        extractor: report.extractor.micro,
        extractorMacroF1: report.extractor.macroF1,
        keyword: report.keywordSameChunks.micro,
      }),
    );
  },
  48 * 3_600_000,
);
