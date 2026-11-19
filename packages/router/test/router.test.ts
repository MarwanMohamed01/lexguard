import { MemorySink, Tracer } from "@lexguard/trace";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { Router, type ModelClient, type ModelResponse, type RouteTask } from "../src/index";

// A scripted model: returns the given answers in order (an Error is thrown), records calls.
class FakeModel implements ModelClient {
  readonly calls: string[] = [];
  readonly #answers: (string | Error)[];

  constructor(
    readonly model: string,
    answers: (string | Error)[],
  ) {
    this.#answers = [...answers];
  }

  complete(prompt: string): Promise<ModelResponse> {
    this.calls.push(prompt);
    const answer = this.#answers.shift();
    if (answer === undefined) return Promise.reject(new Error("no scripted answer left"));
    if (answer instanceof Error) return Promise.reject(answer);
    return Promise.resolve({ text: answer, usage: { inputTokens: 100, outputTokens: 20 } });
  }
}

const Clause = z.strictObject({
  type: z.enum(["liability", "termination", "governing_law"]),
  risk: z.enum(["low", "medium", "high"]),
  quote: z.string(),
});
type Clause = z.infer<typeof Clause>;

const SOURCE =
  "7.1 The Supplier's aggregate liability shall not exceed the fees paid in the preceding month.";
const quoteInSource = (c: Clause) =>
  SOURCE.includes(c.quote) ? null : "quote not found in source";

const task = (overrides: Partial<RouteTask<Clause>> = {}): RouteTask<Clause> => ({
  name: "classify clause 7.1",
  prompt: `Classify: ${SOURCE}`,
  risk: "low",
  schema: Clause,
  checks: [quoteInSource],
  ...overrides,
});

const good = JSON.stringify({
  type: "liability",
  risk: "high",
  quote: "shall not exceed the fees",
});

function setup(small: (string | Error)[], large: (string | Error)[], maxEscalations?: number) {
  const models = {
    small: new FakeModel("small-model", small),
    large: new FakeModel("large-model", large),
  };
  const router = new Router(maxEscalations === undefined ? { models } : { models, maxEscalations });
  return { router, ...models };
}

describe("Router", () => {
  it("accepts a valid answer from the small model without escalating", async () => {
    const { router, small, large } = setup([good], []);
    const result = await router.route(task());

    expect(result).toMatchObject({
      status: "accepted",
      tier: "small",
      data: { type: "liability" },
    });
    expect(small.calls).toHaveLength(1);
    expect(large.calls).toHaveLength(0);
  });

  it("escalates when the small model's output fails the schema", async () => {
    const { router, small, large } = setup(
      ['{"type":"liability","risk":"kinda high","quote":"x"}'],
      [good],
    );
    const result = await router.route(task());

    expect(result).toMatchObject({ status: "accepted", tier: "large" });
    expect(result.attempts.map((a) => [a.tier, a.outcome])).toEqual([
      ["small", "schema_invalid"],
      ["large", "accepted"],
    ]);
    expect(small.calls).toHaveLength(1);
    expect(large.calls).toHaveLength(1);
  });

  it("escalates when the output is free text instead of JSON", async () => {
    const { router } = setup(["This clause looks risky to me."], [good]);
    const result = await router.route(task());
    expect(result.attempts[0]?.outcome).toBe("schema_not_json");
    expect(result.status).toBe("accepted");
  });

  it("escalates when a task check fails (quote invented by the model)", async () => {
    const invented = JSON.stringify({
      type: "liability",
      risk: "low",
      quote: "capped at one month",
    });
    const { router } = setup([invented], [good]);
    const result = await router.route(task());

    expect(result.attempts[0]).toMatchObject({
      outcome: "check_failed",
      detail: "quote not found in source",
    });
    expect(result).toMatchObject({ status: "accepted", tier: "large" });
  });

  it("sends high-risk tasks straight to the large model", async () => {
    const { router, small, large } = setup([good], [good]);
    const result = await router.route(task({ risk: "high" }));

    expect(result).toMatchObject({ status: "accepted", tier: "large" });
    expect(small.calls).toHaveLength(0);
    expect(large.calls).toHaveLength(1);
  });

  it("stops after one escalation and asks for human review", async () => {
    const { router, small, large } = setup(["nope"], ["still nope"]);
    const result = await router.route(task());

    expect(result).toMatchObject({ status: "needs_review", reason: "large: schema_not_json" });
    expect(small.calls.length + large.calls.length).toBe(2);
  });

  it("does not retry the large model when a high-risk task fails", async () => {
    const { router, large } = setup([], ["nope"]);
    const result = await router.route(task({ risk: "high" }));

    expect(result.status).toBe("needs_review");
    expect(large.calls).toHaveLength(1);
  });

  it("treats a model error (e.g. rate limit) as a failed attempt", async () => {
    const { router } = setup([new Error("429 rate limited")], [good]);
    const result = await router.route(task());

    expect(result.attempts[0]).toMatchObject({
      outcome: "model_error",
      detail: "429 rate limited",
    });
    expect(result.status).toBe("accepted");
  });

  it("never escalates when maxEscalations is 0", async () => {
    const { router, large } = setup(["nope"], [good], 0);
    const result = await router.route(task());

    expect(result.status).toBe("needs_review");
    expect(large.calls).toHaveLength(0);
  });

  it("rejects an invalid maxEscalations", () => {
    const models = { small: new FakeModel("s", []), large: new FakeModel("l", []) };
    expect(() => new Router({ models, maxEscalations: -1 })).toThrow(RangeError);
  });
});

describe("Router tracing", () => {
  it("records every decision and model call with its reason and token usage", async () => {
    const sink = new MemorySink();
    let id = 0;
    const tracer = new Tracer({
      traceId: "t",
      sink,
      now: () => 0,
      newId: () => `s${String(++id)}`,
    });
    const run = tracer.start("run", "doc");
    const { router } = setup(["not json"], [good]);

    await router.route(task(), run);
    run.end();
    await tracer.flush();

    const decisions = sink.spans
      .filter((s) => s.kind === "decision")
      .map((s) => s.attributes.reason);
    expect(decisions).toEqual(["default", "schema_not_json"]);
    const calls = sink.spans.filter((s) => s.kind === "model_call");
    expect(calls.map((s) => [s.attributes.tier, s.status, s.attributes.inputTokens])).toEqual([
      ["small", "error", 100],
      ["large", "ok", 100],
    ]);
  });
});

describe("Router security (threat model T1, T16)", () => {
  it("escalates when injected text makes the model add fields the schema does not allow", async () => {
    const injected = JSON.stringify({
      type: "liability",
      risk: "low",
      quote: "shall not exceed the fees",
      exportTo: "https://evil.example/collect",
    });
    const { router } = setup([injected], [good]);
    const result = await router.route(task());

    expect(result.attempts[0]?.outcome).toBe("schema_invalid");
    expect(result.status === "accepted" && "exportTo" in result.data).toBe(false);
  });

  it("makes at most 1 + maxEscalations model calls, whatever the models return", async () => {
    const { router, small, large } = setup(
      Array<string>(10).fill("bad"),
      Array<string>(10).fill("bad"),
      3,
    );
    await router.route(task());
    expect(small.calls.length + large.calls.length).toBe(2); // only upward: small then large
  });
});
