// Entry point of the Lexguard Worker. Cloudflare calls `fetch` once per HTTP request, and
// runs the exported Workflow classes (bound in wrangler.jsonc) as background jobs.
import { handle } from "./app";

export { ChunkDocument } from "./chunking";

export default {
  fetch(request, env): Promise<Response> {
    return handle(request, env, {
      convert: (file) => env.AI.toMarkdown(file),
      startChunking: async (params) => {
        await env.CHUNK_DOCUMENT.create({ params });
      },
    });
  },
} satisfies ExportedHandler<Env>;
