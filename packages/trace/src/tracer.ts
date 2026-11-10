import { estimateCostUsd, type ModelUsage, type PriceTable } from "./cost";
import { redactAttribute, scrubSecrets, type Redactor } from "./redact";
import { Span, type AttributeValue, type Attributes, type SpanKind } from "./schema";

// Where finished spans go. M1 ships MemorySink for tests; M8 adds a D1 sink.
export interface TraceSink {
  write(spans: readonly Span[]): Promise<void>;
}

export class MemorySink implements TraceSink {
  readonly spans: Span[] = [];

  write(spans: readonly Span[]): Promise<void> {
    this.spans.push(...spans);
    return Promise.resolve();
  }
}

export interface TracerOptions {
  traceId: string;
  sink: TraceSink;
  // Clock and ID generator are injected so tests are deterministic and the package
  // does not depend on any runtime global (a Worker passes Date.now and crypto.randomUUID).
  now: () => number;
  newId: () => string;
  prices?: PriceTable;
  redact?: Redactor;
}

export interface SpanHandle {
  readonly id: string;
  child(kind: SpanKind, name: string, attributes?: Attributes): SpanHandle;
  set(key: string, value: AttributeValue): void;
  recordModelUsage(usage: ModelUsage): void;
  end(attributes?: Attributes): void;
  fail(error: unknown, attributes?: Attributes): void;
}

// Builds a tree of spans for one trace. Finished spans are buffered and written in
// batches by flush(), because D1 row writes are a daily-limited free-tier budget.
export class Tracer {
  readonly #options: TracerOptions;
  readonly #redact: Redactor;
  #finished: Span[] = [];
  #openCount = 0;

  constructor(options: TracerOptions) {
    this.#options = options;
    this.#redact = options.redact ?? scrubSecrets;
  }

  start(kind: SpanKind, name: string, attributes: Attributes = {}): SpanHandle {
    return this.#open(null, kind, name, attributes);
  }

  get openSpans(): number {
    return this.#openCount;
  }

  // Writes all finished spans. On sink failure the batch is kept for the next flush.
  async flush(): Promise<number> {
    const batch = this.#finished;
    if (batch.length === 0) return 0;
    this.#finished = [];
    try {
      await this.#options.sink.write(batch);
    } catch (error) {
      this.#finished = batch.concat(this.#finished);
      throw error;
    }
    return batch.length;
  }

  #open(parentId: string | null, kind: SpanKind, name: string, attributes: Attributes): SpanHandle {
    const options = this.#options;
    const redact = this.#redact;
    const id = options.newId();
    const startMs = options.now();
    const attrs: Attributes = {};
    let ended = false;
    this.#openCount++;

    const set = (key: string, value: AttributeValue): void => {
      attrs[key] = redactAttribute(key, value, redact);
    };
    const setAll = (values: Attributes): void => {
      for (const [key, value] of Object.entries(values)) set(key, value);
    };
    const finish = (status: "ok" | "error", error: string | null): void => {
      if (ended) throw new Error(`span "${name}" already ended`);
      ended = true;
      this.#openCount--;
      // Parsing here guarantees every span that reaches a sink matches the schema.
      this.#finished.push(
        Span.parse({
          id,
          traceId: options.traceId,
          parentId,
          kind,
          name: redact(name),
          startMs,
          endMs: options.now(),
          status,
          error,
          attributes: attrs,
        }),
      );
    };

    setAll(attributes);

    return {
      id,
      child: (childKind, childName, childAttributes = {}) => {
        if (ended) throw new Error(`cannot add a child to ended span "${name}"`);
        return this.#open(id, childKind, childName, childAttributes);
      },
      set,
      recordModelUsage: (usage) => {
        set("model", usage.model);
        set("inputTokens", usage.inputTokens);
        set("outputTokens", usage.outputTokens);
        set("costUsd", estimateCostUsd(usage, options.prices ?? {}));
      },
      end: (endAttributes = {}) => {
        setAll(endAttributes);
        finish("ok", null);
      },
      fail: (error, failAttributes = {}) => {
        setAll(failAttributes);
        const message = error instanceof Error ? error.message : String(error);
        finish("error", redact(message));
      },
    };
  }
}
