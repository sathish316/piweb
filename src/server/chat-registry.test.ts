import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Response } from "express";
import { ChatRegistry } from "./chat-registry.js";
import { FakePiAdapter } from "./pi/fake-adapter.js";

const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("chat ownership and event replay", () => {
  it("attaches a second resume to the existing live writer", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "pi-web-chat-"));
    cleanup.push(workspace);
    const adapter = new FakePiAdapter();
    const registry = new ChatRegistry(adapter);
    const first = await registry.create("workspace-1", workspace);
    const resumed = await registry.resume("workspace-1", workspace, first.sessionId);
    expect(resumed.chatId).toBe(first.chatId);
  });

  it("sends a snapshot initially and replays monotonic events on reconnect", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "pi-web-sse-"));
    cleanup.push(workspace);
    const registry = new ChatRegistry(new FakePiAdapter());
    const snapshot = await registry.create("workspace-1", workspace);
    const initial = captureResponse();
    registry.connect(snapshot.chatId, initial.response, undefined);
    expect(initial.chunks.join("")).toContain("event: snapshot");

    await registry.send(snapshot.chatId, "stream please", "normal");
    await new Promise((resolve) => setTimeout(resolve, 220));
    const replay = captureResponse();
    registry.connect(snapshot.chatId, replay.response, 0);
    const ids = [...replay.chunks.join("").matchAll(/^id: (\d+)$/gm)].map((match) => Number(match[1]));
    expect(ids.length).toBeGreaterThan(4);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
    expect(replay.chunks.join("")).toContain("event: tool_update");
  });

  it("clears queues and settles after stop", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "pi-web-stop-"));
    cleanup.push(workspace);
    const registry = new ChatRegistry(new FakePiAdapter());
    const snapshot = await registry.create("workspace-1", workspace);
    void registry.send(snapshot.chatId, "long enough to stop", "normal");
    await new Promise((resolve) => setTimeout(resolve, 35));
    await registry.send(snapshot.chatId, "change course", "steer");
    expect(registry.get(snapshot.chatId).queue.steering).toBe(1);
    await registry.abort(snapshot.chatId);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(registry.get(snapshot.chatId)).toMatchObject({ runStatus: "idle", queue: { steering: 0, followUp: 0 } });
  });
});

function captureResponse(): { response: Response; chunks: string[] } {
  const chunks: string[] = [];
  const response = {
    write: (chunk: string) => { chunks.push(chunk); return true; },
    end: () => {},
  } as unknown as Response;
  return { response, chunks };
}
