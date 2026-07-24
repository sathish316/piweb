import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import express, { type NextFunction, type Request, type Response } from "express";
import helmet from "helmet";
import { ZodError, type ZodType } from "zod";
import {
  compactSchema,
  configPatchSchema,
  createChatSchema,
  extensionResponseSchema,
  openWorkspaceSchema,
  projectSuggestionQuerySchema,
  renameSchema,
  resumeChatSchema,
  sendMessageSchema,
  updateSettingsSchema,
  type BootstrapResponse,
  type SettingsResponse,
  type WorkspaceResponse,
} from "../shared/protocol.js";
import { ChatRegistry } from "./chat-registry.js";
import type { PiAdapter } from "./pi/adapter.js";
import { createSecurityContext, requestGuard, type SecurityContext, WorkspaceStore } from "./security.js";

interface AppOptions {
  adapter: PiAdapter;
  workspaceStore: WorkspaceStore;
  security?: SecurityContext;
  production?: boolean;
}

export function createApp(options: AppOptions) {
  const app = express();
  const security = options.security ?? createSecurityContext();
  const chats = new ChatRegistry(options.adapter);
  const workspaceDetails = new Map<string, WorkspaceResponse>();

  app.disable("x-powered-by");
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", "data:"],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'none'"],
        frameAncestors: ["'none'"],
        formAction: ["'self'"],
      },
    },
    referrerPolicy: { policy: "no-referrer" },
  }));
  app.use(requestGuard(security));
  app.use(express.json({ limit: "128kb", strict: true }));

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true, piVersion: options.adapter.version, adapter: options.adapter.kind });
  });

  app.get("/api/bootstrap", (_req, res) => {
    const response: BootstrapResponse = {
      app: { name: "Pi Workbench", version: "0.2.0", piVersion: options.adapter.version, adapter: options.adapter.kind },
      csrfToken: security.csrfToken,
      workspaceHints: options.workspaceStore.hints(),
      workspaceRoots: options.workspaceStore.roots,
    };
    res.json(response);
  });

  app.get("/api/projects/suggestions", route(async (req, res) => {
    const query = parse(projectSuggestionQuerySchema, {
      query: typeof req.query.query === "string" ? req.query.query : "",
    });
    res.json({ suggestions: await options.workspaceStore.suggest(query.query) });
  }));

  app.put("/api/settings", route(async (req, res) => {
    const body = parse(updateSettingsSchema, req.body);
    let updated;
    try {
      updated = await options.workspaceStore.updateRoots(body.workspaceRoots);
    } catch (error) {
      throw apiError(400, "INVALID_WORKSPACE_ROOTS", error instanceof Error ? error.message : "Allowed roots are invalid");
    }
    await chats.disposeWorkspaces(updated.revokedWorkspaceIds);
    for (const workspaceId of updated.revokedWorkspaceIds) workspaceDetails.delete(workspaceId);
    const response: SettingsResponse = {
      workspaceRoots: updated.roots,
      revokedWorkspaceIds: updated.revokedWorkspaceIds,
    };
    res.json(response);
  }));

  app.post("/api/workspaces/open", route(async (req, res) => {
    const body = parse(openWorkspaceSchema, req.body);
    const opened = await options.workspaceStore.open(body.path);
    const pi = await options.adapter.resolveWorkspace(opened.path);
    const response: WorkspaceResponse = {
      workspaceId: opened.id,
      path: pi.canonicalPath,
      trusted: pi.trusted,
      diagnostics: pi.diagnostics,
      models: pi.models,
      sessions: pi.sessions,
    };
    workspaceDetails.set(opened.id, response);
    res.json(response);
  }));

  app.get("/api/workspaces/:workspaceId/sessions", route(async (req, res) => {
    const cwd = options.workspaceStore.get(param(req.params.workspaceId));
    const sessions = await options.adapter.listSessions(cwd);
    res.json({ sessions });
  }));

  app.post("/api/chats", route(async (req, res) => {
    const body = parse(createChatSchema, req.body);
    const cwd = options.workspaceStore.get(body.workspaceId);
    const snapshot = await chats.create(body.workspaceId, cwd);
    res.status(201).json(snapshot);
  }));

  app.post("/api/chats/resume", route(async (req, res) => {
    const body = parse(resumeChatSchema, req.body);
    const cwd = options.workspaceStore.get(body.workspaceId);
    const fresh = await options.adapter.listSessions(cwd);
    if (!fresh.some((session) => session.id === body.sessionId)) throw apiError(404, "SESSION_NOT_LISTED", "Session is no longer listed by Pi");
    const snapshot = await chats.resume(body.workspaceId, cwd, body.sessionId);
    res.json(snapshot);
  }));

  app.get("/api/chats/:id", route(async (req, res) => {
    res.json(chats.get(param(req.params.id)));
  }));

  app.get("/api/chats/:id/events", route(async (req, res) => {
    const id = param(req.params.id);
    chats.get(id);
    res.status(200);
    res.set({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      "Content-Encoding": "identity",
    });
    res.flushHeaders();
    const parsedId = Number(req.headers["last-event-id"] ?? req.query.lastEventId);
    const cleanup = chats.connect(id, res, Number.isSafeInteger(parsedId) && parsedId >= 0 ? parsedId : undefined);
    const heartbeat = setInterval(() => {
      res.write(`: heartbeat ${Date.now()}\n\n`);
    }, 20_000);
    req.on("close", () => {
      clearInterval(heartbeat);
      cleanup();
    });
  }));

  app.post("/api/chats/:id/messages", route(async (req, res) => {
    const body = parse(sendMessageSchema, req.body);
    const accepted = await chats.send(param(req.params.id), body.text, body.mode);
    if (!accepted) throw apiError(409, "PROMPT_REJECTED", "Pi rejected the prompt before starting");
    res.status(202).json({ accepted: true });
  }));

  app.post("/api/chats/:id/abort", route(async (req, res) => {
    await chats.abort(param(req.params.id));
    res.status(202).json({ stopping: false });
  }));

  app.patch("/api/chats/:id/config", route(async (req, res) => {
    const body = parse(configPatchSchema, req.body);
    const config = {
      ...(body.modelId !== undefined ? { modelId: body.modelId } : {}),
      ...(body.thinkingLevel !== undefined ? { thinkingLevel: body.thinkingLevel } : {}),
      ...(body.toolMode !== undefined ? { toolMode: body.toolMode } : {}),
    };
    res.json(await chats.configure(param(req.params.id), config));
  }));

  app.post("/api/chats/:id/rename", route(async (req, res) => {
    const body = parse(renameSchema, req.body);
    res.json(await chats.rename(param(req.params.id), body.name));
  }));

  app.post("/api/chats/:id/compact", route(async (req, res) => {
    const body = parse(compactSchema, req.body);
    await chats.compact(param(req.params.id), body.instructions);
    res.status(202).json({ accepted: true });
  }));

  app.post("/api/chats/:id/extension-response", route(async (req, res) => {
    const body = parse(extensionResponseSchema, req.body);
    await chats.respond(param(req.params.id), body.requestId, {
      ...(body.value !== undefined ? { value: body.value } : {}),
      ...(body.confirmed !== undefined ? { confirmed: body.confirmed } : {}),
      ...(body.cancelled !== undefined ? { cancelled: body.cancelled } : {}),
    });
    res.status(202).json({ accepted: true });
  }));

  app.delete("/api/chats/:id", route(async (req, res) => {
    await chats.dispose(param(req.params.id));
    res.status(204).end();
  }));

  if (options.production) {
    const here = dirname(fileURLToPath(import.meta.url));
    const clientDir = resolve(here, "../../client");
    app.use(express.static(clientDir, { index: false, etag: true, maxAge: "1h" }));
    app.get("*splat", (_req, res) => res.sendFile(resolve(clientDir, "index.html")));
  }

  app.use((_req, res) => res.status(404).json({ error: { code: "NOT_FOUND", message: "Route not found" } }));
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof ZodError) {
      res.status(400).json({ error: { code: "INVALID_REQUEST", message: "Request validation failed", details: error.issues } });
      return;
    }
    if (isEntityTooLarge(error)) {
      res.status(413).json({ error: { code: "PAYLOAD_TOO_LARGE", message: "Request body exceeds 128 KB" } });
      return;
    }
    const status = isApiError(error) ? error.status : error instanceof Error && /Unknown|outside|different workspace|no longer/i.test(error.message) ? 404 : 500;
    const code = isApiError(error) ? error.code : status === 404 ? "NOT_FOUND" : "OPERATION_FAILED";
    const message = error instanceof Error ? error.message : "Operation failed";
    res.status(status).json({ error: { code, message: message.slice(0, 4_000) } });
  });

  return { app, chats, security };
}

function parse<T>(schema: ZodType<T>, value: unknown): T {
  return schema.parse(value);
}

function route(handler: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => void handler(req, res).catch(next);
}

function apiError(status: number, code: string, message: string) {
  return Object.assign(new Error(message), { status, code });
}

function isApiError(error: unknown): error is Error & { status: number; code: string } {
  return error instanceof Error && "status" in error && "code" in error;
}

function isEntityTooLarge(error: unknown): boolean {
  return typeof error === "object" && error !== null && "type" in error && error.type === "entity.too.large";
}

function param(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}
