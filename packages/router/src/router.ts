import { parseModelOutput } from "@lexguard/guardrails";
import type { SpanHandle } from "@lexguard/trace";
import type { z } from "zod";

// Model routing: a cheap model first, a stronger one only when needed. The decision is plain,
// deterministic code, never a model: it uses objective signals (risk level known before the
// call, schema validation, task-specific checks such as "the quote exists in the source").
// A well-formed but wrong answer from the small model is NOT caught here; evals measure that.

export type Tier = "small" | "large";
export type Risk = "low" | "medium" | "high";

export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface ModelResponse {
  text: string;
  usage: ModelUsage;
}

// Anything that can answer a prompt: Workers AI, Gemini, Groq, or a fake in tests.
export interface ModelClient {
  readonly model: string;
  complete(prompt: string): Promise<ModelResponse>;
}

// A task-specific check on validated output. Returns null when it passes, or a short reason.
export type OutputCheck<T> = (data: T) => string | null;

export interface RouteTask<T> {
  name: string;
  prompt: string;
  // Known before any model call (e.g. the extractor flagged a liability clause).
  risk: Risk;
  schema: z.ZodType<T>;
  checks?: readonly OutputCheck<T>[];
}

export interface RouterConfig {
  models: Readonly<Record<Tier, ModelClient>>;
  // Escalations allowed per task. 1 means: small, then large, then human review.
  maxEscalations?: number;
  // Risk levels that skip the small model.
  largeFirstFor?: readonly Risk[];
}

export type AttemptOutcome =
  | "accepted"
  | "model_error"
  | "schema_too_large"
  | "schema_not_json"
  | "schema_invalid"
  | "check_failed";

export interface Attempt {
  tier: Tier;
  model: string;
  outcome: AttemptOutcome;
  detail: string | null;
  usage: ModelUsage | null;
}

export type RouteResult<T> =
  | { status: "accepted"; data: T; tier: Tier; attempts: Attempt[] }
  | { status: "needs_review"; attempts: Attempt[]; reason: string };

export class Router {
  readonly #models: Readonly<Record<Tier, ModelClient>>;
  readonly #maxEscalations: number;
  readonly #largeFirstFor: readonly Risk[];

  constructor(config: RouterConfig) {
    const maxEscalations = config.maxEscalations ?? 1;
    if (!Number.isInteger(maxEscalations) || maxEscalations < 0) {
      throw new RangeError("maxEscalations must be a non-negative integer");
    }
    this.#models = config.models;
    this.#maxEscalations = maxEscalations;
    this.#largeFirstFor = config.largeFirstFor ?? ["high"];
  }

  async route<T>(task: RouteTask<T>, parent?: SpanHandle): Promise<RouteResult<T>> {
    const attempts: Attempt[] = [];
    let tier: Tier = this.#largeFirstFor.includes(task.risk) ? "large" : "small";
    decide(
      parent,
      task,
      "initial",
      tier,
      this.#largeFirstFor.includes(task.risk) ? "high_risk" : "default",
    );

    // Hard cap on calls: 1 + maxEscalations. No loop can run longer (threat model T16).
    for (let call = 0; call <= this.#maxEscalations; call++) {
      const attempt = await this.#attempt(task, tier, parent);
      attempts.push(attempt.record);
      if (attempt.record.outcome === "accepted") {
        return { status: "accepted", data: attempt.data as T, tier, attempts };
      }
      // Only escalate upward; a failing large model goes straight to human review.
      const canEscalate = tier === "small" && call < this.#maxEscalations;
      if (!canEscalate) break;
      tier = "large";
      decide(parent, task, "escalate", tier, attempt.record.outcome);
    }

    const last = attempts.at(-1);
    const reason = last === undefined ? "no attempt" : `${last.tier}: ${last.outcome}`;
    decide(parent, task, "needs_review", null, reason);
    return { status: "needs_review", attempts, reason };
  }

  async #attempt<T>(
    task: RouteTask<T>,
    tier: Tier,
    parent: SpanHandle | undefined,
  ): Promise<{ record: Attempt; data?: T }> {
    const client = this.#models[tier];
    const span = parent?.child("model_call", `${task.name} (${tier})`, {
      tier,
      model: client.model,
    });
    const record = (outcome: AttemptOutcome, detail: string | null, usage: ModelUsage | null) => {
      span?.set("outcome", outcome);
      if (outcome === "accepted") span?.end();
      else span?.fail(detail ?? outcome);
      return { tier, model: client.model, outcome, detail, usage };
    };

    let response: ModelResponse;
    try {
      response = await client.complete(task.prompt);
    } catch (error) {
      return {
        record: record("model_error", error instanceof Error ? error.message : String(error), null),
      };
    }
    span?.recordModelUsage({ model: client.model, ...response.usage });

    const parsed = parseModelOutput(task.schema, response.text);
    if (!parsed.ok) {
      const outcome =
        parsed.reason === "schema" ? "schema_invalid" : (`schema_${parsed.reason}` as const);
      const detail = [parsed.message, ...parsed.issues].join("; ");
      return { record: record(outcome, detail, response.usage) };
    }

    for (const check of task.checks ?? []) {
      const failure = check(parsed.data);
      if (failure !== null) return { record: record("check_failed", failure, response.usage) };
    }
    return { record: record("accepted", null, response.usage), data: parsed.data };
  }
}

function decide(
  parent: SpanHandle | undefined,
  task: { name: string; risk: Risk },
  step: "initial" | "escalate" | "needs_review",
  tier: Tier | null,
  reason: string,
): void {
  parent
    ?.child("decision", `route ${task.name}: ${step}`, { step, tier, reason, risk: task.risk })
    .end();
}
