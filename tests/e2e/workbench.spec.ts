import { expect, test } from "@playwright/test";
import { dirname } from "node:path";

const workspace = process.cwd();
const workspaceRoot = dirname(workspace);

async function openWorkspace(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page.locator("#workspace-welcome").fill(workspace);
  await page.getByRole("button", { name: "Open project" }).click();
  await expect(page.getByRole("heading", { name: "piweb" })).toBeVisible();
}

test.describe("desktop workbench", () => {
  test.skip(({ isMobile }) => isMobile, "desktop-only flow");

  test("configures roots, autocompletes a project, and returns home to switch", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: /^Settings/ }).click();
    await expect(page.getByRole("heading", { name: "Workspace access" })).toBeVisible();
    await page.getByRole("textbox", { name: "Allowed folder 1" }).fill(workspaceRoot);
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByText("Settings saved")).toBeVisible();
    await page.getByRole("button", { name: "Back to projects" }).click();

    await page.locator("#workspace-welcome").fill("pw");
    await page.getByRole("option", { name: new RegExp(`piweb.*${workspace.replaceAll("/", "\\/")}`) }).click();
    await expect(page.locator("#workspace-welcome")).toHaveValue(workspace);
    await page.getByRole("button", { name: "Open project" }).click();
    await expect(page.getByRole("heading", { name: "piweb" })).toBeVisible();
    await page.getByRole("button", { name: /Switch project/ }).click();
    await expect(page.getByRole("heading", { name: /Pick up the work/ })).toBeVisible();
  });

  test("creates a chat, streams thinking and tool activity, and stops", async ({ page }) => {
    await openWorkspace(page);
    await page.getByRole("button", { name: "Start a new chat" }).click();
    await expect(page.getByText("What are we building?")).toBeVisible();
    await page.getByLabel("Message Pi").fill("Inspect the project");
    await page.getByRole("button", { name: /Send/ }).click();
    await expect(page.getByText("Pi is working")).toBeVisible();
    await expect(page.locator(".tool-row").first()).toBeVisible();
    await expect(page.getByText(/stream, tool activity/)).toBeVisible();
    await expect(page.locator(".chat-toolbar .connection.connected")).toBeVisible();

    await page.getByLabel("Message Pi").fill("Start another task");
    await page.getByRole("button", { name: /Send/ }).click();
    await page.getByRole("button", { name: /Stop/ }).click();
    await expect(page.getByText("Stopped")).toBeVisible();
  });

  test("reopens a native session without duplicate conversation items", async ({ page }) => {
    await openWorkspace(page);
    await page.getByRole("button", { name: "Start a new chat" }).click();
    await page.getByLabel("Message Pi").fill("Remember this session");
    await page.getByRole("button", { name: /Send/ }).click();
    await expect(page.getByText(/settled state are working/)).toBeVisible();
    await page.reload();
    await page.locator("#workspace-welcome").fill(workspace);
    await page.getByRole("button", { name: "Open project" }).click();
    await page.locator(".session-row").filter({ hasText: "Remember this session" }).click();
    await expect(page.getByText("Remember this session", { exact: true })).toHaveCount(1);
  });

  test("recovers its SSE connection", async ({ page, context }) => {
    await openWorkspace(page);
    await page.getByRole("button", { name: "Start a new chat" }).click();
    await expect(page.locator(".chat-toolbar .connection.connected")).toBeVisible();
    await context.setOffline(true);
    await page.evaluate(() => window.dispatchEvent(new Event("offline")));
    await expect(page.locator(".chat-toolbar .connection.reconnecting, .chat-toolbar .connection.disconnected")).toBeVisible();
    await context.setOffline(false);
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await expect(page.locator(".chat-toolbar .connection.connected")).toBeVisible({ timeout: 10_000 });
  });
});

test.describe("mobile workbench", () => {
  test.skip(({ isMobile }) => !isMobile, "mobile-only flow");

  test("uses the drawer, explicit composer controls, and streams at 390px", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Open session drawer" }).click();
    await expect(page.getByLabel("Sessions")).toHaveClass(/open/);
    await page.locator(".drawer-close").click();
    await page.locator("#workspace-welcome").fill(workspace);
    await page.getByRole("button", { name: "Open project" }).click();
    await expect(page.getByRole("heading", { name: "piweb" })).toBeVisible();
    await page.getByRole("button", { name: "Open session drawer" }).click();
    await page.getByRole("button", { name: "New chat", exact: true }).click();
    await page.getByLabel("Message Pi").fill("Mobile stream");
    await page.getByRole("button", { name: /Send/ }).click();
    await expect(page.locator(".tool-row").first()).toBeVisible();
    await expect(page.getByText(/settled state are working/)).toBeVisible();
    const bodyWidth = await page.evaluate(() => document.body.scrollWidth);
    expect(bodyWidth).toBeLessThanOrEqual(390);
  });

  test("drawer closes with Escape and focus remains keyboard-accessible", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Open session drawer" }).focus();
    await page.keyboard.press("Enter");
    await expect(page.getByLabel("Sessions")).toHaveClass(/open/);
    await page.keyboard.press("Escape");
    await expect(page.getByLabel("Sessions")).not.toHaveClass(/open/);
  });

  test("keeps the focused composer and Send button inside a keyboard-sized viewport", async ({ page }) => {
    await page.goto("/");
    await page.locator("#workspace-welcome").fill(workspace);
    await page.getByRole("button", { name: "Open project" }).click();
    await page.getByRole("button", { name: "Start a new chat" }).click();
    await page.setViewportSize({ width: 390, height: 430 });
    await page.getByLabel("Message Pi").fill("Keyboard layout");

    const bounds = await page.evaluate(() => {
      const composer = document.querySelector(".composer")?.getBoundingClientRect();
      const send = document.querySelector(".send-button")?.getBoundingClientRect();
      return {
        composerRight: composer?.right ?? Number.POSITIVE_INFINITY,
        composerBottom: composer?.bottom ?? Number.POSITIVE_INFINITY,
        sendRight: send?.right ?? Number.POSITIVE_INFINITY,
        sendBottom: send?.bottom ?? Number.POSITIVE_INFINITY,
      };
    });

    expect(bounds.composerRight).toBeLessThanOrEqual(390);
    expect(bounds.composerBottom).toBeLessThanOrEqual(430);
    expect(bounds.sendRight).toBeLessThanOrEqual(390);
    expect(bounds.sendBottom).toBeLessThanOrEqual(430);
    await expect(page.getByRole("button", { name: /Send/ })).toBeVisible();
  });
});
