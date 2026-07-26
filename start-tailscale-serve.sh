#!/usr/bin/env bash
set -euo pipefail

# Port Pi Workbench listens on; override with PORT=... when invoking this script
PORT="${PORT:-4783}"

# Loopback address Serve proxies to — Pi Workbench binds here and nowhere else
TARGET="http://127.0.0.1:${PORT}"

# Fail early if jq is missing, since every step below parses Tailscale's JSON output
command -v jq >/dev/null || { echo "jq is required: brew install jq" >&2; exit 1; }

# Expose the loopback server to the tailnet over HTTPS, kept running in the background
tailscale serve --bg "$TARGET"

# Print the MagicDNS name this machine is currently registered under
tailscale status --json | jq -r '.Self.DNSName'

# Capture that name minus its trailing dot, which is the exact host Serve presents
TS_HOST="$(tailscale status --json | jq -r '.Self.DNSName' | sed 's/\.$//')"
export TS_HOST

# Bail out if Tailscale returned no name, meaning the node is unregistered or the daemon is down
[ -n "$TS_HOST" ] && [ "$TS_HOST" != "null" ] || { echo "no Tailscale hostname — is the daemon running and logged in?" >&2; exit 1; }

# Show the value to reuse when starting Pi Workbench
echo "TS_HOST=${TS_HOST}"
