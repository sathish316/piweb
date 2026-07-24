import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isDescendant, WorkspaceStore } from "./security.js";

const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("workspace containment", () => {
  it("blocks string-prefix traps", () => {
    expect(isDescendant("/tmp/work", "/tmp/work")).toBe(true);
    expect(isDescendant("/tmp/work", "/tmp/work/project")).toBe(true);
    expect(isDescendant("/tmp/work", "/tmp/work-evil")).toBe(false);
    expect(isDescendant("/tmp/work", "/tmp/elsewhere")).toBe(false);
  });

  it("canonicalizes symlinks before checking roots", async () => {
    const base = await mkdtemp(join(tmpdir(), "pi-web-security-"));
    cleanup.push(base);
    const allowed = join(base, "allowed");
    const outside = join(base, "outside");
    await mkdir(allowed);
    await mkdir(outside);
    await symlink(outside, join(allowed, "escape"));
    const store = await WorkspaceStore.create(allowed);
    await expect(store.open(join(allowed, "escape"))).rejects.toThrow("outside WORKSPACE_ROOTS");
    await expect(store.open(allowed)).resolves.toMatchObject({ path: store.roots[0] });
  });

  it("ranks fuzzy directory matches after two characters", async () => {
    const base = await mkdtemp(join(tmpdir(), "pi-web-suggest-"));
    cleanup.push(base);
    const allowed = join(base, "allowed");
    const outside = join(base, "outside");
    await mkdir(join(allowed, "project-alpha"), { recursive: true });
    await mkdir(join(allowed, "project-beta"));
    await mkdir(outside);
    await writeFile(join(allowed, "project-not-a-folder"), "file");
    await symlink(outside, join(allowed, "project-escape"));
    const store = await WorkspaceStore.create(allowed);

    await expect(store.suggest("p")).resolves.toEqual([]);
    await expect(store.suggest("pr")).resolves.toEqual([
      join(store.roots[0] ?? allowed, "project-beta"),
      join(store.roots[0] ?? allowed, "project-alpha"),
    ]);
    await expect(store.suggest("pb")).resolves.toEqual([
      join(store.roots[0] ?? allowed, "project-beta"),
    ]);
    await expect(store.suggest(join(outside, "pro"))).resolves.toEqual([]);
  });

  it("persists updated roots and revokes workspaces that are no longer allowed", async () => {
    const base = await mkdtemp(join(tmpdir(), "pi-web-settings-"));
    cleanup.push(base);
    const firstRoot = join(base, "first");
    const secondRoot = join(base, "second");
    const settingsFile = join(base, "state", "settings.json");
    await mkdir(firstRoot);
    await mkdir(secondRoot);
    const store = await WorkspaceStore.create(firstRoot, { settingsFile });
    const opened = await store.open(firstRoot);

    const updated = await store.updateRoots([secondRoot]);
    expect(updated.revokedWorkspaceIds).toEqual([opened.id]);
    expect(() => store.get(opened.id)).toThrow("Unknown or expired workspace");

    const restored = await WorkspaceStore.create(firstRoot, { settingsFile });
    expect(restored.roots).toEqual(updated.roots);
  });
});
