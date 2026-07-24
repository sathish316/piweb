import type { BootstrapResponse, ChatSnapshot, WorkspaceResponse } from "../shared/protocol";

let csrfToken = "";

export async function bootstrap(): Promise<BootstrapResponse> {
  const value = await request<BootstrapResponse>("/api/bootstrap");
  csrfToken = value.csrfToken;
  return value;
}

export async function openWorkspace(path: string): Promise<WorkspaceResponse> {
  return mutation("/api/workspaces/open", "POST", { path });
}

export async function createChat(workspaceId: string): Promise<ChatSnapshot> {
  return mutation("/api/chats", "POST", { workspaceId });
}

export async function resumeChat(workspaceId: string, sessionId: string): Promise<ChatSnapshot> {
  return mutation("/api/chats/resume", "POST", { workspaceId, sessionId });
}

export async function sendMessage(chatId: string, text: string, mode: "normal" | "steer" | "followUp"): Promise<void> {
  await mutation(`/api/chats/${chatId}/messages`, "POST", { text, mode });
}

export async function abortChat(chatId: string): Promise<void> {
  await mutation(`/api/chats/${chatId}/abort`, "POST", {});
}

export async function patchConfig(
  chatId: string,
  config: { modelId?: string; thinkingLevel?: string; toolMode?: string },
): Promise<ChatSnapshot> {
  return mutation(`/api/chats/${chatId}/config`, "PATCH", config);
}

export async function renameChat(chatId: string, name: string): Promise<ChatSnapshot> {
  return mutation(`/api/chats/${chatId}/rename`, "POST", { name });
}

export async function compactChat(chatId: string): Promise<void> {
  await mutation(`/api/chats/${chatId}/compact`, "POST", {});
}

export async function respondToExtension(
  chatId: string,
  response: { requestId: string; value?: string; confirmed?: boolean; cancelled?: boolean },
): Promise<void> {
  await mutation(`/api/chats/${chatId}/extension-response`, "POST", response);
}

async function mutation<T>(path: string, method: string, body: unknown): Promise<T> {
  return request<T>(path, {
    method,
    headers: { "Content-Type": "application/json", "X-Pi-CSRF": csrfToken },
    body: JSON.stringify(body),
  });
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  const payload = response.status === 204 ? undefined : await response.json().catch(() => undefined);
  if (!response.ok) {
    const message = payload && typeof payload === "object" && "error" in payload
      ? String((payload as { error?: { message?: string } }).error?.message ?? response.statusText)
      : response.statusText;
    throw new Error(message);
  }
  return payload as T;
}
