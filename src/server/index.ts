import { createServer } from "node:http";
import { createApp } from "./app.js";
import { FakePiAdapter } from "./pi/fake-adapter.js";
import { RealPiAdapter } from "./pi/real-adapter.js";
import { settingsFilePath, WorkspaceStore } from "./security.js";

const host = "127.0.0.1";
const port = parsePort(process.env.PORT);
const adapter = process.env.PI_WEB_ADAPTER === "fake" ? new FakePiAdapter() : new RealPiAdapter();
const workspaceStore = await WorkspaceStore.create(process.env.WORKSPACE_ROOTS, { settingsFile: settingsFilePath() });
const { app } = createApp({ adapter, workspaceStore, production: process.env.NODE_ENV === "production" });
const server = createServer(app);

server.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EADDRINUSE") {
    console.error(`Pi Workbench could not start: 127.0.0.1:${port} is already in use.`);
  } else {
    console.error(`Pi Workbench could not start: ${error.message}`);
  }
  process.exitCode = 1;
});

server.listen(port, host, () => {
  console.log(`Pi Workbench listening at http://${host}:${port}`);
});

function parsePort(value: string | undefined): number {
  if (value === undefined || value === "") return 4783;
  if (!/^\d+$/.test(value)) throw new Error("PORT must be an integer from 1024 to 65535");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1024 || parsed > 65535) {
    throw new Error("PORT must be an integer from 1024 to 65535");
  }
  return parsed;
}
