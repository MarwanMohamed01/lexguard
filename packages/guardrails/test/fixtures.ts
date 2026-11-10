import { z } from "zod";
import { ToolPolicy, type ToolDefinition } from "../src/index";

// Shared tool policy used by policy.test.ts and security.test.ts.
export const tools: ToolDefinition[] = [
  {
    name: "rulebook.lookup",
    scope: "read",
    args: z.strictObject({ article: z.string().min(1).max(100) }),
  },
  {
    name: "clauses.save",
    scope: "write",
    args: z.strictObject({ clauseId: z.string(), text: z.string().max(5_000) }),
  },
  {
    name: "report.export",
    scope: "write",
    requiresApproval: true,
    args: z.strictObject({ reportId: z.string() }),
  },
];

export const policy = new ToolPolicy(tools, {
  extractor: { tools: [], scopes: [] }, // the quarantined reader: no tools at all
  researcher: { tools: ["rulebook.lookup"], scopes: ["read"] },
  synthesizer: { tools: ["clauses.save", "report.export"], scopes: ["read", "write"] },
  misconfigured: { tools: ["clauses.save"], scopes: ["read"] },
});
