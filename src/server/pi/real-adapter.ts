import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  getAgentDir,
  hasTrustRequiringProjectResources,
  ProjectTrustStore,
  SessionManager,
  SettingsManager,
  VERSION,
  type AgentSession,
  type AgentSessionEvent,
  type AgentSessionServices,
  type ExtensionUIContext,
  type SessionInfo,
} from "@earendil-works/pi-coding-agent";
import type { BrowserCommand, BrowserModel, ChatSnapshot, ConversationItem, ExtensionRequest, SessionSummary } from "../../shared/protocol.js";
import type { AdapterEvent, PiAdapter, PiChat, PiWorkspace, ThinkingLevel, ToolMode } from "./adapter.js";
import { boundedPreview, summarizeArgs } from "./adapter.js";

const READ_ONLY_TOOLS = ["read", "grep", "find", "ls"];

interface RuntimeServices {
  services: AgentSessionServices;
  sessionDir: string | undefined;
  trusted: boolean;
  diagnostics: string[];
}

export class RealPiAdapter implements PiAdapter {
  readonly kind = "real" as const;
  readonly version = VERSION;
  private readonly agentDir = getAgentDir();

  async resolveWorkspace(path: string): Promise<PiWorkspace> {
    const canonicalPath = await realpath(path);
    const runtime = await this.servicesFor(canonicalPath);
    return {
      canonicalPath,
      trusted: runtime.trusted,
      diagnostics: runtime.diagnostics,
      models: availableModels(runtime.services),
      sessions: await this.listSessions(canonicalPath),
    };
  }

  async listSessions(canonicalWorkspace: string): Promise<SessionSummary[]> {
    const runtime = await this.servicesFor(canonicalWorkspace);
    const sessions = await SessionManager.list(canonicalWorkspace, runtime.sessionDir);
    return sessions.map(toSessionSummary);
  }

  async createChat(canonicalWorkspace: string): Promise<PiChat> {
    const runtime = await this.servicesFor(canonicalWorkspace);
    const manager = SessionManager.create(canonicalWorkspace, runtime.sessionDir);
    return this.buildChat(runtime, manager, "readOnly");
  }

  async resumeChat(canonicalWorkspace: string, sessionId: string): Promise<PiChat> {
    const runtime = await this.servicesFor(canonicalWorkspace);
    const fresh = await SessionManager.list(canonicalWorkspace, runtime.sessionDir);
    const listed = fresh.find((session) => session.id === sessionId);
    if (!listed) throw new Error("Session is no longer listed for this workspace");
    const listedCanonical = await realpath(listed.path);
    if (listedCanonical !== listed.path && !fresh.some((session) => session.path === listedCanonical)) {
      throw new Error("Session resolved outside Pi's current listing");
    }
    const manager = SessionManager.open(listed.path, runtime.sessionDir);
    if (await realpath(manager.getCwd()) !== canonicalWorkspace) {
      throw new Error("Session belongs to a different workspace");
    }
    return this.buildChat(runtime, manager, "readOnly");
  }

  private async servicesFor(cwd: string): Promise<RuntimeServices> {
    const trustStore = new ProjectTrustStore(this.agentDir);
    const requiresTrust = hasTrustRequiringProjectResources(cwd);
    const trusted = !requiresTrust || trustStore.get(cwd) === true;
    const settingsManager = SettingsManager.create(cwd, this.agentDir, { projectTrusted: trusted });
    const services = await createAgentSessionServices({ cwd, agentDir: this.agentDir, settingsManager });
    const diagnostics = services.diagnostics.map((diagnostic) => diagnostic.message);
    if (requiresTrust && !trusted) {
      diagnostics.unshift("Project-local settings and resources were skipped because this project is not trusted in Pi. Open Pi locally to review trust.");
    }
    for (const error of services.resourceLoader.getExtensions().errors) {
      diagnostics.push(`Extension ${error.path}: ${error.error}`);
    }
    const sessionDir = process.env.PI_CODING_AGENT_SESSION_DIR || settingsManager.getSessionDir();
    return { services, sessionDir, trusted, diagnostics };
  }

  private async buildChat(runtime: RuntimeServices, manager: SessionManager, toolMode: ToolMode): Promise<PiChat> {
    const { session, modelFallbackMessage } = await createAgentSessionFromServices({
      services: runtime.services,
      sessionManager: manager,
      ...(toolMode === "readOnly" ? { tools: READ_ONLY_TOOLS } : {}),
    });
    return RealPiChat.create(session, runtime.services, toolMode, [
      ...runtime.diagnostics,
      ...(modelFallbackMessage ? [modelFallbackMessage] : []),
    ]);
  }
}

function availableModels(services: AgentSessionServices): BrowserModel[] {
  return services.modelRegistry.getAvailable().map((model) => ({
    id: `${model.provider}/${model.id}`,
    provider: model.provider,
    name: model.name,
    reasoning: model.reasoning,
  }));
}

function toSessionSummary(session: SessionInfo): SessionSummary {
  return {
    id: session.id,
    ...(session.name ? { name: session.name } : {}),
    firstMessage: session.firstMessage.slice(0, 240),
    updatedAt: session.modified.toISOString(),
    messageCount: session.messageCount,
    cwd: session.cwd,
  };
}

class RealPiChat implements PiChat {
  readonly sessionKey: string;
  readonly sessionId: string;
  readonly cwd: string;
  private readonly listeners = new Set<(event: AdapterEvent) => void>();
  private readonly items: ConversationItem[];
  private readonly generation = 1;
  private readonly pendingDialogs = new Map<string, (response: ExtensionDialogResponse) => void>();
  private unsubscribe: (() => void) | undefined;
  private status: ChatSnapshot["runStatus"] = "idle";
  private toolMode: ToolMode;
  private queue = { steering: 0, followUp: 0 };
  private activeAssistantId: string | undefined;
  private extensionRequest: ExtensionRequest | undefined;
  private disposed = false;
  private noticeNumber = 0;

  static async create(
    session: AgentSession,
    services: AgentSessionServices,
    toolMode: ToolMode,
    diagnostics: string[],
  ): Promise<RealPiChat> {
    const chat = new RealPiChat(session, services, toolMode, diagnostics);
    await chat.bindExtensions();
    chat.unsubscribe = session.subscribe((event) => chat.handleEvent(event));
    return chat;
  }

  private constructor(
    private readonly session: AgentSession,
    private readonly services: AgentSessionServices,
    toolMode: ToolMode,
    diagnostics: string[],
  ) {
    this.sessionKey = session.sessionFile ?? `memory:${session.sessionId}`;
    this.sessionId = session.sessionId;
    this.cwd = session.sessionManager.getCwd();
    this.toolMode = toolMode;
    this.items = restoreActiveBranch(session.sessionManager);
    for (const text of diagnostics) this.items.push(this.notice("warning", text));
  }

  snapshot(): ChatSnapshot {
    const stats = this.session.getSessionStats();
    return {
      chatId: "",
      workspaceId: "",
      sessionId: this.sessionId,
      cwd: this.cwd,
      ...(this.session.sessionName ? { name: this.session.sessionName } : {}),
      ...(this.session.model ? { modelId: `${this.session.model.provider}/${this.session.model.id}` } : {}),
      thinkingLevel: this.session.thinkingLevel,
      toolMode: this.toolMode,
      runStatus: this.status,
      queue: { ...this.queue },
      items: this.items.map((item) => ({ ...item })),
      commands: this.commands(),
      stats: {
        messages: stats.userMessages + stats.assistantMessages,
        toolCalls: stats.toolCalls,
        tokens: stats.tokens.total,
        cost: stats.cost,
      },
      ...(this.extensionRequest ? { extensionRequest: this.extensionRequest } : {}),
      generation: this.generation,
    };
  }

  subscribe(listener: (event: AdapterEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async send(text: string, mode: "normal" | "steer" | "followUp", accepted: (ok: boolean) => void): Promise<void> {
    if (this.disposed) throw new Error("Chat is disposed");
    let preflightCalled = false;
    const preflight = (ok: boolean) => {
      preflightCalled = true;
      accepted(ok);
    };
    try {
      const promise = mode === "normal"
        ? this.session.prompt(text, { preflightResult: preflight, source: "interactive" })
        : this.session.prompt(text, { preflightResult: preflight, streamingBehavior: mode, source: "interactive" });
      if (!preflightCalled) await Promise.resolve();
      await promise;
      await this.session.agent.waitForIdle();
      if (!this.disposed && this.session.pendingMessageCount === 0) this.setStatus("idle");
    } catch (error) {
      if (!preflightCalled) accepted(false);
      if (!this.disposed) {
        this.setStatus("error");
        this.emit({ type: "notice", level: "error", text: safeError(error) });
      }
      throw error;
    }
  }

  async abort(): Promise<void> {
    if (this.status === "idle") return;
    this.setStatus("stopping");
    this.session.clearQueue();
    await this.session.abort();
    await this.session.agent.waitForIdle();
    this.setStatus("idle");
  }

  async configure(config: { modelId?: string; thinkingLevel?: ThinkingLevel; toolMode?: ToolMode }): Promise<void> {
    if (this.status !== "idle" || this.session.isStreaming || this.session.isCompacting) {
      throw new Error("Configuration can only change while Pi is idle");
    }
    if (config.modelId) {
      const slash = config.modelId.indexOf("/");
      const provider = config.modelId.slice(0, slash);
      const id = config.modelId.slice(slash + 1);
      const model = slash > 0 ? this.services.modelRegistry.find(provider, id) : undefined;
      if (!model || !this.services.modelRegistry.hasConfiguredAuth(model)) throw new Error("Model is unavailable or unauthenticated");
      await this.session.setModel(model);
    }
    if (config.thinkingLevel) this.session.setThinkingLevel(config.thinkingLevel);
    if (config.toolMode && config.toolMode !== this.toolMode) {
      const names = config.toolMode === "readOnly"
        ? READ_ONLY_TOOLS
        : this.session.getAllTools().map((tool) => tool.name);
      this.session.setActiveToolsByName(names);
      this.toolMode = config.toolMode;
    }
    this.emit({ type: "metadata" });
  }

  async rename(name: string): Promise<void> {
    this.session.setSessionName(name);
    this.emit({ type: "metadata" });
  }

  async compact(instructions?: string): Promise<void> {
    if (this.status !== "idle") throw new Error("Compaction can only start while Pi is idle");
    await this.session.compact(instructions);
  }

  async respondToExtension(requestId: string, response: ExtensionDialogResponse): Promise<void> {
    const resolve = this.pendingDialogs.get(requestId);
    if (!resolve) throw new Error("Extension request is no longer active");
    this.pendingDialogs.delete(requestId);
    this.extensionRequest = undefined;
    resolve(response);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribe?.();
    for (const resolve of this.pendingDialogs.values()) resolve({ cancelled: true });
    this.pendingDialogs.clear();
    this.session.dispose();
    this.listeners.clear();
  }

  private async bindExtensions(): Promise<void> {
    await this.session.bindExtensions({
      mode: "rpc",
      uiContext: this.extensionUi(),
      onError: (error) => this.emit({ type: "notice", level: "error", text: `Extension error: ${error.error}` }),
      abortHandler: () => void this.abort(),
    });
  }

  private commands(): BrowserCommand[] {
    const extensionCommands = this.services.resourceLoader.getExtensions().extensions.flatMap((extension) =>
      [...extension.commands.values()].map((command) => ({
        name: command.name,
        description: command.description ?? "",
        source: "extension" as const,
      })),
    );
    const prompts = this.session.promptTemplates.map((prompt) => ({
      name: prompt.name,
      description: prompt.description ?? "",
      source: "prompt" as const,
    }));
    const skills = this.services.resourceLoader.getSkills().skills.map((skill) => ({
      name: `skill:${skill.name}`,
      description: skill.description,
      source: "skill" as const,
    }));
    return [...extensionCommands, ...prompts, ...skills];
  }

  private extensionUi(): ExtensionUIContext {
    const dialog = (method: ExtensionRequest["method"], title: string, extra: Partial<ExtensionRequest>) => {
      const id = randomUUID();
      const request: ExtensionRequest = { id, method, title: title.slice(0, 300), ...extra };
      this.extensionRequest = request;
      this.emit({ type: "extensionRequest", request });
      return new Promise<ExtensionDialogResponse>((resolve) => this.pendingDialogs.set(id, resolve));
    };
    const context = {
      select: async (title: string, options: string[]) => {
        const response = await dialog("select", title, { options: options.slice(0, 100).map((option) => option.slice(0, 1_000)) });
        return response.cancelled ? undefined : response.value;
      },
      confirm: async (title: string, message: string) => {
        const response = await dialog("confirm", title, { message: message.slice(0, 4_000) });
        return !response.cancelled && response.confirmed === true;
      },
      input: async (title: string, placeholder?: string) => {
        const response = await dialog("input", title, placeholder ? { placeholder: placeholder.slice(0, 500) } : {});
        return response.cancelled ? undefined : response.value;
      },
      editor: async (title: string, prefill?: string) => {
        const response = await dialog("editor", title, prefill ? { prefill: prefill.slice(0, 100_000) } : {});
        return response.cancelled ? undefined : response.value;
      },
      notify: (message: string, level: "info" | "warning" | "error" = "info") =>
        this.emit({ type: "notice", level, text: message.slice(0, 8_000) }),
      setStatus: (_key: string, text: string | undefined) => {
        if (text) this.emit({ type: "notice", level: "info", text: text.slice(0, 1_000) });
      },
      setWorkingMessage: () => {},
      setWorkingVisible: () => {},
      setWorkingIndicator: () => {},
      setHiddenThinkingLabel: () => {},
      setWidget: () => {},
      setFooter: () => {},
      setHeader: () => {},
      setTitle: () => {},
      custom: async () => {
        this.emit({ type: "notice", level: "warning", text: "This extension requested TUI-only custom UI, which is unavailable in the web dashboard." });
        return undefined;
      },
      pasteToEditor: () => {},
      setEditorText: () => {},
      getEditorText: () => "",
      addAutocompleteProvider: () => {},
      setEditorComponent: () => {},
      getEditorComponent: () => undefined,
      onTerminalInput: () => () => {},
      theme: undefined,
      getAllThemes: () => [],
      setTheme: () => ({ success: false, error: "Theme selection is managed by the browser." }),
      getTheme: () => undefined,
    };
    return context as unknown as ExtensionUIContext;
  }

  private handleEvent(event: AgentSessionEvent): void {
    if (this.disposed) return;
    switch (event.type) {
      case "agent_start":
        this.setStatus("running");
        break;
      case "message_start": {
        const message = event.message;
        if (message.role === "user") {
          this.push({ kind: "message", id: `live-user-${randomUUID()}`, role: "user", text: contentText(message.content), complete: true });
        } else if (message.role === "assistant") {
          const id = `live-assistant-${randomUUID()}`;
          this.activeAssistantId = id;
          this.push({ kind: "message", id, role: "assistant", text: "", thinking: "", complete: false });
        }
        break;
      }
      case "message_update":
        if (!this.activeAssistantId) break;
        if (event.assistantMessageEvent.type === "text_delta") {
          this.appendMessage(this.activeAssistantId, "text", event.assistantMessageEvent.delta);
          this.emit({ type: "assistantDelta", itemId: this.activeAssistantId, delta: event.assistantMessageEvent.delta });
        } else if (event.assistantMessageEvent.type === "thinking_delta") {
          this.appendMessage(this.activeAssistantId, "thinking", event.assistantMessageEvent.delta);
          this.emit({ type: "thinkingDelta", itemId: this.activeAssistantId, delta: event.assistantMessageEvent.delta });
        }
        break;
      case "message_end":
        if (event.message.role === "assistant" && this.activeAssistantId) {
          const id = this.activeAssistantId;
          const item = this.items.find((candidate) => candidate.id === id);
          if (item?.kind === "message") {
            item.complete = true;
            if (event.message.stopReason === "error" && event.message.errorMessage) item.error = event.message.errorMessage;
          }
          this.emit({
            type: "assistantEnd",
            itemId: id,
            ...(event.message.role === "assistant" && event.message.errorMessage ? { error: event.message.errorMessage } : {}),
          });
          this.activeAssistantId = undefined;
        }
        break;
      case "tool_execution_start":
        this.push({
          kind: "tool",
          id: `tool-${event.toolCallId}`,
          callId: event.toolCallId,
          name: event.toolName,
          summary: summarizeArgs(event.args),
          state: "running",
          preview: "",
        });
        break;
      case "tool_execution_update":
        this.updateTool(event.toolCallId, "running", event.partialResult);
        break;
      case "tool_execution_end":
        this.updateTool(event.toolCallId, event.isError ? "error" : "success", event.result);
        break;
      case "queue_update":
        this.queue = { steering: event.steering.length, followUp: event.followUp.length };
        this.emit({ type: "queue", ...this.queue });
        break;
      case "compaction_start":
        this.setStatus("compacting");
        this.emit({ type: "notice", level: "info", text: `Compaction started (${event.reason}).` });
        break;
      case "compaction_end":
        this.emit({
          type: "notice",
          level: event.errorMessage ? "error" : "info",
          text: event.errorMessage ?? (event.aborted ? "Compaction stopped." : "Compaction finished."),
        });
        if (!event.willRetry) this.setStatus("idle");
        break;
      case "auto_retry_start":
        this.emit({ type: "notice", level: "warning", text: `Retry ${event.attempt}/${event.maxAttempts} scheduled: ${event.errorMessage}` });
        break;
      case "auto_retry_end":
        this.emit({ type: "notice", level: event.success ? "info" : "error", text: event.success ? "Automatic retry succeeded." : event.finalError ?? "Automatic retry failed." });
        break;
      case "session_info_changed":
      case "thinking_level_changed":
        this.emit({ type: "metadata" });
        break;
      default:
        break;
    }
  }

  private updateTool(callId: string, state: "running" | "success" | "error", result: unknown): void {
    const item = this.items.find((candidate) => candidate.kind === "tool" && candidate.callId === callId);
    if (item?.kind !== "tool") return;
    item.state = state;
    item.preview = boundedPreview(result);
    this.emit({ type: "tool", item: { ...item } });
  }
  private appendMessage(id: string, field: "text" | "thinking", delta: string): void {
    const item = this.items.find((candidate) => candidate.id === id);
    if (item?.kind !== "message") return;
    if (field === "text") item.text += delta;
    else item.thinking = `${item.thinking ?? ""}${delta}`;
  }
  private push(item: ConversationItem): void {
    this.items.push(item);
    this.emit({ type: "item", item: { ...item } });
  }
  private setStatus(status: ChatSnapshot["runStatus"]): void {
    this.status = status;
    this.emit({ type: "status", status });
  }
  private emit(event: AdapterEvent): void {
    for (const listener of this.listeners) listener(event);
  }
  private notice(level: "info" | "warning" | "error", text: string): ConversationItem {
    this.noticeNumber += 1;
    return { kind: "notice", id: `startup-notice-${this.noticeNumber}`, level, text };
  }
}

interface ExtensionDialogResponse {
  value?: string;
  confirmed?: boolean;
  cancelled?: boolean;
}

function restoreActiveBranch(manager: SessionManager): ConversationItem[] {
  const items: ConversationItem[] = [];
  for (const entry of manager.getBranch()) {
    if (entry.type === "message") {
      const message = entry.message;
      if (message.role === "user") {
        items.push({ kind: "message", id: entry.id, role: "user", text: contentText(message.content), complete: true });
      } else if (message.role === "assistant") {
        const thinking = message.content.filter((part) => part.type === "thinking").map((part) => part.thinking).join("");
        items.push({
          kind: "message",
          id: entry.id,
          role: "assistant",
          text: message.content.filter((part) => part.type === "text").map((part) => part.text).join(""),
          ...(thinking ? { thinking } : {}),
          complete: true,
          ...(message.errorMessage ? { error: message.errorMessage } : {}),
        });
        for (const call of message.content.filter((part) => part.type === "toolCall")) {
          items.push({
            kind: "tool",
            id: `tool-${call.id}`,
            callId: call.id,
            name: call.name,
            summary: summarizeArgs(call.arguments),
            state: "success",
            preview: "",
          });
        }
      } else if (message.role === "toolResult") {
        const tool = items.find((candidate) => candidate.kind === "tool" && candidate.callId === message.toolCallId);
        if (tool?.kind === "tool") {
          tool.state = message.isError ? "error" : "success";
          tool.preview = boundedPreview(message.content.map((part) => part.type === "text" ? part.text : "[image]").join("\n"));
        }
      }
    } else if (entry.type === "compaction") {
      items.push({ kind: "notice", id: entry.id, level: "info", text: `Earlier context compacted (${entry.tokensBefore.toLocaleString()} tokens).` });
    } else if (entry.type === "branch_summary") {
      items.push({ kind: "notice", id: entry.id, level: "info", text: "Active branch includes a summary from an earlier path." });
    }
  }
  return items;
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => {
    if (typeof part !== "object" || part === null) return "";
    if ("text" in part && typeof part.text === "string") return part.text;
    return "type" in part && part.type === "image" ? "[image]" : "";
  }).join("");
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 4_000) : "Pi operation failed";
}
