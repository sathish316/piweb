# Pi Workbench

A local, private, responsive web control surface for Pi. Pi remains the agent and source of truth for authentication, models, settings, resources, tools, and native JSONL sessions. The browser stores only a recent workspace path and unsent drafts.

Pi Workbench targets the locally installed Pi `0.79.8` SDK exactly. It binds only to `127.0.0.1`; Tailscale Serve can privately proxy that loopback listener to your tailnet.

> [!WARNING]
> Pi has no built-in sandbox and runs with the permissions of the host user. “Read only” is a model-tool allowlist, not an operating-system sandbox. Loaded extensions execute in the Pi process and may have side effects. Tailscale controls network reachability; it does not sandbox Pi.

## Requirements

- Pi CLI `0.79.8`
- Node.js `>=22.19.0` (Node 24 LTS is recommended when available; Node 20 is unsupported)
- npm
- Existing Pi authentication from a local `pi` session and `/login`

No browser credential form exists and no credential file is returned or copied.

## Install and run

```bash
npm ci
npm run dev
```

Development uses Vite at `http://127.0.0.1:5173` with a same-origin `/api` proxy to the Express server at `127.0.0.1:4783`.

Production:

```bash
npm run typecheck
npm test
npm run test:e2e
npm run build
npm start
```

Open `http://127.0.0.1:4783`. The production process serves the compiled React frontend and API together.

`PORT` may be an integer from 1024 through 65535:

```bash
PORT=5483 npm start
```

The host is intentionally not configurable. A busy port fails with a clear `EADDRINUSE` message.

## Architecture

```text
Browser (React)
  ├─ typed JSON mutations + per-process CSRF token
  └─ EventSource / bounded SSE replay
                 │ loopback or Tailscale Serve
Express 5 server │
  ├─ request/host/origin/root guards
  ├─ chat ownership + event reconciliation
  └─ typed Pi adapter
       ├─ FakePiAdapter (all automated tests)
       └─ RealPiAdapter (Pi SDK 0.79.8)
             ├─ AgentSession + public event stream
             ├─ SessionManager native JSONL
             ├─ SettingsManager / ModelRegistry
             └─ normal Pi resource loader + extension UI bridge
```

Each live chat owns one `AgentSession`. `sessionFile -> chatId` ownership prevents two writers inside one dashboard process; a second browser attaches to the existing live chat. Pi does not offer a universal cross-process lease, so never run the same native session concurrently from another dashboard process or a terminal.

The in-memory live event stream is authoritative during a run. Reconnect uses monotonic SSE IDs and a bounded 500-event replay buffer; when replay is unavailable the server sends a complete snapshot. On server restart, Pi’s fresh listing restores every written native session. The real adapter walks `SessionManager.getBranch()` and uses Pi’s resolved active leaf, so abandoned branches are not flattened into the transcript.

Pi `0.79.8` deliberately defers creating a new JSONL file until the session contains its first assistant response. An untouched empty chat therefore does not survive process restart; after the first completed Pi response, it is a normal native session and is freshly listed/resumable.

The exact `0.79.8` package currently brings two shrinkwrapped npm advisories (`brace-expansion` high-severity DoS and `protobufjs` moderate-severity DoS). They remain pinned because silently replacing Pi’s shrinkwrapped dependency tree would break the installed-CLI compatibility guarantee. Move to a Pi release containing patched transitives when available, or review an explicit override separately.

## Pi paths, settings, and trust

- Config/agent directory: resolved by Pi’s `getAgentDir()`, respecting `PI_CODING_AGENT_DIR`
- Session directory precedence: `PI_CODING_AGENT_SESSION_DIR`, then Pi’s `sessionDir` setting, then Pi’s native default
- Default config is normally `~/.pi/agent`
- Native sessions are normally under its `sessions/` child, but the dashboard never hard-codes that root
- The selected canonical project path is Pi’s `cwd`

Open **Settings** at the bottom of the sidebar to configure one or more allowed project folders. Settings are stored locally as non-secret JSON at `~/Library/Application Support/Pi Workbench/settings.json` on macOS (the platform config directory is used on Linux and Windows). Saving a narrower list immediately revokes opaque workspace IDs and live dashboard chats that fall outside the new roots.

On first run, before a settings file exists, roots are seeded from `WORKSPACE_ROOTS`. It is platform path-delimited and defaults to the home directory:

```bash
# macOS/Linux: allow home and an external volume
WORKSPACE_ROOTS="$HOME:/Volumes/Projects" npm start
```

Add directories that directly contain projects, such as `~/projects`. On the project home, typing two or more characters fuzzy-matches child directory names inside the allowed roots. Prefix matches rank first, followed by contained text and ordered-character matches. An absolute partial path can also autocomplete within an allowed parent. The project switcher directly below **New chat** returns to this home from any chat.

Workspace candidates and configured roots are canonicalized with `realpath` and checked using filesystem-aware descendant rules. Symlink and string-prefix escapes are rejected. `PI_WORKBENCH_SETTINGS_PATH` can point to a different non-secret settings file for an isolated installation or test environment.

Project-local settings, extensions, prompts, skills, and context load only when Pi’s existing trust store already allows them. The dashboard never silently approves trust. If resources are guarded, open Pi locally to make the trust decision, then reopen the project.

## Models, tools, and commands

Authenticated models come from Pi’s model registry, including custom models. If no model appears, run `pi`, then `/login`, and reopen the workspace.

New web chats begin with real read-only tools: `read`, `grep`, `find`, and `ls`. While idle, Full access switches Pi’s actual active tool array to all normal built-in and extension tools. Model, thinking level, and tool changes are disabled while busy.

Extension commands, prompt templates, and skills appear in `/` autocomplete and go through Pi’s normal prompt expansion. Built-in TUI-only commands are replaced with web actions for New, Resume, Rename, Compact, model, thinking, and tools. Extension `select`, `confirm`, input, editor, notification, and status calls are bridged to the browser. Unsupported custom TUI components fail safely with a notice.

## Security model

- Literal `127.0.0.1` bind only; no CORS
- Loopback and explicitly allowed Tailscale Host validation
- Forwarded host/protocol trusted only from an immediate loopback proxy
- Same-origin CSRF token required on every mutation
- Cross-site `Origin` and `Sec-Fetch-Site` rejected
- Helmet CSP, no CDN assets, `Referrer-Policy: no-referrer`
- 128 KB JSON request limit and bounded/redacted tool previews
- Markdown renders to React without raw HTML or `dangerouslySetInnerHTML`
- Links allow only `http:`, `https:`, and `mailto:`; remote images are disabled
- Opaque workspace, session, and chat IDs; no browser-supplied session paths
- No direct shell API, transcript database, analytics, telemetry, sharing, Funnel, or public hosting

To restrict Tailscale logins as an extra layer:

```bash
ALLOWED_TAILSCALE_HOSTS="machine.tailnet-name.ts.net" \
ALLOWED_TAILSCALE_USERS="you@example.com" \
npm start
```

`Tailscale-User-Login` is trusted only because the backend remains loopback-only behind Tailscale Serve.

## Tailscale Serve

Do not use Funnel. After the local production app is running:

```bash
tailscale serve --bg http://127.0.0.1:4783
tailscale serve status
```

If `PORT` changes, substitute that port. Configure the resulting hostname in `ALLOWED_TAILSCALE_HOSTS` when starting the app. Serve supplies a private HTTPS tailnet URL; both devices must be in the intended tailnet, and ACLs/grants should limit access to the owner.

`--bg` persists the Serve proxy configuration across Tailscale restarts and reboots. It does **not** start Pi Workbench. The host must remain powered on, awake, online, and connected to Tailscale.

## Tests

All default tests use `FakePiAdapter` and make no paid model request.

```bash
npm run typecheck       # strict server + browser types
npm test                # unit and API integration
npm run test:e2e        # Chromium desktop and mobile
npm run build           # production frontend + server
```

The tests cover canonical workspace containment and symlink escapes, path-prefix traps, persisted allowed roots, bounded project autocomplete, secret redaction, bounded outputs, single session ownership, stream replay IDs, queue/abort/settled behavior, extension dialog round trips, request limits, local/Tailscale origin and CSRF checks, URL schemes, desktop settings/project switching/streaming/resume/stop, mobile drawer/composer, reconnection, and keyboard interaction.

An explicit, no-prompt real Pi smoke allocates a native session and lists/resumes an existing saved session without contacting a model:

```bash
npm run smoke:real-pi -- /absolute/project/path
```

It is never run by the default suite. It does not force an empty JSONL write because Pi `0.79.8` defers persistence until the first assistant response.

## Troubleshooting

- **No models:** use `/login` in the local Pi TUI. The service does not collect credentials.
- **Project guarded:** review project trust in Pi locally. Guarded chats remain usable without protected project resources.
- **Project missing/moved:** reopen its current path; stale opaque workspace IDs intentionally expire on restart.
- **403 through Serve:** set the exact Serve hostname in `ALLOWED_TAILSCALE_HOSTS`; if user filtering is enabled, check `ALLOWED_TAILSCALE_USERS`.
- **Port busy:** stop the other listener or choose a validated `PORT`.
- **Disconnected stream:** confirm the Node process is running; EventSource reconnects and replays automatically.
- **Native session conflict:** close the same session in other Pi/dashboard processes before resuming here.

## Optional always-available mode (macOS)

This host is macOS. A per-user LaunchAgent can run the absolute Node binary and compiled server entry with `RunAtLoad` and `KeepAlive`, while keeping the server on `127.0.0.1`. It should preserve only non-secret values such as `PORT`, initial `WORKSPACE_ROOTS`, an optional `PI_WORKBENCH_SETTINGS_PATH`, Pi directory overrides, and allowed Tailscale hosts/users. It must not copy API keys or arbitrary interactive-shell environment values. Pi authentication should use stored `/login` credentials or a deliberate OS-native secret mechanism.

No background service is installed by this project. Manual `npm start` remains the default.

## Intentionally omitted

Profiles, voice/transcription, `/btw`, side agents, browser editing of Pi authentication/settings/trust/packages/resources, remote file browsing/editing, direct provider APIs, alternative databases, full session-tree/fork UI, cloud/public deployment, Funnel, public share, and telemetry are intentionally out of scope.
