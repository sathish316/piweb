import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// API port the dev server proxies to; keep in step with the PORT the server process uses
const apiPort = Number(process.env.PORT || 4783);

// Loopback port the dev server binds; Tailscale Serve proxies to this one in dev mode
const devPort = Number(process.env.DEV_PORT || 5173);

// Set only when the dev server is reached through Tailscale Serve, which terminates HTTPS on 443
const serveHost = process.env.TS_HOST?.trim().replace(/\.$/, "");

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist/client",
    emptyOutDir: true,
  },
  server: {
    host: "127.0.0.1",
    port: devPort,
    // Serve forwards the tailnet Host header, which Vite otherwise rejects as an unknown host
    ...(serveHost ? { allowedHosts: [serveHost], hmr: { protocol: "wss", clientPort: 443 } } : {}),
    proxy: {
      "/api": {
        target: `http://127.0.0.1:${apiPort}`,
        changeOrigin: false,
      },
    },
  },
});
