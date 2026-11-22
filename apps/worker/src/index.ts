// Entry point of the Lexguard Worker. Cloudflare calls `fetch` once per HTTP request.
import { handle } from "./app";

export default {
  fetch(request, env): Promise<Response> {
    return handle(request, env, { convert: (file) => env.AI.toMarkdown(file) });
  },
} satisfies ExportedHandler<Env>;
