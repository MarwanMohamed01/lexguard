import { A2A_PROTOCOL_VERSION, AgentCard } from "./schema";

export interface LexguardCardOptions {
  // Public HTTPS origin of the deployed Worker, e.g. https://lexguard.example.workers.dev
  baseUrl: string;
  version: string;
}

// Lexguard's public Agent Card, served at AGENT_CARD_PATH. Public information only: the spec
// says cards SHOULD NOT include credentials or internal implementation details.
export function lexguardAgentCard({ baseUrl, version }: LexguardCardOptions): AgentCard {
  const origin = baseUrl.replace(/\/+$/, "");
  return AgentCard.parse({
    name: "Lexguard",
    description:
      "Analyses long contracts and policies (50-300 pages): extracts and classifies clauses, " +
      "checks them against compliance rules, and returns a cited, redlined risk report.",
    supportedInterfaces: [
      { url: `${origin}/a2a`, protocolBinding: "JSONRPC", protocolVersion: A2A_PROTOCOL_VERSION },
    ],
    version,
    capabilities: { streaming: false, pushNotifications: false },
    defaultInputModes: [
      "application/pdf",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "text/plain",
    ],
    defaultOutputModes: ["application/json", "text/markdown"],
    skills: [
      {
        id: "contract-review",
        name: "Contract review",
        description:
          "Review a contract or policy document and return risks per clause, each backed by " +
          "an exact quote from the document.",
        tags: ["legal", "contracts", "compliance", "gdpr"],
        examples: ["Review this data processing agreement for GDPR Article 28 issues."],
      },
    ],
  });
}
