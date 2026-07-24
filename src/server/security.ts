import { randomBytes, randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, isAbsolute, relative, resolve } from "node:path";
import type { NextFunction, Request, Response } from "express";

export class WorkspaceStore {
  private readonly workspaces = new Map<string, string>();
  private constructor(readonly roots: string[]) {}

  static async create(raw = process.env.WORKSPACE_ROOTS): Promise<WorkspaceStore> {
    const candidates = raw ? raw.split(delimiter).filter(Boolean) : [homedir()];
    const roots: string[] = [];
    for (const candidate of candidates) {
      const canonical = await realpath(resolve(candidate));
      if ((await stat(canonical)).isDirectory() && !roots.includes(canonical)) roots.push(canonical);
    }
    if (roots.length === 0) throw new Error("WORKSPACE_ROOTS does not contain an accessible directory");
    return new WorkspaceStore(roots);
  }

  async open(candidate: string): Promise<{ id: string; path: string }> {
    if (!candidate.trim()) throw new Error("Workspace path is required");
    const absolute = isAbsolute(candidate) ? candidate : resolve(candidate);
    const canonical = await realpath(absolute);
    if (!(await stat(canonical)).isDirectory()) throw new Error("Workspace must be an existing directory");
    if (!this.roots.some((root) => isDescendant(root, canonical))) {
      throw new Error("Workspace is outside WORKSPACE_ROOTS");
    }
    const existing = [...this.workspaces].find(([, value]) => value === canonical);
    if (existing) return { id: existing[0], path: canonical };
    const id = randomUUID();
    this.workspaces.set(id, canonical);
    return { id, path: canonical };
  }

  get(id: string): string {
    const path = this.workspaces.get(id);
    if (!path) throw new Error("Unknown or expired workspace");
    return path;
  }

  hints(): string[] {
    return [...new Set([...this.workspaces.values(), process.cwd()])].filter((candidate) =>
      this.roots.some((root) => isDescendant(root, candidate)),
    ).slice(0, 8);
  }
}

export function isDescendant(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export interface SecurityContext {
  csrfToken: string;
  allowedTailscaleHosts: Set<string>;
  allowedTailscaleUsers: Set<string>;
}

export function createSecurityContext(): SecurityContext {
  return {
    csrfToken: randomBytes(32).toString("base64url"),
    allowedTailscaleHosts: new Set(splitList(process.env.ALLOWED_TAILSCALE_HOSTS).map(normalizeHost)),
    allowedTailscaleUsers: new Set(splitList(process.env.ALLOWED_TAILSCALE_USERS)),
  };
}

export function requestGuard(context: SecurityContext) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const directHost = normalizeHost(req.headers.host ?? "");
    const remoteLoopback = isLoopback(req.socket.remoteAddress);
    const forwardedHost = remoteLoopback && typeof req.headers["x-forwarded-host"] === "string"
      ? normalizeHost(req.headers["x-forwarded-host"].split(",")[0] ?? "")
      : undefined;
    const effectiveHost = forwardedHost || directHost;
    if (!isAllowedHost(directHost, context.allowedTailscaleHosts) || !isAllowedHost(effectiveHost, context.allowedTailscaleHosts)) {
      sendSecurityError(res, 400, "INVALID_HOST", "Host is not allowed");
      return;
    }
    if (req.headers["sec-fetch-site"] === "cross-site") {
      sendSecurityError(res, 403, "CROSS_SITE", "Cross-site requests are not allowed");
      return;
    }
    const forwardedProto = remoteLoopback && typeof req.headers["x-forwarded-proto"] === "string"
      ? req.headers["x-forwarded-proto"].split(",")[0]?.trim()
      : undefined;
    const protocol = forwardedProto === "https" ? "https" : "http";
    const effectiveOrigin = `${protocol}://${effectiveHost}`;
    if (typeof req.headers.origin === "string" && normalizeOrigin(req.headers.origin) !== normalizeOrigin(effectiveOrigin)) {
      sendSecurityError(res, 403, "INVALID_ORIGIN", "Request origin does not match this dashboard");
      return;
    }
    if (forwardedHost && context.allowedTailscaleUsers.size > 0) {
      const login = req.headers["tailscale-user-login"];
      if (typeof login !== "string" || !context.allowedTailscaleUsers.has(login)) {
        sendSecurityError(res, 403, "TAILSCALE_USER_REJECTED", "Tailscale user is not allowed");
        return;
      }
    }
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method) && req.headers["x-pi-csrf"] !== context.csrfToken) {
      sendSecurityError(res, 403, "CSRF", "Missing or invalid CSRF token");
      return;
    }
    next();
  };
}

function isAllowedHost(host: string, tailscale: Set<string>): boolean {
  if (!host) return false;
  const hostname = host.startsWith("[") ? host.slice(1, host.indexOf("]")) : host.split(":")[0] ?? "";
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1" || tailscale.has(hostname);
}

function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/\.$/, "");
}

function normalizeOrigin(origin: string): string {
  try {
    const value = new URL(origin);
    return `${value.protocol}//${normalizeHost(value.host)}`;
  } catch {
    return "";
  }
}

function isLoopback(address: string | undefined): boolean {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1" || address === undefined;
}

function splitList(value: string | undefined): string[] {
  return value?.split(",").map((item) => item.trim()).filter(Boolean) ?? [];
}

function sendSecurityError(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ error: { code, message } });
}
