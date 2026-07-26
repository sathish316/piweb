#!/usr/bin/env bash
set -euo pipefail

# Run from the repository root regardless of where this script is invoked from
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Port Pi Workbench listens on; override with PORT=... when invoking this script
PORT="${PORT:-4783}"

# Fail early if jq is missing, since the hostname lookup below parses Tailscale's JSON output
command -v jq >/dev/null || { echo "jq is required: brew install jq" >&2; exit 1; }

# Stop any earlier Pi Workbench still holding the port, which would otherwise abort startup
if PIDS="$(lsof -ti "tcp:${PORT}")" && [ -n "$PIDS" ]; then kill $PIDS; fi

# Compile the production frontend and server bundles into dist/
npm run build

# Read this machine's MagicDNS name, minus its trailing dot, as the host Serve presents
export TS_HOST="$(tailscale status --json | jq -r '.Self.DNSName' | sed 's/\.$//')"

# Bail out if Tailscale returned no name, since the server would then reject every tailnet request
[ -n "$TS_HOST" ] && [ "$TS_HOST" != "null" ] || { echo "no Tailscale hostname — is the daemon running and logged in?" >&2; exit 1; }

# Start the production server, accepting requests that arrive through Serve for this exact host
ALLOWED_TAILSCALE_HOSTS="$TS_HOST" npm start
