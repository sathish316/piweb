#!/usr/bin/env bash
set -euo pipefail

# Show what Serve currently exposes, so the change is visible before anything is torn down
tailscale serve status || true

# Remove all Serve configuration for this node, dropping the tailnet HTTPS proxy
tailscale serve reset

# Confirm nothing is being served any more
tailscale serve status || true
