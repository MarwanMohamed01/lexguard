import type { z } from "zod";

// Threat model T7: agents may only call the tools they are granted, with validated
// arguments, within their scopes. Everything not explicitly allowed is denied.

export type Scope = "read" | "write";

export interface ToolDefinition {
  name: string;
  scope: Scope;
  // Prefer z.strictObject so unexpected argument fields are rejected, not silently dropped.
  args: z.ZodType;
  // Risky actions (e.g. exporting a report) are allowed only after a human approves.
  requiresApproval?: boolean;
}

export interface AgentGrant {
  tools: readonly string[];
  scopes: readonly Scope[];
}

export type DenyReason =
  "unknown_agent" | "unknown_tool" | "tool_not_allowed" | "scope_not_granted" | "invalid_args";

export type Authorization =
  | { allowed: true; tool: string; args: unknown; needsApproval: boolean }
  | { allowed: false; reason: DenyReason; message: string };

export class ToolPolicy {
  // Maps, not plain objects: a lookup like grants["constructor"] on an object returns a
  // built-in function instead of undefined, which could accidentally grant access.
  readonly #tools: ReadonlyMap<string, ToolDefinition>;
  readonly #agents: ReadonlyMap<string, AgentGrant>;

  constructor(tools: readonly ToolDefinition[], agents: Readonly<Record<string, AgentGrant>>) {
    const toolMap = new Map<string, ToolDefinition>();
    for (const tool of tools) {
      if (toolMap.has(tool.name)) throw new Error(`duplicate tool "${tool.name}"`);
      toolMap.set(tool.name, tool);
    }
    const agentMap = new Map(Object.entries(agents));
    // Fail at startup on a typo in the config, not at runtime on the first call.
    for (const [agent, grant] of agentMap) {
      for (const name of grant.tools) {
        if (!toolMap.has(name))
          throw new Error(`agent "${agent}" is granted unknown tool "${name}"`);
      }
    }
    this.#tools = toolMap;
    this.#agents = agentMap;
  }

  authorize(agent: string, toolName: string, args: unknown): Authorization {
    const grant = this.#agents.get(agent);
    if (grant === undefined) return deny("unknown_agent", `unknown agent "${agent}"`);

    const tool = this.#tools.get(toolName);
    if (tool === undefined) return deny("unknown_tool", `unknown tool "${toolName}"`);

    if (!grant.tools.includes(toolName)) {
      return deny("tool_not_allowed", `agent "${agent}" may not call "${toolName}"`);
    }
    if (!grant.scopes.includes(tool.scope)) {
      return deny("scope_not_granted", `agent "${agent}" lacks "${tool.scope}" scope`);
    }

    const parsed = tool.args.safeParse(args);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((issue) => issue.message).join("; ");
      return deny("invalid_args", `invalid arguments for "${toolName}": ${issues}`);
    }

    // Callers must use the parsed args, never the raw ones.
    return {
      allowed: true,
      tool: toolName,
      args: parsed.data,
      needsApproval: tool.requiresApproval ?? false,
    };
  }
}

function deny(reason: DenyReason, message: string): Authorization {
  return { allowed: false, reason, message };
}
