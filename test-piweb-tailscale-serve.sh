#!/usr/bin/env bash
set -euo pipefail

# Fail early if jq is missing, since the hostname lookup below parses Tailscale's JSON output
command -v jq >/dev/null || { echo "jq is required: brew install jq" >&2; exit 1; }

# Reuse TS_HOST when already exported, otherwise read this machine's MagicDNS name minus its trailing dot
TS_HOST="${TS_HOST:-$(tailscale status --json | jq -r '.Self.DNSName' | sed 's/\.$//')}"

# Bail out if Tailscale returned no name, meaning the node is unregistered or the daemon is down
[ -n "$TS_HOST" ] && [ "$TS_HOST" != "null" ] || { echo "no Tailscale hostname — is the daemon running and logged in?" >&2; exit 1; }

# Report which URL is being tested, since the hostname changes if the node is ever re-registered
echo "testing https://${TS_HOST}/"

# Verify the tailnet HTTPS URL resolves and responds, printing only the status line
curl -sI "https://${TS_HOST}/" | head -1
