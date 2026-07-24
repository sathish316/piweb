import { randomUUID } from "node:crypto";
import type { BrowserModel, ChatSnapshot, ConversationItem, SessionSummary } from "../../shared/protocol.js";
import type { AdapterEvent, PiAdapter, PiChat, PiWorkspace, ThinkingLevel, ToolMode } from "./adapter.js";

const fakeModels: BrowserModel[] = [
  { id: "fake/local", provider: "fake", name: "Deterministic local model", reasoning: true },
  { id: "fake/fast", provider: "fake", name: "Fast local model", reasoning: false },
];

interface StoredFakeSession {
  id: string;
  key: string;
  cwd: string;
  name?: string;
  modelId: string;
  thinkingLevel: ThinkingLevel;
  toolMode: ToolMode;
  items: ConversationItem[];
  updatedAt: string;
}

export class FakePiAdapter implements PiAdapter {
  readonly kind = "fake" as const;
  readonly version = "0.79.8-fake";
  private readonly sessions = new Map<string, StoredFakeSession>();

  async resolveWorkspace(path: string): Promise<PiWorkspace> {
    return {
      canonicalPath: path,
      trusted: true,
      diagnostics: ["Test adapter active. No model requests will be made."],
      models: fakeModels,
      sessions: await this.listSessions(path),
    };
  }

  async listSessions(canonicalWorkspace: string): Promise<SessionSummary[]> {
    return [...this.sessions.values()]
      .filter((session) => session.cwd === canonicalWorkspace)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map(toSummary);
  }

  async createChat(canonicalWorkspace: string): Promise<PiChat> {
    const session: StoredFakeSession = {
      id: randomUUID(),
      key: `fake:${randomUUID()}`,
      cwd: canonicalWorkspace,
      modelId: fakeModels[0]!.id,
      thinkingLevel: "medium",
      toolMode: "readOnly",
      items: [],
      updatedAt: new Date().toISOString(),
    };
    this.sessions.set(session.id, session);
    return new FakePiChat(session);
  }

  async resumeChat(canonicalWorkspace: string, sessionId: string): Promise<PiChat> {
    const session = this.sessions.get(sessionId);
    if (!session || session.cwd !== canonicalWorkspace) {
      throw new Error("Session is no longer available for this workspace");
    }
    return new FakePiChat(session);
  }

  seed(workspace: string, items: ConversationItem[]): string {
    const id = randomUUID();
    this.sessions.set(id, {
      id,
      key: `fake:${id}`,
      cwd: workspace,
      modelId: fakeModels[0]!.id,
      thinkingLevel: "medium",
      toolMode: "readOnly",
      items,
      updatedAt: new Date().toISOString(),
    });
    return id;
  }
}

function toSummary(session: StoredFakeSession): SessionSummary {
  const firstUser = session.items.find((item) => item.kind === "message" && item.role === "user");
  return {
    id: session.id,
    ...(session.name ? { name: session.name } : {}),
    firstMessage: firstUser?.kind === "message" ? firstUser.text.slice(0, 160) : "Empty session",
    updatedAt: session.updatedAt,
    messageCount: session.items.filter((item) => item.kind === "message").length,
    cwd: session.cwd,
  };
}

class FakePiChat implements PiChat {
  readonly sessionKey: string;
  readonly sessionId: string;
  readonly cwd: string;
  private readonly listeners = new Set<(event: AdapterEvent) => void>();
  private status: ChatSnapshot["runStatus"] = "idle";
  private queue = { steering: 0, followUp: 0 };
  private extensionRequest: ChatSnapshot["extensionRequest"];
  private generation = 1;
  private timers = new Set<NodeJS.Timeout>();
  private aborted = false;

  constructor(private readonly stored: StoredFakeSession) {
    this.sessionKey = stored.key;
    this.sessionId = stored.id;
    this.cwd = stored.cwd;
  }

  snapshot(): ChatSnapshot {
    return {
      chatId: "",
      workspaceId: "",
      sessionId: this.sessionId,
      cwd: this.cwd,
      ...(this.stored.name ? { name: this.stored.name } : {}),
      modelId: this.stored.modelId,
      thinkingLevel: this.stored.thinkingLevel,
      toolMode: this.stored.toolMode,
      runStatus: this.status,
      queue: { ...this.queue },
      items: this.stored.items.map((item) => ({ ...item })),
      commands: [
        { name: "demo-dialog", description: "Open an extension dialog", source: "extension" },
        { name: "review", description: "Review the current change", source: "prompt" },
      ],
      stats: this.stats(),
      ...(this.extensionRequest ? { extensionRequest: this.extensionRequest } : {}),
      generation: this.generation,
    };
  }

  subscribe(listener: (event: AdapterEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async send(text: string, mode: "normal" | "steer" | "followUp", accepted: (ok: boolean) => void): Promise<void> {
    if (mode !== "normal" && this.status !== "idle") {
      this.queue[mode === "steer" ? "steering" : "followUp"] += 1;
      this.emit({ type: "queue", ...this.queue });
      accepted(true);
      return;
    }
    if (this.status !== "idle") {
      accepted(false);
      throw new Error("The fake agent is already running");
    }
    accepted(true);
    this.aborted = false;
    const userId = `user-${randomUUID()}`;
    const user: ConversationItem = { kind: "message", id: userId, role: "user", text, complete: true };
    this.push(user);
    this.setStatus("running");

    if (text === "/demo-dialog") {
      const request = { id: `dialog-${randomUUID()}`, method: "confirm" as const, title: "Continue?", message: "The extension needs a decision." };
      this.extensionRequest = request;
      this.emit({ type: "extensionRequest", request });
      return;
    }

    const assistantId = `assistant-${randomUUID()}`;
    const assistant: ConversationItem = { kind: "message", id: assistantId, role: "assistant", text: "", thinking: "", complete: false };
    this.push(assistant);
    await this.delay(25);
    if (this.aborted) return this.settleAborted(assistantId);
    this.appendThinking(assistantId, "Inspecting the workspace and choosing a deterministic path. ");
    await this.delay(25);
    if (this.aborted) return this.settleAborted(assistantId);

    const toolId = `tool-${randomUUID()}`;
    const tool: Extract<ConversationItem, { kind: "tool" }> = {
      kind: "tool",
      id: toolId,
      callId: `call-${randomUUID()}`,
      name: "read",
      summary: '{"path":"README.md"}',
      state: "running",
      preview: "",
    };
    this.push(tool);
    await this.delay(35);
    if (this.aborted) return this.settleAborted(assistantId);
    tool.state = "success";
    tool.preview = "# Project\n\nDeterministic fake tool output.";
    this.replace(tool);
    this.emit({ type: "tool", item: { ...tool } });

    for (const delta of ["I checked the project. ", "The stream, tool activity, and settled state are working."]) {
      await this.delay(30);
      if (this.aborted) return this.settleAborted(assistantId);
      this.appendText(assistantId, delta);
    }
    const target = this.stored.items.find((item) => item.id === assistantId);
    if (target?.kind === "message") target.complete = true;
    this.emit({ type: "assistantEnd", itemId: assistantId });
    this.queue = { steering: 0, followUp: 0 };
    this.emit({ type: "queue", ...this.queue });
    this.setStatus("idle");
    this.emit({ type: "metadata" });
  }

  async abort(): Promise<void> {
    if (this.status === "idle") return;
    this.aborted = true;
    this.queue = { steering: 0, followUp: 0 };
    this.emit({ type: "queue", ...this.queue });
    this.setStatus("stopping");
  }

  async configure(config: { modelId?: string; thinkingLevel?: ThinkingLevel; toolMode?: ToolMode }): Promise<void> {
    if (this.status !== "idle") throw new Error("Configuration can only change while idle");
    if (config.modelId) {
      if (!fakeModels.some((model) => model.id === config.modelId)) throw new Error("Unknown model");
      this.stored.modelId = config.modelId;
    }
    if (config.thinkingLevel) this.stored.thinkingLevel = config.thinkingLevel;
    if (config.toolMode) this.stored.toolMode = config.toolMode;
    this.touch();
    this.emit({ type: "metadata" });
  }

  async rename(name: string): Promise<void> {
    this.stored.name = name;
    this.touch();
    this.emit({ type: "metadata" });
  }

  async compact(): Promise<void> {
    if (this.status !== "idle") throw new Error("Compaction can only start while idle");
    this.setStatus("compacting");
    this.emit({ type: "notice", level: "info", text: "Compaction started." });
    await this.delay(20);
    this.emit({ type: "notice", level: "info", text: "Compaction finished." });
    this.setStatus("idle");
  }

  async respondToExtension(requestId: string, response: { value?: string; confirmed?: boolean; cancelled?: boolean }): Promise<void> {
    if (this.extensionRequest?.id !== requestId) throw new Error("Extension request is no longer active");
    const result = response.cancelled ? "cancelled" : response.confirmed ? "confirmed" : response.value ?? "dismissed";
    this.extensionRequest = undefined;
    this.emit({ type: "notice", level: "info", text: `Extension dialog ${result}.` });
    this.setStatus("idle");
  }

  async dispose(): Promise<void> {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    this.listeners.clear();
    this.generation += 1;
  }

  private emit(event: AdapterEvent): void {
    for (const listener of this.listeners) listener(event);
  }
  private push(item: ConversationItem): void {
    this.stored.items.push(item);
    this.touch();
    this.emit({ type: "item", item: { ...item } });
  }
  private replace(item: ConversationItem): void {
    const index = this.stored.items.findIndex((current) => current.id === item.id);
    if (index >= 0) this.stored.items[index] = item;
    this.touch();
  }
  private appendText(id: string, delta: string): void {
    const item = this.stored.items.find((current) => current.id === id);
    if (item?.kind === "message") item.text += delta;
    this.emit({ type: "assistantDelta", itemId: id, delta });
  }
  private appendThinking(id: string, delta: string): void {
    const item = this.stored.items.find((current) => current.id === id);
    if (item?.kind === "message") item.thinking = `${item.thinking ?? ""}${delta}`;
    this.emit({ type: "thinkingDelta", itemId: id, delta });
  }
  private setStatus(status: ChatSnapshot["runStatus"]): void {
    this.status = status;
    this.emit({ type: "status", status });
  }
  private settleAborted(assistantId: string): void {
    const item = this.stored.items.find((current) => current.id === assistantId);
    if (item?.kind === "message") {
      item.complete = true;
      item.error = "Stopped";
    }
    this.emit({ type: "assistantEnd", itemId: assistantId, error: "Stopped" });
    this.setStatus("idle");
  }
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.timers.delete(timer);
        resolve();
      }, ms);
      this.timers.add(timer);
    });
  }
  private touch(): void {
    this.stored.updatedAt = new Date().toISOString();
  }
  private stats(): ChatSnapshot["stats"] {
    return {
      messages: this.stored.items.filter((item) => item.kind === "message").length,
      toolCalls: this.stored.items.filter((item) => item.kind === "tool").length,
      tokens: this.stored.items.reduce((sum, item) => sum + ("text" in item ? item.text.length : 0), 0),
      cost: 0,
    };
  }
}
