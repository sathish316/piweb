import { z } from "zod";

export const deliveryModeSchema = z.enum(["normal", "steer", "followUp"]);
export const thinkingLevelSchema = z.enum(["off", "minimal", "low", "medium", "high", "xhigh"]);
export const toolModeSchema = z.enum(["readOnly", "full"]);
export const runStatusSchema = z.enum(["idle", "running", "stopping", "compacting", "error"]);

export const messageItemSchema = z.object({
  kind: z.literal("message"),
  id: z.string(),
  role: z.enum(["user", "assistant", "system"]),
  text: z.string(),
  thinking: z.string().optional(),
  complete: z.boolean(),
  error: z.string().optional(),
});

export const toolItemSchema = z.object({
  kind: z.literal("tool"),
  id: z.string(),
  callId: z.string(),
  name: z.string(),
  summary: z.string(),
  state: z.enum(["running", "success", "error"]),
  preview: z.string(),
});

export const noticeItemSchema = z.object({
  kind: z.literal("notice"),
  id: z.string(),
  level: z.enum(["info", "warning", "error"]),
  text: z.string(),
});

export const conversationItemSchema = z.discriminatedUnion("kind", [
  messageItemSchema,
  toolItemSchema,
  noticeItemSchema,
]);
export type ConversationItem = z.infer<typeof conversationItemSchema>;

export const modelSchema = z.object({
  id: z.string(),
  provider: z.string(),
  name: z.string(),
  reasoning: z.boolean(),
});
export type BrowserModel = z.infer<typeof modelSchema>;

export const commandSchema = z.object({
  name: z.string(),
  description: z.string(),
  source: z.enum(["extension", "prompt", "skill"]),
});
export type BrowserCommand = z.infer<typeof commandSchema>;

export const sessionSummarySchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  firstMessage: z.string(),
  updatedAt: z.string(),
  messageCount: z.number().int().nonnegative(),
  cwd: z.string(),
  activeChatId: z.string().optional(),
});
export type SessionSummary = z.infer<typeof sessionSummarySchema>;

export const extensionRequestSchema = z.object({
  id: z.string(),
  method: z.enum(["select", "confirm", "input", "editor"]),
  title: z.string(),
  message: z.string().optional(),
  options: z.array(z.string()).optional(),
  placeholder: z.string().optional(),
  prefill: z.string().optional(),
});
export type ExtensionRequest = z.infer<typeof extensionRequestSchema>;

export const chatSnapshotSchema = z.object({
  chatId: z.string(),
  workspaceId: z.string(),
  sessionId: z.string(),
  cwd: z.string(),
  name: z.string().optional(),
  modelId: z.string().optional(),
  thinkingLevel: thinkingLevelSchema,
  toolMode: toolModeSchema,
  runStatus: runStatusSchema,
  queue: z.object({ steering: z.number().int(), followUp: z.number().int() }),
  items: z.array(conversationItemSchema),
  commands: z.array(commandSchema),
  stats: z.object({
    messages: z.number().int().nonnegative(),
    toolCalls: z.number().int().nonnegative(),
    tokens: z.number().nonnegative(),
    cost: z.number().nonnegative(),
  }),
  extensionRequest: extensionRequestSchema.optional(),
  generation: z.number().int().nonnegative(),
});
export type ChatSnapshot = z.infer<typeof chatSnapshotSchema>;

const eventBase = z.object({ seq: z.number().int().nonnegative(), generation: z.number().int().nonnegative() });
export const browserEventSchema = z.discriminatedUnion("type", [
  eventBase.extend({ type: z.literal("snapshot"), snapshot: chatSnapshotSchema }),
  eventBase.extend({ type: z.literal("run_status"), status: runStatusSchema }),
  eventBase.extend({ type: z.literal("item"), item: conversationItemSchema }),
  eventBase.extend({ type: z.literal("assistant_delta"), itemId: z.string(), delta: z.string() }),
  eventBase.extend({ type: z.literal("thinking_delta"), itemId: z.string(), delta: z.string() }),
  eventBase.extend({ type: z.literal("assistant_end"), itemId: z.string(), error: z.string().optional() }),
  eventBase.extend({ type: z.literal("tool_update"), item: toolItemSchema }),
  eventBase.extend({
    type: z.literal("queue_update"),
    steering: z.number().int().nonnegative(),
    followUp: z.number().int().nonnegative(),
  }),
  eventBase.extend({ type: z.literal("notice"), item: noticeItemSchema }),
  eventBase.extend({ type: z.literal("extension_request"), request: extensionRequestSchema }),
  eventBase.extend({ type: z.literal("extension_closed"), requestId: z.string() }),
  eventBase.extend({
    type: z.literal("metadata"),
    name: z.string().optional(),
    modelId: z.string().optional(),
    thinkingLevel: thinkingLevelSchema,
    toolMode: toolModeSchema,
    stats: chatSnapshotSchema.shape.stats,
  }),
]);
export type BrowserEvent = z.infer<typeof browserEventSchema>;

export const openWorkspaceSchema = z.object({ path: z.string().trim().min(1).max(4096) }).strict();
export const projectSuggestionQuerySchema = z.object({
  query: z.string().trim().max(4096),
}).strict();
export const updateSettingsSchema = z.object({
  workspaceRoots: z.array(z.string().trim().min(1).max(4096)).min(1).max(16),
}).strict();
export const createChatSchema = z.object({ workspaceId: z.string().min(8).max(128) }).strict();
export const resumeChatSchema = z.object({ workspaceId: z.string().min(8).max(128), sessionId: z.string().min(8).max(128) }).strict();
export const sendMessageSchema = z.object({
  text: z.string().trim().min(1).max(100_000),
  mode: deliveryModeSchema,
}).strict();
export const configPatchSchema = z.object({
  modelId: z.string().max(500).optional(),
  thinkingLevel: thinkingLevelSchema.optional(),
  toolMode: toolModeSchema.optional(),
}).strict().refine((value) => Object.keys(value).length > 0, "At least one setting is required");
export const renameSchema = z.object({ name: z.string().trim().min(1).max(120) }).strict();
export const compactSchema = z.object({ instructions: z.string().trim().max(10_000).optional() }).strict();
export const extensionResponseSchema = z.object({
  requestId: z.string().min(1).max(200),
  value: z.string().max(100_000).optional(),
  confirmed: z.boolean().optional(),
  cancelled: z.boolean().optional(),
}).strict();

export interface BootstrapResponse {
  app: { name: string; version: string; piVersion: string; adapter: "real" | "fake" };
  csrfToken: string;
  workspaceHints: string[];
  workspaceRoots: string[];
}

export interface ProjectSuggestionsResponse {
  suggestions: string[];
}

export interface SettingsResponse {
  workspaceRoots: string[];
  revokedWorkspaceIds: string[];
}

export interface WorkspaceResponse {
  workspaceId: string;
  path: string;
  trusted: boolean;
  diagnostics: string[];
  models: BrowserModel[];
  sessions: SessionSummary[];
}

export interface ApiError {
  error: { code: string; message: string; details?: unknown };
}
