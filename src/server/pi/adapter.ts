import type {
  BrowserCommand,
  BrowserModel,
  ChatSnapshot,
  ConversationItem,
  ExtensionRequest,
  SessionSummary,
} from "../../shared/protocol.js";
import type { z } from "zod";
import type { thinkingLevelSchema, toolModeSchema } from "../../shared/protocol.js";

export type ThinkingLevel = z.infer<typeof thinkingLevelSchema>;
export type ToolMode = z.infer<typeof toolModeSchema>;

export type AdapterEvent =
  | { type: "status"; status: ChatSnapshot["runStatus"] }
  | { type: "item"; item: ConversationItem }
  | { type: "assistantDelta"; itemId: string; delta: string }
  | { type: "thinkingDelta"; itemId: string; delta: string }
  | { type: "assistantEnd"; itemId: string; error?: string }
  | { type: "tool"; item: Extract<ConversationItem, { kind: "tool" }> }
  | { type: "queue"; steering: number; followUp: number }
  | { type: "notice"; level: "info" | "warning" | "error"; text: string }
  | { type: "extensionRequest"; request: ExtensionRequest }
  | { type: "extensionClosed"; requestId: string }
  | { type: "metadata" };

export interface PiWorkspace {
  canonicalPath: string;
  trusted: boolean;
  diagnostics: string[];
  models: BrowserModel[];
  sessions: SessionSummary[];
}

export interface PiChat {
  readonly sessionKey: string;
  readonly sessionId: string;
  readonly cwd: string;
  snapshot(): ChatSnapshot;
  subscribe(listener: (event: AdapterEvent) => void): () => void;
  send(text: string, mode: "normal" | "steer" | "followUp", accepted: (ok: boolean) => void): Promise<void>;
  abort(): Promise<void>;
  configure(config: { modelId?: string; thinkingLevel?: ThinkingLevel; toolMode?: ToolMode }): Promise<void>;
  rename(name: string): Promise<void>;
  compact(instructions?: string): Promise<void>;
  respondToExtension(requestId: string, response: { value?: string; confirmed?: boolean; cancelled?: boolean }): Promise<void>;
  dispose(): Promise<void>;
}

export interface PiAdapter {
  readonly kind: "real" | "fake";
  readonly version: string;
  resolveWorkspace(path: string): Promise<PiWorkspace>;
  listSessions(canonicalWorkspace: string): Promise<SessionSummary[]>;
  createChat(canonicalWorkspace: string): Promise<PiChat>;
  resumeChat(canonicalWorkspace: string, sessionId: string): Promise<PiChat>;
}

export function summarizeArgs(input: unknown, max = 240): string {
  let value: string;
  try {
    value = typeof input === "string" ? input : JSON.stringify(input);
  } catch {
    value = "[unserializable arguments]";
  }
  const singleLine = value.replace(/\s+/g, " ").trim();
  return singleLine.length <= max ? singleLine : `${singleLine.slice(0, max)}…`;
}

export function boundedPreview(input: unknown, max = 8_000): string {
  let value: string;
  if (typeof input === "string") {
    value = input;
  } else {
    try {
      value = JSON.stringify(input, redactingReplacer, 2);
    } catch {
      value = "[unserializable result]";
    }
  }
  const clean = redactSecrets(value);
  return clean.length <= max ? clean : `${clean.slice(0, max)}\n… ${clean.length - max} characters omitted`;
}

function redactingReplacer(key: string, value: unknown): unknown {
  return /(authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|private[_-]?key|password|secret)/i.test(key)
    ? "[REDACTED]"
    : value;
}

export function redactSecrets(value: string): string {
  return value
    .replace(/\b(?:sk|pk|sess|ghp|github_pat|xox[baprs])[-_A-Za-z0-9]{12,}\b/g, "[REDACTED]")
    .replace(/(authorization\s*[:=]\s*)([^\s,;]+)/gi, "$1[REDACTED]")
    .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)\s*[:=]\s*)[^\s,;]+/gi, "$1[REDACTED]");
}

export function commandsFromPi(commands: Array<{ name: string; description?: string; source?: string }>): BrowserCommand[] {
  return commands.map((command) => ({
    name: command.name,
    description: command.description ?? "",
    source: command.source === "extension" ? "extension" : command.name.startsWith("skill:") ? "skill" : "prompt",
  }));
}
