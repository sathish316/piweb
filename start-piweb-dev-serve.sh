#!/usr/bin/env bash
set -euo pipefail

# Run from the repository root regardless of where this script is invoked from
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Port the API server listens on; override with PORT=... when invoking this script
PORT="${PORT:-4783}"

# Port the Vite dev server listens on — this is what Tailscale Serve must proxy to in dev mode
DEV_PORT="${DEV_PORT:-5173}"

# Fail early if jq is missing, since the hostname lookup below parses Tailscale's JSON output
command -v jq >/dev/null || { echo "jq is required: brew install jq" >&2; exit 1; }

# Stop any earlier API server or dev server still holding either port, which would otherwise abort startup
for BUSY_PORT in "$PORT" "$DEV_PORT"; do
  if PIDS="$(lsof -ti "tcp:${BUSY_PORT}")" && [ -n "$PIDS" ]; then kill $PIDS; fi
done

# Read this machine's MagicDNS name, minus its trailing dot, as the host Serve presents
export TS_HOST="$(tailscale status --json | jq -r '.Self.DNSName' | sed 's/\.$//')"

# Bail out if Tailscale returned no name, since the server would then reject every tailnet request
[ -n "$TS_HOST" ] && [ "$TS_HOST" != "null" ] || { echo "no Tailscale hostname — is the daemon running and logged in?" >&2; exit 1; }

# Serve must point at the dev server, not the API port, because Vite serves the frontend and proxies /api
if ! tailscale serve status 2>/dev/null | grep -q "127.0.0.1:${DEV_PORT}"; then
  echo "note: Tailscale Serve is not pointing at 127.0.0.1:${DEV_PORT} — run PORT=${DEV_PORT} ./start-tailscale-serve.sh" >&2
fi

# Report the URL to open, since only this host is accepted by the API server and the dev server
echo "dev mode on https://${TS_HOST}/ (Vite ${DEV_PORT} -> API ${PORT})"

# Start the watching API server and the Vite dev server, both accepting requests for this exact host
PORT="$PORT" DEV_PORT="$DEV_PORT" ALLOWED_TAILSCALE_HOSTS="$TS_HOST" npm run dev
