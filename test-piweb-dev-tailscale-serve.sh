#!/usr/bin/env bash
set -euo pipefail

# Port the Vite dev server listens on; override with DEV_PORT=... when invoking this script
DEV_PORT="${DEV_PORT:-5173}"

# Fail early if jq is missing, since the hostname lookup below parses Tailscale's JSON output
command -v jq >/dev/null || { echo "jq is required: brew install jq" >&2; exit 1; }

# Reuse TS_HOST when already exported, otherwise read this machine's MagicDNS name minus its trailing dot
TS_HOST="${TS_HOST:-$(tailscale status --json | jq -r '.Self.DNSName' | sed 's/\.$//')}"

# Bail out if Tailscale returned no name, meaning the node is unregistered or the daemon is down
[ -n "$TS_HOST" ] && [ "$TS_HOST" != "null" ] || { echo "no Tailscale hostname — is the daemon running and logged in?" >&2; exit 1; }

# Report which URL is being tested, since the hostname changes if the node is ever re-registered
echo "testing https://${TS_HOST}/ (dev mode)"

# Verify the tailnet HTTPS URL resolves and responds, printing only the status line
curl -sI "https://${TS_HOST}/" | head -1

# Confirm Serve is pointed at the dev server rather than the production port, since dev serves the frontend from Vite
tailscale serve status 2>/dev/null | grep -q "127.0.0.1:${DEV_PORT}" \
  || echo "warning: Tailscale Serve is not pointing at 127.0.0.1:${DEV_PORT} — run PORT=${DEV_PORT} ./start-tailscale-serve.sh" >&2

# Confirm the page came from the dev server, whose module script is the on-the-fly client entry
curl -s "https://${TS_HOST}/" | grep -q "/src/client/main.tsx" \
  && echo "dev server is serving the client entry" \
  || { echo "not dev mode — the page has no /src/client/main.tsx entry" >&2; exit 1; }

# Confirm Vite's own dev endpoint answers through Serve, which is what module and HMR requests need
echo -n "vite client module: "
curl -sI "https://${TS_HOST}/@vite/client" | head -1

# Confirm the API reaches the watching server through the dev proxy
echo -n "api health: "
curl -s "https://${TS_HOST}/api/health" | head -c 200; echo
