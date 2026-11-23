// Entry point of the Lexguard Worker. Cloudflare calls `fetch` once per HTTP request, and
// runs the exported Workflow classes (bound in wrangler.jsonc) as background jobs.
import { handle } from "./app";

export { ChunkDocument } from "./chunking";

export default {
  fetch(request, env): Promise<Response> {
    return handle(request, env, {
      convert: (file) => env.AI.toMarkdown(file),
      startChunking: async (params) => {
        // The ticket doubles as the instance ID: one instance per ticket, never two.
        await env.CHUNK_DOCUMENT.create({ id: params.jobId, params });
      },
    });
  },
} satisfies ExportedHandler<Env>;
