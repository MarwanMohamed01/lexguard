import { z } from "zod";
import type { Prompt } from "./prompt";

// The Workers AI chat request and response for the extractor, shared by the production
// Workflow (apps/worker) and the eval (evals/extraction), so the eval measures exactly what
// production sends and reads (D38).
//
// Found in step 4: gemma-4 has "thinking" on by default (chat_template_kwargs.enable_thinking,
// default true) and spent all 2,048 output tokens on it, returning no answer; and it answers
// in the OpenAI shape (choices[0].message.content), not in `response` as older models do.

export const MAX_OUTPUT_TOKENS = 2_048;

export function workersAiChatInput(prompt: Prompt) {
  return {
    messages: [
      { role: "system", content: prompt.system },
      { role: "user", content: prompt.user },
    ],
    max_completion_tokens: MAX_OUTPUT_TOKENS,
    temperature: 0,
    response_format: { type: "json_object" },
    // Hidden reasoning costs output tokens (Neurons) and here bought no answer at all.
    chat_template_kwargs: { enable_thinking: false },
  };
}

const Content = z.union([z.string(), z.record(z.string(), z.unknown())]).nullish();

/** Data from outside: validated, unknown fields ignored. */
const ChatResult = z.object({
  // OpenAI shape (gemma-4 and newer models).
  choices: z
    .array(
      z.object({
        message: z.object({ content: Content }).optional(),
        finish_reason: z.string().nullish(),
      }),
    )
    .optional(),
  // Older Workers AI shape.
  response: Content,
  usage: z
    .object({
      prompt_tokens: z.number().optional(),
      completion_tokens: z.number().optional(),
    })
    .optional(),
});

export interface ChatAnswer {
  /** The model's answer as text ("" when there is none). */
  text: string;
  inputTokens: number | null;
  outputTokens: number | null;
  /** "stop", or e.g. "length" when the output cap was hit; null when not reported. */
  finishReason: string | null;
}

const asText = (content: z.infer<typeof Content>): string | null =>
  content === null || content === undefined
    ? null
    : typeof content === "string"
      ? content
      : JSON.stringify(content); // JSON mode may return the object already parsed

export function parseWorkersAiChat(raw: unknown): ChatAnswer {
  const result = ChatResult.parse(raw);
  const choice = result.choices?.[0];
  return {
    text: asText(choice?.message?.content) ?? asText(result.response) ?? "",
    inputTokens: result.usage?.prompt_tokens ?? null,
    outputTokens: result.usage?.completion_tokens ?? null,
    finishReason: choice?.finish_reason ?? null,
  };
}
