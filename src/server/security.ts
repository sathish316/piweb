import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { NextFunction, Request, Response } from "express";

export class WorkspaceStore {
  private readonly workspaces = new Map<string, string>();
  private _roots: string[];
  private constructor(roots: string[], private readonly settingsFile?: string) {
    this._roots = roots;
  }

  static async create(
    raw = process.env.WORKSPACE_ROOTS,
    options: { settingsFile?: string } = {},
  ): Promise<WorkspaceStore> {
    const settingsFile = options.settingsFile ? resolve(options.settingsFile) : undefined;
    const saved = settingsFile ? await readSavedRoots(settingsFile) : undefined;
    const candidates = saved ?? (raw ? raw.split(delimiter).filter(Boolean) : [homedir()]);
    const roots = await canonicalizeRoots(candidates);
    return new WorkspaceStore(roots, settingsFile);
  }

  get roots(): string[] {
    return [...this._roots];
  }

  async updateRoots(candidates: string[]): Promise<{ roots: string[]; revokedWorkspaceIds: string[] }> {
    const roots = await canonicalizeRoots(candidates);
    if (this.settingsFile) await writeSavedRoots(this.settingsFile, roots);
    const revokedWorkspaceIds: string[] = [];
    for (const [id, workspace] of this.workspaces) {
      if (!roots.some((root) => isDescendant(root, workspace))) {
        this.workspaces.delete(id);
        revokedWorkspaceIds.push(id);
      }
    }
    this._roots = roots;
    return { roots: this.roots, revokedWorkspaceIds };
  }

  async open(candidate: string): Promise<{ id: string; path: string }> {
    if (!candidate.trim()) throw new Error("Workspace path is required");
    const absolute = isAbsolute(candidate) ? candidate : resolve(candidate);
    const canonical = await realpath(absolute);
    if (!(await stat(canonical)).isDirectory()) throw new Error("Workspace must be an existing directory");
    if (!this._roots.some((root) => isDescendant(root, canonical))) {
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
      this._roots.some((root) => isDescendant(root, candidate)),
    ).slice(0, 8);
  }

  async suggest(query: string): Promise<string[]> {
    const input = query.trim();
    const fragment = basename(input);
    if (fragment.length < 2) return [];

    let parents = this._roots;
    if (isAbsolute(input)) {
      try {
        const parent = await realpath(dirname(input));
        if (!this._roots.some((root) => isDescendant(root, parent))) return [];
        parents = [parent];
      } catch {
        return [];
      }
    }

    const matches: Array<{ path: string; canonical: string }> = [];
    const seen = new Set<string>();
    for (const parent of parents) {
      let entries;
      try {
        entries = await readdir(parent, { withFileTypes: true });
      } catch {
        continue;
      }
      const candidates = entries
        .filter((entry) => (entry.isDirectory() || entry.isSymbolicLink()) && entry.name.toLowerCase().startsWith(fragment.toLowerCase()))
        .sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of candidates) {
        const candidate = join(parent, entry.name);
        try {
          const canonical = await realpath(candidate);
          if (
            !seen.has(canonical)
            && (await stat(canonical)).isDirectory()
            && this._roots.some((root) => isDescendant(root, canonical))
          ) {
            seen.add(canonical);
            matches.push({ path: candidate, canonical });
          }
        } catch {
          // Entries can disappear while suggestions are being built.
        }
      }
    }
    return matches
      .sort((left, right) => basename(left.path).localeCompare(basename(right.path)) || left.path.localeCompare(right.path))
      .slice(0, 12)
      .map((match) => match.path);
  }
}

export function settingsFilePath(): string {
  if (process.env.PI_WORKBENCH_SETTINGS_PATH) return resolve(process.env.PI_WORKBENCH_SETTINGS_PATH);
  if (platform() === "darwin") return join(homedir(), "Library", "Application Support", "Pi Workbench", "settings.json");
  if (platform() === "win32" && process.env.APPDATA) return join(process.env.APPDATA, "Pi Workbench", "settings.json");
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "pi-workbench", "settings.json");
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

async function canonicalizeRoots(candidates: string[]): Promise<string[]> {
  const roots: string[] = [];
  for (const candidate of candidates) {
    try {
      const canonical = await realpath(resolve(candidate));
      if ((await stat(canonical)).isDirectory() && !roots.includes(canonical)) roots.push(canonical);
    } catch {
      throw new Error(`Allowed root is not an accessible directory: ${candidate}`);
    }
  }
  if (roots.length === 0) throw new Error("At least one accessible allowed root is required");
  return roots;
}

async function readSavedRoots(settingsFile: string): Promise<string[] | undefined> {
  let text: string;
  try {
    text = await readFile(settingsFile, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    throw error;
  }
  try {
    const parsed = JSON.parse(text) as { workspaceRoots?: unknown };
    if (
      !Array.isArray(parsed.workspaceRoots)
      || parsed.workspaceRoots.length === 0
      || !parsed.workspaceRoots.every((root) => typeof root === "string" && root.trim())
    ) {
      throw new Error("workspaceRoots must be a non-empty string array");
    }
    return parsed.workspaceRoots;
  } catch (error) {
    const message = error instanceof Error ? error.message : "invalid JSON";
    throw new Error(`Pi Workbench settings are invalid: ${message}`);
  }
}

async function writeSavedRoots(settingsFile: string, roots: string[]): Promise<void> {
  const directory = dirname(settingsFile);
  const temporary = `${settingsFile}.tmp-${process.pid}-${randomUUID()}`;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    await writeFile(temporary, `${JSON.stringify({ workspaceRoots: roots }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, settingsFile);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
