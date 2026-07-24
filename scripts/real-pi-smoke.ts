import { realpath } from "node:fs/promises";
import { RealPiAdapter } from "../src/server/pi/real-adapter.js";

const cwd = await realpath(process.argv[2] ?? process.cwd());
const adapter = new RealPiAdapter();

console.log(`Pi SDK: ${adapter.version}`);
console.log(`Workspace: ${cwd}`);
const workspace = await adapter.resolveWorkspace(cwd);
console.log(`Trust: ${workspace.trusted ? "trusted" : "guarded"}`);
console.log(`Authenticated models: ${workspace.models.length}`);
console.log(`Existing sessions: ${workspace.sessions.length}`);

const created = await adapter.createChat(cwd);
console.log(`Allocated native session: ${created.sessionId}`);
await created.dispose();

const listed = await adapter.listSessions(cwd);
if (listed.length === 0) {
  console.log("No saved session exists to resume. Pi 0.79.8 defers new JSONL files until the first assistant response.");
} else {
  const resumed = await adapter.resumeChat(cwd, listed[0]!.id);
  console.log(`Resumed saved native session: ${resumed.sessionId}`);
  await resumed.dispose();
}
console.log("Real-Pi smoke passed without sending a model prompt.");
