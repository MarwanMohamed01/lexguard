// Embeddings for the retrieval eval, cached on disk (evals/data/retrieval/, never committed).
// Embedding ~17,000 chunks on a laptop CPU takes hours, so every vector is appended to the
// cache as soon as it exists and a rerun only embeds what is missing.
//
// Two embedders of the same model (bge-m3):
//   workers-ai: the production model (@cf/baai/bge-m3) through the M3 step 1 probe Worker
//               under `wrangler dev`. Free up to 10,000 Neurons a day; the full corpus needs
//               about one day's allowance per variant, so a daily cap stops the run and the
//               next day's run resumes from the cache (D26);
//   ollama:     the same model locally. Kept for offline use, but a laptop CPU embeds about
//               160 tokens/s: ~15 hours per variant of the full corpus.
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { embeddingBatches } from "@lexguard/retrieval";
import { normalize } from "./search";

export const CACHE_DIR = new URL("../data/retrieval/", import.meta.url);
export const DIMENSIONS = 1024; // bge-m3, measured in M3 step 1 (D25)

export interface Embedded {
  vectors: Float32Array[];
  /** Neurons the provider reports for this call (Workers AI), or null when free. */
  neurons: number | null;
}

export interface Embedder {
  /** Cache file name and label in results. */
  name: string;
  /** Texts per request. */
  batch: number;
  /**
   * Padded characters per request: texts in the batch x the longest one. Workers AI pads every
   * text of a batch to the longest, and both its 60,000-token request limit and its billing
   * count the padded size (measured, D26: one 842-token text alone = 842 tokens; with four
   * 6-token texts = 4,210 tokens). 100,000 padded chars is ~31k tokens at the measured 3.19
   * chars per token, so even text twice as dense in tokens stays under the limit.
   */
  maxPaddedChars: number;
  embed(texts: readonly string[]): Promise<Embedded>;
}

/**
 * Splits texts into requests within the count and the padded-size limit, longest first: the
 * same plan the production indexing job uses (@lexguard/retrieval embeddingBatches).
 */
export function batches(
  texts: readonly string[],
  batch: number,
  maxPaddedChars: number,
): string[][] {
  return embeddingBatches(
    texts.map((t) => t.length),
    batch,
    maxPaddedChars,
  ).map((group) => group.map((i) => texts[i] ?? ""));
}

/**
 * Neurons spent by this eval per UTC day (Workers AI resets at 00:00 UTC), kept on disk so
 * the cap holds across restarts. It only knows about this eval's calls: anything else using
 * Workers AI on the same account that day is not counted, which is why the cap leaves room.
 */
export class NeuronLedger {
  private readonly file: URL;
  private readonly days: Record<string, number>;

  constructor(
    readonly dailyCap: number,
    private readonly dir: URL = CACHE_DIR,
  ) {
    if (!(dailyCap >= 0) || !Number.isFinite(dailyCap)) throw new Error("invalid Neuron cap");
    this.file = new URL("neurons.json", dir);
    this.days = existsSync(this.file)
      ? (JSON.parse(readFileSync(this.file, "utf8")) as Record<string, number>)
      : {};
  }

  static today(): string {
    return new Date().toISOString().slice(0, 10);
  }

  spentToday(): number {
    return this.days[NeuronLedger.today()] ?? 0;
  }

  canSpend(estimate: number): boolean {
    return this.spentToday() + estimate <= this.dailyCap;
  }

  record(neurons: number): void {
    const day = NeuronLedger.today();
    this.days[day] = (this.days[day] ?? 0) + neurons;
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(this.file, `${JSON.stringify(this.days, null, 2)}\n`);
  }
}

/**
 * Upper estimate for a batch: billed on the padded size (texts x longest, D26), at >= 3 chars
 * per token (3.19 measured) and 1,075 Neurons per million tokens.
 */
export const estimateNeurons = (texts: readonly string[]) =>
  ((texts.length * Math.max(0, ...texts.map((t) => t.length))) / 3) * (1_075 / 1_000_000);

const hash = (text: string) => createHash("sha256").update(text).digest("hex");

function toVector(value: unknown, texts: number): Float32Array[] {
  if (!Array.isArray(value) || value.length !== texts) {
    throw new Error(`expected ${String(texts)} vectors`);
  }
  return value.map((v: unknown) => {
    if (!Array.isArray(v) || v.length !== DIMENSIONS || !v.every((x) => typeof x === "number")) {
      throw new Error(`expected vectors of ${String(DIMENSIONS)} numbers`);
    }
    return Float32Array.from(v);
  });
}

/**
 * Ollama's /api/embed. `truncate: false` makes an over-long input an error instead of being
 * cut silently (the lesson of D25), and num_ctx is raised above our longest chunk
 * (4,000 chars + header ~ 1,400 tokens).
 */
export function ollamaEmbedder(url = "http://127.0.0.1:11434", model = "bge-m3"): Embedder {
  return {
    name: `ollama-${model}`,
    batch: 16,
    maxPaddedChars: 100_000,
    async embed(texts) {
      const response = await fetch(`${url}/api/embed`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model, input: texts, truncate: false, options: { num_ctx: 8192 } }),
      });
      if (!response.ok)
        throw new Error(`ollama ${String(response.status)}: ${await response.text()}`);
      const body = (await response.json()) as { embeddings?: unknown };
      return { vectors: toVector(body.embeddings, texts.length), neurons: null };
    },
  };
}

/** The production model through the probe Worker (experiments/embed-probe) under wrangler dev. */
export function workersAiEmbedder(url = "http://127.0.0.1:8787"): Embedder {
  return {
    name: "workers-ai-bge-m3",
    batch: 100,
    maxPaddedChars: 100_000,
    async embed(texts) {
      const response = await fetch(`${url}/embed`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: texts }),
      });
      if (!response.ok) {
        throw new Error(
          `workers ai ${String(response.status)}: ${(await response.text()).slice(0, 300)}`,
        );
      }
      const body = (await response.json()) as { data?: unknown; meta?: { neurons?: unknown } };
      const neurons = body.meta?.neurons;
      // The cap depends on this number: a result without it stops the run.
      if (typeof neurons !== "number" || !Number.isFinite(neurons)) {
        throw new Error("workers ai result has no Neuron count");
      }
      return { vectors: toVector(body.data, texts.length), neurons };
    },
  };
}

/** Vectors on disk: one JSON line per text, keyed by the SHA-256 of the exact text. */
export class EmbeddingCache {
  private readonly file: URL;
  private readonly vectors = new Map<string, Float32Array>();

  constructor(
    name: string,
    private readonly dir: URL = CACHE_DIR,
  ) {
    this.file = new URL(`${name}.jsonl`, dir);
    if (!existsSync(this.file)) return;
    for (const line of readFileSync(this.file, "utf8").split("\n")) {
      if (line.length === 0) continue;
      const { h, v } = JSON.parse(line) as { h: string; v: string };
      const bytes = Buffer.from(v, "base64");
      const vector = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
      if (vector.length === DIMENSIONS) this.vectors.set(h, Float32Array.from(vector));
    }
  }

  get(text: string): Float32Array | undefined {
    return this.vectors.get(hash(text));
  }

  missing(texts: readonly string[]): string[] {
    return [...new Set(texts)].filter((t) => !this.vectors.has(hash(t)));
  }

  /**
   * Embeds what is missing, in the given order, appending each batch to disk as it arrives.
   * With a ledger, stops before a batch that could take today's spending over the cap.
   * Returns how many texts are still missing.
   */
  async fill(
    texts: readonly string[],
    embedder: Embedder,
    progress: (done: number, total: number) => void = () => undefined,
    ledger: NeuronLedger | null = null,
  ): Promise<number> {
    const todo = this.missing(texts);
    mkdirSync(this.dir, { recursive: true });
    let done = 0;
    for (const batch of batches(todo, embedder.batch, embedder.maxPaddedChars)) {
      if (ledger !== null && !ledger.canSpend(estimateNeurons(batch))) return todo.length - done;
      const { vectors, neurons } = await embedder.embed(batch);
      if (ledger !== null && neurons !== null) ledger.record(neurons);
      const lines = batch.map((text, k) => {
        const vector = normalize(vectors[k] ?? new Float32Array(DIMENSIONS));
        this.vectors.set(hash(text), vector);
        return JSON.stringify({ h: hash(text), v: Buffer.from(vector.buffer).toString("base64") });
      });
      appendFileSync(this.file, `${lines.join("\n")}\n`);
      done += batch.length;
      progress(done, todo.length);
    }
    return 0;
  }
}
