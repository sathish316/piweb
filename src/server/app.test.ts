import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { FakePiAdapter } from "./pi/fake-adapter.js";
import { createSecurityContext, WorkspaceStore } from "./security.js";

let base = "";
let workspace = "";
let store: WorkspaceStore;
let adapter: FakePiAdapter;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "pi-web-app-"));
  workspace = join(base, "project");
  await mkdir(workspace);
  await mkdir(join(base, "project-two"));
  store = await WorkspaceStore.create(base);
  adapter = new FakePiAdapter();
});
afterEach(async () => rm(base, { recursive: true, force: true }));

describe("HTTP security and flows", () => {
  it("allows loopback and rejects unapproved hosts and cross-site origins", async () => {
    const context = createSecurityContext();
    const { app } = createApp({ adapter, workspaceStore: store, security: context });
    await request(app).get("/api/bootstrap").set("Host", "127.0.0.1:4783").set("Origin", "http://127.0.0.1:4783").expect(200);
    await request(app).get("/api/bootstrap").set("Host", "evil.example").expect(400);
    await request(app).get("/api/bootstrap").set("Host", "localhost:4783").set("Origin", "https://evil.example").expect(403);
    await request(app).get("/api/bootstrap").set("Host", "localhost:4783").set("Sec-Fetch-Site", "cross-site").expect(403);
  });

  it("accepts an explicitly configured Tailscale Serve origin through loopback", async () => {
    const context = createSecurityContext();
    context.allowedTailscaleHosts.add("pi.example.ts.net");
    context.allowedTailscaleUsers.add("owner@example.com");
    const { app } = createApp({ adapter, workspaceStore: store, security: context });
    await request(app)
      .get("/api/bootstrap")
      .set("Host", "127.0.0.1:4783")
      .set("X-Forwarded-Host", "pi.example.ts.net")
      .set("X-Forwarded-Proto", "https")
      .set("Origin", "https://pi.example.ts.net")
      .set("Tailscale-User-Login", "owner@example.com")
      .expect(200);
    await request(app)
      .get("/api/bootstrap")
      .set("Host", "127.0.0.1:4783")
      .set("X-Forwarded-Host", "pi.example.ts.net")
      .set("X-Forwarded-Proto", "https")
      .set("Origin", "https://pi.example.ts.net")
      .set("Tailscale-User-Login", "intruder@example.com")
      .expect(403);
  });

  it("requires CSRF for mutations and enforces the body limit", async () => {
    const context = createSecurityContext();
    const { app } = createApp({ adapter, workspaceStore: store, security: context });
    await request(app).post("/api/workspaces/open").send({ path: workspace }).expect(403);
    await request(app)
      .post("/api/workspaces/open")
      .set("X-Pi-CSRF", context.csrfToken)
      .send({ path: "x".repeat(140_000) })
      .expect(413);
  });

  it("autocompletes allowed project folders and persists validated root changes", async () => {
    const context = createSecurityContext();
    const { app } = createApp({ adapter, workspaceStore: store, security: context });
    const short = await request(app).get("/api/projects/suggestions").query({ query: "pr" }).expect(200);
    expect(short.body.suggestions).toEqual([]);
    const suggested = await request(app).get("/api/projects/suggestions").query({ query: "pro" }).expect(200);
    const canonicalWorkspace = join(store.roots[0] ?? base, "project");
    expect(suggested.body.suggestions).toEqual([canonicalWorkspace, join(store.roots[0] ?? base, "project-two")]);

    await request(app).put("/api/settings").send({ workspaceRoots: [workspace] }).expect(403);
    const updated = await request(app)
      .put("/api/settings")
      .set("X-Pi-CSRF", context.csrfToken)
      .send({ workspaceRoots: [workspace] })
      .expect(200);
    expect(updated.body.workspaceRoots).toEqual([canonicalWorkspace]);
    const bootstrap = await request(app).get("/api/bootstrap").expect(200);
    expect(bootstrap.body.workspaceRoots).toEqual([canonicalWorkspace]);

    await request(app)
      .put("/api/settings")
      .set("X-Pi-CSRF", context.csrfToken)
      .send({ workspaceRoots: [join(base, "missing")] })
      .expect(400);
  });

  it("disposes live chats when settings revoke their workspace root", async () => {
    const context = createSecurityContext();
    const { app } = createApp({ adapter, workspaceStore: store, security: context });
    const opened = await request(app)
      .post("/api/workspaces/open")
      .set("X-Pi-CSRF", context.csrfToken)
      .send({ path: workspace })
      .expect(200);
    const created = await request(app)
      .post("/api/chats")
      .set("X-Pi-CSRF", context.csrfToken)
      .send({ workspaceId: opened.body.workspaceId })
      .expect(201);
    const replacementRoot = join(base, "project-two");
    const updated = await request(app)
      .put("/api/settings")
      .set("X-Pi-CSRF", context.csrfToken)
      .send({ workspaceRoots: [replacementRoot] })
      .expect(200);

    expect(updated.body.revokedWorkspaceIds).toEqual([opened.body.workspaceId]);
    await request(app).get(`/api/chats/${created.body.chatId}`).expect(404);
  });

  it("creates, streams, resumes, configures, compacts, renames, and completes an extension dialog", async () => {
    const context = createSecurityContext();
    const { app } = createApp({ adapter, workspaceStore: store, security: context });
    const mutate = (method: "post" | "patch", path: string) => request(app)[method](path).set("X-Pi-CSRF", context.csrfToken);
    const opened = await mutate("post", "/api/workspaces/open").send({ path: workspace }).expect(200);
    const workspaceId = opened.body.workspaceId as string;
    const created = await mutate("post", "/api/chats").send({ workspaceId }).expect(201);
    const chatId = created.body.chatId as string;
    const sessionId = created.body.sessionId as string;

    await mutate("patch", `/api/chats/${chatId}/config`).send({ thinkingLevel: "high", toolMode: "full" }).expect(200);
    await mutate("post", `/api/chats/${chatId}/rename`).send({ name: "Native session" }).expect(200);
    await mutate("post", `/api/chats/${chatId}/compact`).send({}).expect(202);
    await new Promise((resolve) => setTimeout(resolve, 30));
    await mutate("post", `/api/chats/${chatId}/messages`).send({ text: "/demo-dialog", mode: "normal" }).expect(202);
    const dialogSnapshot = await request(app).get(`/api/chats/${chatId}`).expect(200);
    const requestId = dialogSnapshot.body.extensionRequest.id as string;
    await mutate("post", `/api/chats/${chatId}/extension-response`).send({ requestId, confirmed: true }).expect(202);
    const settled = await request(app).get(`/api/chats/${chatId}`).expect(200);
    expect(settled.body).toMatchObject({ runStatus: "idle", name: "Native session" });
    expect(settled.body).not.toHaveProperty("extensionRequest");

    const resumed = await mutate("post", "/api/chats/resume").send({ workspaceId, sessionId }).expect(200);
    expect(resumed.body.chatId).toBe(chatId);
  });
});
