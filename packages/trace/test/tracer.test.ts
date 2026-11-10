import { describe, expect, it } from "vitest";
import { Span, type TraceSink } from "../src/index";
import { makeTracer } from "./helpers";

describe("Tracer", () => {
  it("builds a parent/child tree with timings", async () => {
    const { tracer, sink, advance } = makeTracer();

    const run = tracer.start("run", "analyze nda.pdf", { pages: 12 });
    advance(5);
    const step = run.child("step", "extract batch 1");
    advance(40);
    step.end({ clauses: 7 });
    advance(5);
    run.end();
    await tracer.flush();

    const [stepSpan, runSpan] = sink.spans;
    expect(runSpan).toMatchObject({
      id: "span-1",
      parentId: null,
      kind: "run",
      startMs: 1_000,
      endMs: 1_050,
      status: "ok",
      attributes: { pages: 12 },
    });
    expect(stepSpan).toMatchObject({
      id: "span-2",
      parentId: "span-1",
      startMs: 1_005,
      endMs: 1_045,
      attributes: { clauses: 7 },
    });
  });

  it("records failures with status and message", async () => {
    const { tracer, sink } = makeTracer();

    tracer.start("tool_call", "rulebook.lookup").fail(new Error("timeout after 5s"));
    await tracer.flush();

    expect(sink.spans[0]).toMatchObject({ status: "error", error: "timeout after 5s" });
  });

  it("records model usage and estimated cost", async () => {
    const { tracer, sink } = makeTracer({
      prices: { "small-model": { inputPerMTokUsd: 0.1, outputPerMTokUsd: 0.4 } },
    });

    const call = tracer.start("model_call", "extract");
    call.recordModelUsage({ model: "small-model", inputTokens: 1_000_000, outputTokens: 500_000 });
    call.end();
    await tracer.flush();

    expect(sink.spans[0]?.attributes).toEqual({
      model: "small-model",
      inputTokens: 1_000_000,
      outputTokens: 500_000,
      costUsd: 0.3,
    });
  });

  it("refuses to end a span twice or add children to an ended span", () => {
    const { tracer } = makeTracer();
    const span = tracer.start("step", "once");
    span.end();

    expect(() => {
      span.end();
    }).toThrow(/already ended/);
    expect(() => span.child("step", "late")).toThrow(/ended span/);
  });

  it("tracks open spans and only flushes finished ones", async () => {
    const { tracer, sink } = makeTracer();
    const run = tracer.start("run", "r");
    run.child("step", "done").end();

    expect(tracer.openSpans).toBe(1);
    expect(await tracer.flush()).toBe(1);
    expect(await tracer.flush()).toBe(0);
    expect(sink.spans).toHaveLength(1);
  });

  it("keeps the batch when the sink fails, so the next flush retries it", async () => {
    let fail = true;
    const written: Span[] = [];
    const flakySink: TraceSink = {
      write: (spans) => {
        if (fail) return Promise.reject(new Error("D1 unavailable"));
        written.push(...spans);
        return Promise.resolve();
      },
    };
    const { tracer } = makeTracer({ sink: flakySink });
    tracer.start("step", "a").end();

    await expect(tracer.flush()).rejects.toThrow("D1 unavailable");
    fail = false;
    expect(await tracer.flush()).toBe(1);
    expect(written).toHaveLength(1);
  });

  it("only writes spans that match the schema", async () => {
    const { tracer, sink } = makeTracer();
    tracer.start("decision", "route", { escalated: true, reason: "schema_fail" }).end();
    await tracer.flush();

    expect(() => Span.parse(sink.spans[0])).not.toThrow();
  });
});
