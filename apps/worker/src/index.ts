// Entry point of the Lexguard Worker. Cloudflare calls `fetch` once per HTTP request, and
// runs the exported Workflow classes (bound in wrangler.jsonc) as background jobs.
import { handle } from "./app";
import { vectorIndex, workersAiEmbedder } from "./indexing";
import { CONVERSION_OPTIONS } from "./upload";

export { ChunkDocument } from "./chunking";
export { IndexDocument } from "./indexing";
export { ExtractDocument } from "./extraction";
export { TenantAuth } from "./tenant-auth";

export default {
  fetch(request, env): Promise<Response> {
    return handle(request, env, {
      convert: (file) => env.AI.toMarkdown(file, CONVERSION_OPTIONS),
      startChunking: async (params) => {
        // The ticket doubles as the instance ID: one instance per ticket, never two.
        await env.CHUNK_DOCUMENT.create({ id: params.jobId, params });
      },
      startIndexing: async (params) => {
        await env.INDEX_DOCUMENT.create({ id: params.jobId, params });
      },
      search: { embed: workersAiEmbedder(env.AI), vectors: vectorIndex(env) },
      startExtraction: async (params) => {
        await env.EXTRACT_DOCUMENT.create({ id: params.jobId, params });
      },
    });
  },
} satisfies ExportedHandler<Env>;
