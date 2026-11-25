// Embedding probe (M3 step 1, D25): what does Workers AI's bge-m3 actually return?
// Runs only under `wrangler dev` (the AI binding is always remote); nothing is deployed and
// no Cloudflare resource is created. All logic lives in run.mjs; this Worker only forwards.
//
//   POST /embed   body: JSON input for the model, e.g. { "text": ["a", "b"] }
//                 returns the model's raw result, or { error } with the message
const MODEL = "@cf/baai/bge-m3";

interface ProbeEnv {
  AI: Ai;
}

export default {
  async fetch(request, env): Promise<Response> {
    if (new URL(request.url).pathname !== "/embed" || request.method !== "POST") {
      return new Response("not found", { status: 404 });
    }
    const input: unknown = await request.json();
    try {
      // The probe's whole point is to see the raw, untyped result.
      const result: unknown = await env.AI.run(MODEL, input as never);
      return Response.json(result);
    } catch (error) {
      return Response.json({ error: String(error).slice(0, 500) }, { status: 502 });
    }
  },
} satisfies ExportedHandler<ProbeEnv>;
