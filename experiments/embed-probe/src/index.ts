// Embedding probe (M3 step 1, D25): what does Workers AI's bge-m3 actually return?
// Runs only under `wrangler dev` (the AI binding is always remote); nothing is deployed and
// no Cloudflare resource is created. All logic lives in run.mjs; this Worker only forwards.
//
//   POST /embed   body: JSON input for the model, e.g. { "text": ["a", "b"] }
//                 returns the model's raw result, or { error } with the message
//   POST /chat    body: { "model": <one of CHAT_MODELS>, "input": <the model's input> }
//                 (M4 step 4: the extraction eval on Workers AI, D38); same result shape
const MODEL = "@cf/baai/bge-m3";

/** The extraction candidates (D34); anything else is refused, so the probe cannot be used
 * to spend Neurons on other models by mistake. */
const CHAT_MODELS = new Set([
  "@cf/google/gemma-4-26b-a4b-it",
  "@cf/qwen/qwen3-30b-a3b-fp8",
  "@cf/openai/gpt-oss-20b",
]);

interface ProbeEnv {
  AI: Ai;
}

async function run(env: ProbeEnv, model: string, input: unknown): Promise<Response> {
  try {
    // The probe's whole point is to see the raw, untyped result.
    const result: unknown = await (
      env.AI.run.bind(env.AI) as unknown as (m: string, i: unknown) => Promise<unknown>
    )(model, input);
    return Response.json(result);
  } catch (error) {
    return Response.json({ error: String(error).slice(0, 500) }, { status: 502 });
  }
}

export default {
  async fetch(request, env): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (request.method !== "POST" || (path !== "/embed" && path !== "/chat")) {
      return new Response("not found", { status: 404 });
    }
    const body: unknown = await request.json();
    if (path === "/embed") return run(env, MODEL, body);
    const { model, input } = (body ?? {}) as { model?: unknown; input?: unknown };
    if (typeof model !== "string" || !CHAT_MODELS.has(model)) {
      return Response.json({ error: "model not allowed" }, { status: 400 });
    }
    return run(env, model, input);
  },
} satisfies ExportedHandler<ProbeEnv>;
