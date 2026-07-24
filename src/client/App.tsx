import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type {
  BootstrapResponse,
  BrowserEvent,
  ChatSnapshot,
  ConversationItem,
  ExtensionRequest,
  SessionSummary,
  WorkspaceResponse,
} from "../shared/protocol";
import * as api from "./api";

type ConnectionState = "connected" | "reconnecting" | "disconnected";

export function App() {
  const [boot, setBoot] = useState<BootstrapResponse>();
  const [workspace, setWorkspace] = useState<WorkspaceResponse>();
  const [workspacePath, setWorkspacePath] = useState("");
  const [chat, setChat] = useState<ChatSnapshot>();
  const [connection, setConnection] = useState<ConnectionState>("disconnected");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);

  useEffect(() => {
    void api.bootstrap().then((value) => {
      setBoot(value);
      const remembered = localStorage.getItem("pi-workbench.workspace");
      setWorkspacePath(remembered ?? value.workspaceHints[0] ?? "");
    }).catch((reason: Error) => setError(reason.message));
  }, []);

  const run = useCallback(async <T,>(operation: () => Promise<T>): Promise<T | undefined> => {
    setBusy(true);
    setError("");
    try {
      return await operation();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Operation failed");
      return undefined;
    } finally {
      setBusy(false);
    }
  }, []);

  async function handleOpenWorkspace() {
    const value = await run(() => api.openWorkspace(workspacePath));
    if (!value) return;
    setWorkspace(value);
    setChat(undefined);
    localStorage.setItem("pi-workbench.workspace", value.path);
  }

  async function handleNew() {
    if (!workspace) return;
    const value = await run(() => api.createChat(workspace.workspaceId));
    if (value) {
      setChat(value);
      setWorkspace((current) => current ? {
        ...current,
        sessions: current.sessions.some((session) => session.id === value.sessionId)
          ? current.sessions
          : [{
              id: value.sessionId,
              firstMessage: "Empty session",
              updatedAt: new Date().toISOString(),
              messageCount: 0,
              cwd: value.cwd,
              activeChatId: value.chatId,
            }, ...current.sessions],
      } : current);
      setDrawerOpen(false);
    }
  }

  async function handleResume(session: SessionSummary) {
    if (!workspace) return;
    const value = await run(() => api.resumeChat(workspace.workspaceId, session.id));
    if (value) {
      setChat(value);
      setDrawerOpen(false);
    }
  }

  return (
    <div className="app-shell">
      <Sidebar
        open={drawerOpen}
        workspace={workspace}
        workspacePath={workspacePath}
        setWorkspacePath={setWorkspacePath}
        onOpen={() => void handleOpenWorkspace()}
        onNew={() => void handleNew()}
        onResume={(session) => void handleResume(session)}
        busy={busy}
        close={() => setDrawerOpen(false)}
      />
      {drawerOpen && <button className="scrim" aria-label="Close session drawer" onClick={() => setDrawerOpen(false)} />}
      <main className="main-column">
        <header className="mobile-bar">
          <button className="icon-button" aria-label="Open session drawer" onClick={() => setDrawerOpen(true)}>
            <MenuIcon />
          </button>
          <span className="mobile-title">Pi Workbench</span>
          <ConnectionBadge state={connection} compact />
        </header>
        {error && (
          <div className="global-error" role="alert">
            <span>{error}</span>
            <button onClick={() => setError("")}>Dismiss</button>
          </div>
        )}
        {!workspace ? (
          <Welcome path={workspacePath} setPath={setWorkspacePath} open={() => void handleOpenWorkspace()} busy={busy} roots={boot?.workspaceRoots ?? []} />
        ) : !chat ? (
          <EmptyWorkspace workspace={workspace} onNew={() => void handleNew()} />
        ) : (
          <ChatView
            chat={chat}
            setChat={setChat}
            workspace={workspace}
            connection={connection}
            setConnection={setConnection}
            reportError={setError}
          />
        )}
      </main>
    </div>
  );
}

function Sidebar(props: {
  open: boolean;
  workspace: WorkspaceResponse | undefined;
  workspacePath: string;
  setWorkspacePath: (value: string) => void;
  onOpen: () => void;
  onNew: () => void;
  onResume: (session: SessionSummary) => void;
  busy: boolean;
  close: () => void;
}) {
  const [query, setQuery] = useState("");
  const sessions = props.workspace?.sessions.filter((session) => {
    const haystack = `${session.name ?? ""} ${session.firstMessage}`.toLowerCase();
    return haystack.includes(query.toLowerCase());
  }) ?? [];
  const drawerRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!props.open) return;
    drawerRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") props.close();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [props.open, props.close]);

  return (
    <aside ref={drawerRef} tabIndex={-1} aria-label="Sessions" className={`sidebar ${props.open ? "open" : ""}`}>
      <div className="brand">
        <span className="brand-mark" aria-hidden="true">π</span>
        <div><strong>Pi Workbench</strong><small>Local control surface</small></div>
        <button className="drawer-close icon-button" aria-label="Close session drawer" onClick={props.close}>×</button>
      </div>
      <button className="new-chat" onClick={props.onNew} disabled={!props.workspace || props.busy}>
        <span aria-hidden="true">＋</span> New chat
      </button>
      <label className="field-label" htmlFor="workspace-sidebar">Project</label>
      <div className="path-field">
        <input
          id="workspace-sidebar"
          value={props.workspacePath}
          onChange={(event) => props.setWorkspacePath(event.target.value)}
          aria-label="Project path"
          spellCheck={false}
        />
        <button onClick={props.onOpen} disabled={props.busy}>Open</button>
      </div>
      {props.workspace && (
        <>
          <div className="current-project" title={props.workspace.path}>
            <span className={`trust-dot ${props.workspace.trusted ? "trusted" : "guarded"}`} />
            <div><strong>{basename(props.workspace.path)}</strong><small>{props.workspace.path}</small></div>
          </div>
          <div className="session-heading"><span>Recent sessions</span><span>{props.workspace.sessions.length}</span></div>
          <input
            className="session-search"
            type="search"
            placeholder="Search conversations"
            aria-label="Search sessions"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <nav className="session-list" aria-label="Recent Pi sessions">
            {sessions.map((session) => (
              <button key={session.id} className="session-row" onClick={() => props.onResume(session)}>
                <strong>{session.name || session.firstMessage || "Empty session"}</strong>
                <span>{formatRelative(session.updatedAt)} · {session.messageCount} messages</span>
              </button>
            ))}
            {sessions.length === 0 && <p className="sidebar-empty">No matching sessions.</p>}
          </nav>
        </>
      )}
      <div className="sidebar-foot">Bound to this machine · no cloud relay</div>
    </aside>
  );
}

function Welcome(props: { path: string; setPath: (value: string) => void; open: () => void; busy: boolean; roots: string[] }) {
  return (
    <section className="welcome">
      <div className="signal-mark" aria-hidden="true"><span /><span /><span /></div>
      <p className="eyebrow">Pi is the agent. This is the window.</p>
      <h1>Pick up the work<br />where you left it.</h1>
      <p className="welcome-copy">Open a local project to start a native Pi session or resume an existing one. Your sessions, tools, models, and authentication stay with Pi.</p>
      <div className="welcome-path">
        <label htmlFor="workspace-welcome">Project directory</label>
        <div>
          <input id="workspace-welcome" value={props.path} onChange={(event) => props.setPath(event.target.value)} spellCheck={false} />
          <button onClick={props.open} disabled={props.busy}>{props.busy ? "Opening…" : "Open project"}</button>
        </div>
      </div>
      <p className="root-note">Allowed roots: {props.roots.join(", ") || "Loading…"}</p>
    </section>
  );
}

function EmptyWorkspace({ workspace, onNew }: { workspace: WorkspaceResponse; onNew: () => void }) {
  return (
    <section className="empty-workspace">
      <span className="empty-glyph" aria-hidden="true">_</span>
      <h1>{basename(workspace.path)}</h1>
      <p>{workspace.models.length === 0 ? "No authenticated model is available. Run Pi locally and use /login, then reopen this project." : "Start a new native Pi session, or choose a previous session from the sidebar."}</p>
      {workspace.diagnostics.map((diagnostic) => <div className="diagnostic" key={diagnostic}>{diagnostic}</div>)}
      <button onClick={onNew} disabled={workspace.models.length === 0}>Start a new chat</button>
    </section>
  );
}

function ChatView(props: {
  chat: ChatSnapshot;
  setChat: React.Dispatch<React.SetStateAction<ChatSnapshot | undefined>>;
  workspace: WorkspaceResponse;
  connection: ConnectionState;
  setConnection: (value: ConnectionState) => void;
  reportError: (value: string) => void;
}) {
  const { chat, setChat } = props;
  useChatEvents(chat.chatId, chat.generation, setChat, props.setConnection);
  const isActive = chat.runStatus !== "idle" && chat.runStatus !== "error";

  async function config(change: { modelId?: string; thinkingLevel?: string; toolMode?: string }) {
    try {
      setChat(await api.patchConfig(chat.chatId, change));
    } catch (reason) {
      props.reportError(reason instanceof Error ? reason.message : "Configuration failed");
    }
  }

  async function rename() {
    const name = window.prompt("Session name", chat.name ?? "");
    if (!name?.trim()) return;
    try { setChat(await api.renameChat(chat.chatId, name.trim())); } catch (reason) {
      props.reportError(reason instanceof Error ? reason.message : "Rename failed");
    }
  }

  return (
    <div className="chat-view">
      <header className="chat-toolbar">
        <div className="chat-identity">
          <strong>{chat.name || basename(chat.cwd)}</strong>
          <button onClick={() => void rename()} disabled={isActive}>Rename</button>
        </div>
        <div className="agent-controls">
          <label>
            <span>Model</span>
            <select value={chat.modelId ?? ""} onChange={(event) => void config({ modelId: event.target.value })} disabled={isActive || props.workspace.models.length === 0}>
              {props.workspace.models.map((model) => <option value={model.id} key={model.id}>{model.name}</option>)}
            </select>
          </label>
          <label>
            <span>Thinking</span>
            <select value={chat.thinkingLevel} onChange={(event) => void config({ thinkingLevel: event.target.value })} disabled={isActive}>
              {["off", "minimal", "low", "medium", "high", "xhigh"].map((level) => <option value={level} key={level}>{capitalize(level)}</option>)}
            </select>
          </label>
          <label>
            <span>Tools</span>
            <select value={chat.toolMode} onChange={(event) => void config({ toolMode: event.target.value })} disabled={isActive}>
              <option value="readOnly">Read only</option>
              <option value="full">Full access</option>
            </select>
          </label>
          <button className="compact-button" onClick={() => void api.compactChat(chat.chatId).catch((reason: Error) => props.reportError(reason.message))} disabled={isActive}>Compact</button>
        </div>
        <ConnectionBadge state={props.connection} />
      </header>
      <Conversation items={chat.items} active={isActive} />
      <Composer chat={chat} reportError={props.reportError} />
      <ExtensionDialog chatId={chat.chatId} request={chat.extensionRequest} reportError={props.reportError} />
    </div>
  );
}

function Conversation({ items, active }: { items: ConversationItem[]; active: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const shouldStick = useRef(true);
  const [showJump, setShowJump] = useState(false);

  useEffect(() => {
    if (shouldStick.current) ref.current?.scrollTo({ top: ref.current.scrollHeight, behavior: active ? "auto" : "smooth" });
  }, [items, active]);

  function onScroll() {
    const node = ref.current;
    if (!node) return;
    shouldStick.current = node.scrollHeight - node.scrollTop - node.clientHeight <= 96;
    setShowJump(!shouldStick.current);
  }

  function jump() {
    ref.current?.scrollTo({ top: ref.current.scrollHeight, behavior: "smooth" });
    shouldStick.current = true;
    setShowJump(false);
  }

  return (
    <div className="conversation-wrap">
      <div className="conversation" ref={ref} onScroll={onScroll} aria-live="polite">
        {items.length === 0 && (
          <div className="conversation-empty">
            <span>Ready</span>
            <h2>What are we building?</h2>
            <p>Pi has the project context. Send an instruction to begin.</p>
          </div>
        )}
        {items.map((item) => <ConversationItemView key={item.id} item={item} />)}
        {active && <div className="working-line"><i /><span>Pi is working</span></div>}
      </div>
      {showJump && <button className="jump-button" onClick={jump}>Jump to latest ↓</button>}
    </div>
  );
}

function ConversationItemView({ item }: { item: ConversationItem }) {
  if (item.kind === "notice") {
    return <div className={`notice ${item.level}`} role={item.level === "error" ? "alert" : "status"}>{item.text}</div>;
  }
  if (item.kind === "tool") {
    return (
      <details className={`tool-row ${item.state}`}>
        <summary>
          <span className="tool-state" aria-hidden="true" />
          <code>{item.name}</code>
          <span>{item.summary || "No arguments"}</span>
          <small>{item.state}</small>
        </summary>
        {item.preview && <pre>{item.preview}</pre>}
      </details>
    );
  }
  return (
    <article className={`message ${item.role}`}>
      <div className="message-label">{item.role === "assistant" ? "Pi" : item.role === "user" ? "You" : "System"}</div>
      <div className="message-body">
        {item.thinking && (
          <details className="thinking">
            <summary>Thinking</summary>
            <pre>{item.thinking}</pre>
          </details>
        )}
        {item.role === "assistant" && item.complete ? <SafeMarkdown text={item.text} /> : <p className="stream-text">{item.text}</p>}
        {item.error && <div className="message-error">{item.error}</div>}
      </div>
    </article>
  );
}

function SafeMarkdown({ text }: { text: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      urlTransform={(url) => safeUrl(url)}
      components={{
        a: ({ href, children, ...rest }) => href
          ? <a {...rest} href={href} target="_blank" rel="noopener noreferrer">{children}</a>
          : <span>{children}</span>,
        img: ({ alt }) => <span className="blocked-image">[Remote image blocked{alt ? `: ${alt}` : ""}]</span>,
      }}
    >
      {text}
    </ReactMarkdown>
  );
}

export function safeUrl(value: string): string {
  try {
    const url = new URL(value, "http://localhost");
    if (["http:", "https:", "mailto:"].includes(url.protocol)) return value;
  } catch {
    return "";
  }
  return "";
}

function Composer({ chat, reportError }: { chat: ChatSnapshot; reportError: (value: string) => void }) {
  const storageKey = `pi-workbench.draft.${chat.sessionId}`;
  const [draft, setDraft] = useState(() => localStorage.getItem(storageKey) ?? "");
  const textarea = useRef<HTMLTextAreaElement>(null);
  const active = chat.runStatus !== "idle" && chat.runStatus !== "error";
  const commands = useMemo(() => {
    if (!draft.startsWith("/") || draft.includes(" ")) return [];
    return chat.commands.filter((command) => `/${command.name}`.startsWith(draft)).slice(0, 6);
  }, [draft, chat.commands]);

  useEffect(() => {
    localStorage.setItem(storageKey, draft);
    const node = textarea.current;
    if (node) {
      node.style.height = "auto";
      node.style.height = `${Math.min(node.scrollHeight, 220)}px`;
    }
  }, [draft, storageKey]);

  async function send(mode: "normal" | "steer" | "followUp") {
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    try {
      await api.sendMessage(chat.chatId, text, mode);
    } catch (reason) {
      setDraft(text);
      reportError(reason instanceof Error ? reason.message : "Prompt was rejected");
    }
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    const mobile = window.matchMedia("(max-width: 820px)").matches;
    if (!mobile && event.key === "Enter" && !event.shiftKey && !active) {
      event.preventDefault();
      void send("normal");
    }
  }

  return (
    <div className="composer-shell">
      <div className="composer">
        {commands.length > 0 && (
          <div className="command-menu" role="listbox" aria-label="Pi commands">
            {commands.map((command) => (
              <button key={command.name} onClick={() => setDraft(`/${command.name} `)}>
                <code>/{command.name}</code><span>{command.description}</span>
              </button>
            ))}
          </div>
        )}
        <textarea
          ref={textarea}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder={active ? "Queue a direction for Pi…" : "Message Pi…"}
          aria-label="Message Pi"
          rows={1}
        />
        <div className="composer-actions">
          <div className="queue-summary">
            {active ? `${chat.queue.steering + chat.queue.followUp} queued` : "Enter to send · Shift+Enter for newline"}
          </div>
          {active ? (
            <>
              <button className="queue-button" onClick={() => void send("steer")} disabled={!draft.trim()}>Steer</button>
              <button className="queue-button" onClick={() => void send("followUp")} disabled={!draft.trim()}>Follow-up</button>
              <button className="stop-button" onClick={() => void api.abortChat(chat.chatId).catch((reason: Error) => reportError(reason.message))}>
                <span aria-hidden="true">■</span> Stop
              </button>
            </>
          ) : (
            <button className="send-button" onClick={() => void send("normal")} disabled={!draft.trim()}>
              Send <span aria-hidden="true">↑</span>
            </button>
          )}
        </div>
      </div>
      {chat.toolMode === "readOnly" && <p className="tool-warning">Read only limits model-visible tools; it is not an OS sandbox, and loaded extensions may still have side effects.</p>}
    </div>
  );
}

function ExtensionDialog({ chatId, request, reportError }: { chatId: string; request: ExtensionRequest | undefined; reportError: (value: string) => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [value, setValue] = useState("");
  useEffect(() => {
    if (request) {
      setValue(request.prefill ?? "");
      dialog.current?.showModal();
    } else dialog.current?.close();
  }, [request]);
  if (!request) return null;
  const currentRequest = request;
  async function respond(response: { value?: string; confirmed?: boolean; cancelled?: boolean }) {
    try { await api.respondToExtension(chatId, { requestId: currentRequest.id, ...response }); } catch (reason) {
      reportError(reason instanceof Error ? reason.message : "Extension response failed");
    }
  }
  return (
    <dialog ref={dialog} className="extension-dialog" onCancel={(event) => { event.preventDefault(); void respond({ cancelled: true }); }}>
      <form method="dialog" onSubmit={(event) => event.preventDefault()}>
        <p className="eyebrow">Extension request</p>
        <h2>{request.title}</h2>
        {request.message && <p>{request.message}</p>}
        {request.method === "select" && <div className="dialog-options">{request.options?.map((option) => <button key={option} onClick={() => void respond({ value: option })}>{option}</button>)}</div>}
        {(request.method === "input" || request.method === "editor") && (
          request.method === "editor"
            ? <textarea value={value} onChange={(event) => setValue(event.target.value)} rows={8} />
            : <input value={value} onChange={(event) => setValue(event.target.value)} placeholder={request.placeholder} autoFocus />
        )}
        <div className="dialog-actions">
          <button onClick={() => void respond({ cancelled: true })}>Cancel</button>
          {request.method === "confirm" && <><button onClick={() => void respond({ confirmed: false })}>No</button><button className="primary" onClick={() => void respond({ confirmed: true })}>Yes</button></>}
          {(request.method === "input" || request.method === "editor") && <button className="primary" onClick={() => void respond({ value })}>Continue</button>}
        </div>
      </form>
    </dialog>
  );
}

function useChatEvents(
  chatId: string,
  generation: number,
  setChat: React.Dispatch<React.SetStateAction<ChatSnapshot | undefined>>,
  setConnection: (value: ConnectionState) => void,
) {
  const deltas = useRef<Array<{ type: "text" | "thinking"; itemId: string; delta: string }>>([]);
  const frame = useRef<number | undefined>(undefined);
  useEffect(() => {
    let failures = 0;
    const source = new EventSource(`/api/chats/${chatId}/events`);
    const onOffline = () => setConnection("reconnecting");
    const onOnline = () => setConnection(source.readyState === EventSource.OPEN ? "connected" : "reconnecting");
    window.addEventListener("offline", onOffline);
    window.addEventListener("online", onOnline);
    source.onopen = () => { failures = 0; setConnection("connected"); };
    source.onerror = () => {
      failures += 1;
      setConnection(failures > 3 ? "disconnected" : "reconnecting");
    };
    source.onmessage = (message) => handle(JSON.parse(message.data) as BrowserEvent);
    for (const type of ["snapshot", "run_status", "item", "assistant_delta", "thinking_delta", "assistant_end", "tool_update", "queue_update", "notice", "extension_request", "extension_closed", "metadata"]) {
      source.addEventListener(type, (message) => handle(JSON.parse((message as MessageEvent<string>).data) as BrowserEvent));
    }
    function flush() {
      const batch = deltas.current.splice(0);
      frame.current = undefined;
      setChat((current) => {
        if (!current || current.chatId !== chatId) return current;
        const items = current.items.map((item) => {
          const relevant = batch.filter((delta) => delta.itemId === item.id);
          if (item.kind !== "message" || relevant.length === 0) return item;
          const copy = { ...item };
          for (const delta of relevant) {
            if (delta.type === "text") copy.text += delta.delta;
            else copy.thinking = `${copy.thinking ?? ""}${delta.delta}`;
          }
          return copy;
        });
        return { ...current, items };
      });
    }
    function handle(event: BrowserEvent) {
      if (event.generation !== generation) return;
      if (event.type === "assistant_delta" || event.type === "thinking_delta") {
        deltas.current.push({ type: event.type === "assistant_delta" ? "text" : "thinking", itemId: event.itemId, delta: event.delta });
        frame.current ??= requestAnimationFrame(flush);
        return;
      }
      setChat((current) => reduceEvent(current, event, chatId));
    }
    return () => {
      source.close();
      window.removeEventListener("offline", onOffline);
      window.removeEventListener("online", onOnline);
      if (frame.current !== undefined) cancelAnimationFrame(frame.current);
      setConnection("disconnected");
    };
  }, [chatId, generation, setChat, setConnection]);
}

function reduceEvent(current: ChatSnapshot | undefined, event: BrowserEvent, chatId: string): ChatSnapshot | undefined {
  if (event.type === "snapshot") return event.snapshot;
  if (!current || current.chatId !== chatId) return current;
  if (event.type === "run_status") return { ...current, runStatus: event.status };
  if (event.type === "item" || event.type === "notice") {
    const item = event.item;
    return current.items.some((candidate) => candidate.id === item.id) ? current : { ...current, items: [...current.items, item] };
  }
  if (event.type === "tool_update") return { ...current, items: upsert(current.items, event.item) };
  if (event.type === "assistant_end") return {
    ...current,
    items: current.items.map((item) => item.id === event.itemId && item.kind === "message" ? { ...item, complete: true, ...(event.error ? { error: event.error } : {}) } : item),
  };
  if (event.type === "queue_update") return { ...current, queue: { steering: event.steering, followUp: event.followUp } };
  if (event.type === "extension_request") return { ...current, extensionRequest: event.request };
  if (event.type === "extension_closed") {
    const { extensionRequest: _closed, ...rest } = current;
    return rest as ChatSnapshot;
  }
  if (event.type === "metadata") return {
    ...current,
    ...(event.name ? { name: event.name } : {}),
    ...(event.modelId ? { modelId: event.modelId } : {}),
    thinkingLevel: event.thinkingLevel,
    toolMode: event.toolMode,
    stats: event.stats,
  };
  return current;
}

function upsert(items: ConversationItem[], item: ConversationItem): ConversationItem[] {
  const index = items.findIndex((candidate) => candidate.id === item.id);
  if (index < 0) return [...items, item];
  return items.map((candidate, current) => current === index ? item : candidate);
}

function ConnectionBadge({ state, compact = false }: { state: ConnectionState; compact?: boolean }) {
  return <div className={`connection ${state} ${compact ? "compact" : ""}`} title={`Stream ${state}`}><i />{!compact && <span>{capitalize(state)}</span>}</div>;
}
function MenuIcon() { return <span aria-hidden="true" className="menu-icon"><i /><i /><i /></span>; }
function basename(path: string) { return path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || path; }
function capitalize(value: string) { return value.charAt(0).toUpperCase() + value.slice(1); }
function formatRelative(value: string) {
  const difference = Date.now() - new Date(value).getTime();
  if (difference < 60_000) return "now";
  if (difference < 3_600_000) return `${Math.floor(difference / 60_000)}m`;
  if (difference < 86_400_000) return `${Math.floor(difference / 3_600_000)}h`;
  return new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
