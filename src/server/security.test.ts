import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
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
});
