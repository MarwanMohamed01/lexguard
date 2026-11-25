// Fills the embedding cache for the retrieval eval. Not a test: run on purpose; it resumes
// where it stopped. Default: the production model on Workers AI, through the probe Worker
// (start it first: npx wrangler dev -c experiments/embed-probe/wrangler.jsonc), capped at
// 9,000 Neurons per UTC day of the free 10,000 (D26). Run it again on later days until it
// reports nothing left.
//   npm run embed:cuad -w @lexguard/evals
// Options (environment): EMBEDDER=ollama (local, slow, no cap), NEURON_CAP=<n>.
//
// Order: the 41 queries, the 30 converted PDFs (both variants), then the 510 CUAD texts with
// the header, then without. So day 1 already gives complete results for the real PDFs.
import { it } from "vitest";
import { corpusInputs } from "./dataset";
import { EmbeddingCache, NeuronLedger, ollamaEmbedder, workersAiEmbedder } from "./embeddings";
import { loadCorpora, loadQueries } from "./sources";

it(
  "fills the embedding cache",
  async () => {
    const local = process.env.EMBEDDER === "ollama";
    const embedder = local ? ollamaEmbedder() : workersAiEmbedder();
    const ledger = local ? null : new NeuronLedger(Number(process.env.NEURON_CAP ?? 9_000));
    const { text, converted } = loadCorpora();

    // Filled one group at a time: batching sorts texts by length within a group (D26).
    const groups = [
      [...loadQueries().values()],
      ...(converted === null
        ? []
        : [corpusInputs(converted, "plain"), corpusInputs(converted, "header")]),
      corpusInputs(text, "header"),
      corpusInputs(text, "plain"),
    ];
    const texts = groups.flat();
    const cache = new EmbeddingCache(embedder.name);
    const todo = cache.missing(texts).length;
    console.log(
      `${embedder.name}: ${String(todo)} of ${String(new Set(texts).size)} texts to embed`,
    );
    if (ledger !== null) {
      console.log(
        `Neurons spent today (UTC): ${ledger.spentToday().toFixed(0)} of ${String(ledger.dailyCap)}`,
      );
    }

    let left = 0;
    for (const [g, group] of groups.entries()) {
      const started = Date.now();
      let last = 0;
      left = await cache.fill(
        group,
        embedder,
        (done, total) => {
          if (done - last < 500 && done !== total) return;
          last = done;
          const spent = ledger === null ? "" : `, ${ledger.spentToday().toFixed(0)} Neurons today`;
          console.log(
            `group ${String(g + 1)}/${String(groups.length)}: ${String(done)}/${String(total)}  ${((Date.now() - started) / done).toFixed(0)} ms per text${spent}`,
          );
        },
        ledger,
      );
      if (left > 0) {
        left = cache.missing(texts).length;
        break;
      }
    }
    console.log(
      left === 0
        ? "done: every text is embedded"
        : `stopped at today's Neuron cap: ${String(left)} texts left, run again after 00:00 UTC`,
    );
  },
  24 * 3_600_000,
);
