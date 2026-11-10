import { z } from "zod";

// What kind of work a span describes. A run contains steps; steps contain calls and decisions.
export const SpanKind = z.enum(["run", "step", "model_call", "tool_call", "decision"]);
export type SpanKind = z.infer<typeof SpanKind>;

// Attribute values are kept flat and JSON-friendly so they store cleanly in D1 later.
export const AttributeValue = z.union([z.string(), z.number(), z.boolean(), z.null()]);
export type AttributeValue = z.infer<typeof AttributeValue>;

export type Attributes = Record<string, AttributeValue>;

// A finished span: the unit written to a sink. Times are milliseconds from the injected clock.
export const Span = z
  .object({
    id: z.string().min(1),
    traceId: z.string().min(1),
    parentId: z.string().min(1).nullable(),
    kind: SpanKind,
    name: z.string().min(1),
    startMs: z.number().nonnegative(),
    endMs: z.number().nonnegative(),
    status: z.enum(["ok", "error"]),
    error: z.string().nullable(),
    attributes: z.record(z.string(), AttributeValue),
  })
  .refine((span) => span.endMs >= span.startMs, { message: "endMs must be >= startMs" });
export type Span = z.infer<typeof Span>;
