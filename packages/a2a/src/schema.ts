import { z } from "zod";

// Data shapes from the A2A specification v1.0 (https://a2a-protocol.org/latest/specification/).
// Everything that arrives from another agent is untrusted input (threat model T5): unknown
// fields are dropped (z.object strips them), sizes are capped, and URLs must be HTTPS.

export const A2A_PROTOCOL_VERSION = "1.0";
export const AGENT_CARD_PATH = "/.well-known/agent-card.json";

// Limits for incoming content. A 300-page contract is roughly 1M characters of text; a PDF of
// that size is well under 20 MB, which is about 27M characters once base64-encoded.
export const LIMITS = {
  textChars: 2_000_000,
  rawBase64Chars: 27_000_000,
  partsPerMessage: 20,
  metadataKeys: 50,
  idChars: 200,
} as const;

const Id = z.string().min(1).max(LIMITS.idChars);
const HttpsUrl = z.url({ protocol: /^https$/ });
const Metadata = z
  .record(z.string(), z.unknown())
  .refine((m) => Object.keys(m).length <= LIMITS.metadataKeys, "too many metadata keys");

export const TaskState = z.enum([
  "TASK_STATE_SUBMITTED",
  "TASK_STATE_WORKING",
  "TASK_STATE_INPUT_REQUIRED",
  "TASK_STATE_AUTH_REQUIRED",
  "TASK_STATE_COMPLETED",
  "TASK_STATE_FAILED",
  "TASK_STATE_CANCELED",
  "TASK_STATE_REJECTED",
]);
export type TaskState = z.infer<typeof TaskState>;

export const Role = z.enum(["ROLE_USER", "ROLE_AGENT"]);
export type Role = z.infer<typeof Role>;

// A Part carries exactly one kind of content.
export const Part = z
  .object({
    text: z.string().max(LIMITS.textChars).optional(),
    raw: z.base64().max(LIMITS.rawBase64Chars).optional(),
    url: HttpsUrl.optional(),
    data: z.unknown().optional(),
    filename: z.string().max(255).optional(),
    mediaType: z.string().max(255).optional(),
    metadata: Metadata.optional(),
  })
  .refine(
    (p) => [p.text, p.raw, p.url, p.data].filter((v) => v !== undefined).length === 1,
    "a part must contain exactly one of text, raw, url or data",
  );
export type Part = z.infer<typeof Part>;

export const Message = z.object({
  messageId: Id,
  role: Role,
  parts: z.array(Part).min(1).max(LIMITS.partsPerMessage),
  contextId: Id.optional(),
  taskId: Id.optional(),
  referenceTaskIds: z.array(Id).max(20).optional(),
  extensions: z.array(z.string().max(500)).max(20).optional(),
  metadata: Metadata.optional(),
});
export type Message = z.infer<typeof Message>;

export const TaskStatus = z.object({
  state: TaskState,
  message: Message.optional(),
  timestamp: z.iso.datetime().optional(),
});
export type TaskStatus = z.infer<typeof TaskStatus>;

export const Artifact = z.object({
  artifactId: Id,
  name: z.string().max(500).optional(),
  description: z.string().max(5_000).optional(),
  parts: z.array(Part).min(1),
  metadata: Metadata.optional(),
  extensions: z.array(z.string().max(500)).max(20).optional(),
});
export type Artifact = z.infer<typeof Artifact>;

export const Task = z.object({
  id: Id,
  contextId: Id.optional(),
  status: TaskStatus,
  artifacts: z.array(Artifact).optional(),
  history: z.array(Message).optional(),
  metadata: Metadata.optional(),
});
export type Task = z.infer<typeof Task>;

export const AgentInterface = z.object({
  url: HttpsUrl,
  protocolBinding: z.enum(["JSONRPC", "GRPC", "HTTP+JSON"]),
  protocolVersion: z.string().min(1),
  tenant: z.string().optional(),
});

export const AgentSkill = z.object({
  id: Id,
  name: z.string().min(1),
  description: z.string().min(1),
  tags: z.array(z.string()),
  examples: z.array(z.string()).optional(),
  inputModes: z.array(z.string()).optional(),
  outputModes: z.array(z.string()).optional(),
});

export const AgentCapabilities = z.object({
  streaming: z.boolean().optional(),
  pushNotifications: z.boolean().optional(),
  extendedAgentCard: z.boolean().optional(),
});

export const AgentCard = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  supportedInterfaces: z.array(AgentInterface).min(1),
  provider: z.object({ organization: z.string(), url: HttpsUrl }).optional(),
  version: z.string().min(1),
  documentationUrl: HttpsUrl.optional(),
  capabilities: AgentCapabilities,
  // Security schemes are modelled in M8 together with authentication.
  securitySchemes: z.record(z.string(), z.unknown()).optional(),
  securityRequirements: z.array(z.unknown()).optional(),
  defaultInputModes: z.array(z.string()).min(1),
  defaultOutputModes: z.array(z.string()).min(1),
  skills: z.array(AgentSkill).min(1),
  iconUrl: HttpsUrl.optional(),
});
export type AgentCard = z.infer<typeof AgentCard>;
