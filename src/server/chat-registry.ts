import { randomUUID } from "node:crypto";
import type { Response } from "express";
import type { BrowserEvent, ChatSnapshot } from "../shared/protocol.js";
import type { AdapterEvent, PiAdapter, PiChat, ThinkingLevel, ToolMode } from "./pi/adapter.js";

interface LiveChat {
  id: string;
  workspaceId: string;
  pi: PiChat;
  generation: number;
  seq: number;
  events: BrowserEvent[];
  subscribers: Set<Response>;
  unsubscribe: () => void;
}

export class ChatRegistry {
  private readonly chats = new Map<string, LiveChat>();
  private readonly owners = new Map<string, string>();

  constructor(private readonly adapter: PiAdapter) {}

  async create(workspaceId: string, cwd: string): Promise<ChatSnapshot> {
    const pi = await this.adapter.createChat(cwd);
    return this.adopt(workspaceId, pi);
  }

  async resume(workspaceId: string, cwd: string, sessionId: string): Promise<ChatSnapshot> {
    const existing = [...this.chats.values()].find((chat) => chat.pi.sessionId === sessionId && chat.pi.cwd === cwd);
    if (existing) return this.snapshot(existing);
    const pi = await this.adapter.resumeChat(cwd, sessionId);
    const owner = this.owners.get(pi.sessionKey);
    if (owner) {
      await pi.dispose();
      const attached = this.chats.get(owner);
      if (attached) return this.snapshot(attached);
      throw new Error("Session is already owned by another live chat");
    }
    return this.adopt(workspaceId, pi);
  }

  get(id: string): ChatSnapshot {
    return this.snapshot(this.require(id));
  }

  async send(id: string, text: string, mode: "normal" | "steer" | "followUp"): Promise<boolean> {
    const live = this.require(id);
    return new Promise<boolean>((resolve, reject) => {
      let decided = false;
      const run = live.pi.send(text, mode, (accepted) => {
        if (!decided) {
          decided = true;
          resolve(accepted);
        }
      });
      void run.catch((error) => {
        if (!decided) {
          decided = true;
          reject(error);
        }
      });
    });
  }

  async abort(id: string): Promise<void> {
    await this.require(id).pi.abort();
  }

  async configure(id: string, config: { modelId?: string; thinkingLevel?: ThinkingLevel; toolMode?: ToolMode }): Promise<ChatSnapshot> {
    const live = this.require(id);
    await live.pi.configure(config);
    return this.snapshot(live);
  }

  async rename(id: string, name: string): Promise<ChatSnapshot> {
    const live = this.require(id);
    await live.pi.rename(name);
    return this.snapshot(live);
  }

  async compact(id: string, instructions?: string): Promise<void> {
    await this.require(id).pi.compact(instructions);
  }

  async respond(id: string, requestId: string, response: { value?: string; confirmed?: boolean; cancelled?: boolean }): Promise<void> {
    await this.require(id).pi.respondToExtension(requestId, response);
  }

  async dispose(id: string): Promise<void> {
    const live = this.require(id);
    live.generation += 1;
    live.unsubscribe();
    for (const response of live.subscribers) response.end();
    live.subscribers.clear();
    this.chats.delete(id);
    this.owners.delete(live.pi.sessionKey);
    await live.pi.dispose();
  }

  async disposeWorkspaces(workspaceIds: string[]): Promise<void> {
    const revoked = new Set(workspaceIds);
    const chatIds = [...this.chats.values()]
      .filter((chat) => revoked.has(chat.workspaceId))
      .map((chat) => chat.id);
    await Promise.all(chatIds.map((id) => this.dispose(id)));
  }

  connect(id: string, response: Response, lastEventId: number | undefined): () => void {
    const live = this.require(id);
    live.subscribers.add(response);
    const firstBuffered = live.events[0]?.seq ?? live.seq + 1;
    if (lastEventId !== undefined && lastEventId >= firstBuffered - 1 && lastEventId <= live.seq) {
      for (const event of live.events) {
        if (event.seq > lastEventId) writeSse(response, event);
      }
    } else {
      const event: BrowserEvent = {
        type: "snapshot",
        seq: live.seq,
        generation: live.generation,
        snapshot: this.snapshot(live),
      };
      writeSse(response, event);
    }
    return () => live.subscribers.delete(response);
  }

  private adopt(workspaceId: string, pi: PiChat): ChatSnapshot {
    if (this.owners.has(pi.sessionKey)) throw new Error("Pi session already has a live writer");
    const id = randomUUID();
    const live: LiveChat = {
      id,
      workspaceId,
      pi,
      generation: 1,
      seq: 0,
      events: [],
      subscribers: new Set(),
      unsubscribe: () => {},
    };
    live.unsubscribe = pi.subscribe((event) => this.onAdapterEvent(live, event, live.generation));
    this.chats.set(id, live);
    this.owners.set(pi.sessionKey, id);
    return this.snapshot(live);
  }

  private onAdapterEvent(live: LiveChat, event: AdapterEvent, generation: number): void {
    if (!this.chats.has(live.id) || live.generation !== generation) return;
    const base = { seq: ++live.seq, generation };
    const snapshot = live.pi.snapshot();
    let browserEvent: BrowserEvent;
    switch (event.type) {
      case "status":
        browserEvent = { ...base, type: "run_status", status: event.status };
        break;
      case "item":
        browserEvent = { ...base, type: "item", item: event.item };
        break;
      case "assistantDelta":
        browserEvent = { ...base, type: "assistant_delta", itemId: event.itemId, delta: event.delta };
        break;
      case "thinkingDelta":
        browserEvent = { ...base, type: "thinking_delta", itemId: event.itemId, delta: event.delta };
        break;
      case "assistantEnd":
        browserEvent = { ...base, type: "assistant_end", itemId: event.itemId, ...(event.error ? { error: event.error } : {}) };
        break;
      case "tool":
        browserEvent = { ...base, type: "tool_update", item: event.item };
        break;
      case "queue":
        browserEvent = { ...base, type: "queue_update", steering: event.steering, followUp: event.followUp };
        break;
      case "notice": {
        const item = { kind: "notice" as const, id: `notice-${live.seq}`, level: event.level, text: event.text };
        browserEvent = { ...base, type: "notice", item };
        break;
      }
      case "extensionRequest":
        browserEvent = { ...base, type: "extension_request", request: event.request };
        break;
      case "extensionClosed":
        browserEvent = { ...base, type: "extension_closed", requestId: event.requestId };
        break;
      case "metadata":
        browserEvent = {
          ...base,
          type: "metadata",
          ...(snapshot.name ? { name: snapshot.name } : {}),
          ...(snapshot.modelId ? { modelId: snapshot.modelId } : {}),
          thinkingLevel: snapshot.thinkingLevel,
          toolMode: snapshot.toolMode,
          stats: snapshot.stats,
        };
        break;
    }
    live.events.push(browserEvent);
    if (live.events.length > 500) live.events.splice(0, live.events.length - 500);
    for (const response of live.subscribers) writeSse(response, browserEvent);
  }

  private snapshot(live: LiveChat): ChatSnapshot {
    return { ...live.pi.snapshot(), chatId: live.id, workspaceId: live.workspaceId, generation: live.generation };
  }

  private require(id: string): LiveChat {
    const live = this.chats.get(id);
    if (!live) throw new Error("Unknown or disposed chat");
    return live;
  }
}

function writeSse(response: Response, event: BrowserEvent): void {
  response.write(`id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
}
