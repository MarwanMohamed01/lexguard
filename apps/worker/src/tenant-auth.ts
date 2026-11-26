// A private entrypoint for other Lexguard Workers (D47): "which tenant owns this API key?".
//
// The rulebook MCP server's consent page asks it when a person signs in to approve an MCP
// client, so API keys stay checked in one place (TENANT_KEYS lives only in this Worker).
// It is reachable only through a service binding from a Worker in the same Cloudflare
// account, never from the public URL: only the default export answers HTTP.
import { WorkerEntrypoint } from "cloudflare:workers";
import { checkKey } from "./auth";

export class TenantAuth extends WorkerEntrypoint<Env> {
  /** The tenant ID for a valid key, or null. Throws if TENANT_KEYS is broken (fail closed). */
  async tenantForKey(key: string): Promise<string | null> {
    const result = await checkKey(typeof key === "string" ? key : undefined, this.env.TENANT_KEYS);
    if (result.ok) return result.tenantId;
    if (result.status === 500) throw new Error(result.error);
    return null;
  }
}
