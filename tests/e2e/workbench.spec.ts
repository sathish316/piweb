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
    await expect(page.getByLabel("Message Pi")).toBeInViewport();
    const streamingComposerBottom = await page.locator(".composer-shell").evaluate(
      (shell) => shell.getBoundingClientRect().bottom,
    );
    expect(streamingComposerBottom).toBeCloseTo(844, 0);
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

  test("keeps the focused composer visible after app resume and keyboard resize", async ({ page }) => {
    await page.goto("/");
    await page.locator("#workspace-welcome").fill(workspace);
    await page.getByRole("button", { name: "Open project" }).click();
    await page.getByRole("button", { name: "Start a new chat" }).click();
    await page.setViewportSize({ width: 430, height: 430 });
    await page.getByLabel("Message Pi").fill("Keyboard layout");

    const bounds = await page.evaluate(() => {
      const shell = document.querySelector(".composer-shell")?.getBoundingClientRect();
      const composer = document.querySelector(".composer")?.getBoundingClientRect();
      const send = document.querySelector(".send-button")?.getBoundingClientRect();
      const textarea = document.querySelector<HTMLTextAreaElement>(".composer textarea");
      return {
        shellBottom: shell?.bottom ?? Number.POSITIVE_INFINITY,
        composerRight: composer?.right ?? Number.POSITIVE_INFINITY,
        composerBottom: composer?.bottom ?? Number.POSITIVE_INFINITY,
        sendRight: send?.right ?? Number.POSITIVE_INFINITY,
        sendBottom: send?.bottom ?? Number.POSITIVE_INFINITY,
        textareaFontSize: textarea ? Number.parseFloat(getComputedStyle(textarea).fontSize) : 0,
      };
    });

    expect(bounds.shellBottom).toBeLessThanOrEqual(430);
    expect(bounds.shellBottom).toBeGreaterThan(400);
    expect(bounds.composerRight).toBeLessThanOrEqual(430);
    expect(bounds.composerBottom).toBeLessThanOrEqual(430);
    expect(bounds.sendRight).toBeLessThanOrEqual(430);
    expect(bounds.sendBottom).toBeLessThanOrEqual(430);
    expect(bounds.textareaFontSize).toBeGreaterThanOrEqual(16);
    await expect(page.getByRole("button", { name: /Send/ })).toBeVisible();

    await page.evaluate(() => {
      const viewport = window.visualViewport;
      const textarea = document.querySelector<HTMLTextAreaElement>(".composer textarea");
      if (!viewport || !textarea) throw new Error("Visual viewport or composer is unavailable");

      const resumedViewport = {
        width: 348,
        height: 360,
        offsetLeft: 18,
        offsetTop: 36,
        pageLeft: 18,
        pageTop: 36,
        scale: 1.2,
      };
      for (const [property, value] of Object.entries(resumedViewport)) {
        Object.defineProperty(viewport, property, { configurable: true, get: () => value });
      }

      const root = document.documentElement;
      root.style.setProperty("--app-viewport-width", "430px");
      root.style.setProperty("--app-viewport-height", "844px");
      root.style.setProperty("--app-viewport-left", "0px");
      root.style.setProperty("--app-viewport-top", "0px");

      document.dispatchEvent(new Event("visibilitychange"));
      textarea.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    });

    await expect.poll(() => page.evaluate(() => ({
      width: document.documentElement.style.getPropertyValue("--app-viewport-width"),
      height: document.documentElement.style.getPropertyValue("--app-viewport-height"),
      left: document.documentElement.style.getPropertyValue("--app-viewport-left"),
      top: document.documentElement.style.getPropertyValue("--app-viewport-top"),
    }))).toEqual({ width: "348px", height: "360px", left: "18px", top: "36px" });

    const resumedBounds = await page.locator(".composer-shell").evaluate((shell) => shell.getBoundingClientRect().toJSON());
    expect(resumedBounds.left).toBeGreaterThanOrEqual(18);
    expect(resumedBounds.right).toBeLessThanOrEqual(366);
    expect(resumedBounds.bottom).toBeCloseTo(396, 0);
  });

  test("lifts the focused composer above a keyboard the page transform misses", async ({ page }) => {
    await page.goto("/");
    await page.locator("#workspace-welcome").fill(workspace);
    await page.getByRole("button", { name: "Open project" }).click();
    await page.getByRole("button", { name: "Start a new chat" }).click();
    await page.getByLabel("Message Pi").click();
    await expect(page.getByLabel("Message Pi")).toBeFocused();

    // Safari reports a page scrolled to the focused field while the visible band stays at the top,
    // which pushes the composer below the keyboard until the measured lift pulls it back
    const keyboardTop = await page.evaluate(() => {
      const viewport = window.visualViewport;
      if (!viewport) throw new Error("Visual viewport is unavailable");
      const shrunk = { width: 390, height: 360, offsetLeft: 0, offsetTop: 0, pageLeft: 0, pageTop: 300, scale: 1 };
      for (const [property, value] of Object.entries(shrunk)) {
        Object.defineProperty(viewport, property, { configurable: true, get: () => value });
      }
      viewport.dispatchEvent(new Event("resize"));
      return shrunk.height;
    });

    await expect.poll(
      () => page.locator(".composer-shell").evaluate((shell) => Math.round(shell.getBoundingClientRect().bottom)),
      { timeout: 5_000 },
    ).toBeLessThanOrEqual(keyboardTop);

    const lifted = await page.evaluate(() => ({
      lift: document.documentElement.style.getPropertyValue("--app-keyboard-lift"),
      composerTop: document.querySelector(".composer-shell")!.getBoundingClientRect().top,
      textareaBottom: document.querySelector(".composer textarea")!.getBoundingClientRect().bottom,
    }));
    expect(Number.parseFloat(lifted.lift)).toBeCloseTo(300, 0);
    expect(lifted.composerTop).toBeGreaterThanOrEqual(0);
    expect(lifted.textareaBottom).toBeLessThanOrEqual(keyboardTop);
    await expect(page.getByRole("button", { name: /Send/ })).toBeInViewport();

    // Dismissing the keyboard must hand the lift back, or the app stays shifted up
    await page.getByLabel("Message Pi").blur();
    await expect.poll(
      () => page.evaluate(() => document.documentElement.style.getPropertyValue("--app-keyboard-lift")),
      { timeout: 5_000 },
    ).toBe("0px");
  });

  test("keeps the workbench stable while repeatedly queueing from a short viewport", async ({ page }) => {
    await page.goto("/");
    await page.locator("#workspace-welcome").fill(workspace);
    await page.getByRole("button", { name: "Open project" }).click();
    await page.getByRole("button", { name: "Start a new chat" }).click();

    await page.getByLabel("Message Pi").fill("/demo-dialog");
    await page.getByRole("button", { name: /Send/ }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.getByRole("dialog").evaluate((dialog: HTMLDialogElement) => dialog.close());

    await page.setViewportSize({ width: 320, height: 360 });
    const textarea = page.getByLabel("Message Pi");
    for (let index = 1; index <= 6; index += 1) {
      await textarea.fill(`Queued mobile task ${index}`);
      await page.getByRole("button", { name: index % 2 === 0 ? "Follow-up" : "Steer" }).click();
    }

    await expect(page.getByText("6 queued", { exact: true })).toBeVisible();
    await expect(textarea).toBeInViewport();
    await expect(textarea).toBeFocused();

    const layout = await page.evaluate(() => {
      const rect = (selector: string) => document.querySelector(selector)?.getBoundingClientRect().toJSON();
      return {
        bodyWidth: document.body.scrollWidth,
        root: rect("#root"),
        chat: rect(".chat-view"),
        toolbar: rect(".chat-toolbar"),
        conversation: rect(".conversation-wrap"),
        composer: rect(".composer-shell"),
        actions: [...document.querySelectorAll<HTMLElement>(".composer-actions button")].map(
          (button) => button.getBoundingClientRect().toJSON(),
        ),
      };
    });

    expect(layout.bodyWidth).toBeLessThanOrEqual(320);
    for (const region of [layout.root, layout.chat, layout.toolbar, layout.conversation, layout.composer]) {
      expect(region).toBeDefined();
      expect(region!.left).toBeGreaterThanOrEqual(0);
      expect(region!.right).toBeLessThanOrEqual(320);
      expect(region!.width).toBeGreaterThan(0);
    }
    expect(layout.composer!.bottom).toBeCloseTo(360, 0);
    expect(layout.actions).toHaveLength(3);
    for (const action of layout.actions) {
      expect(action.left).toBeGreaterThanOrEqual(layout.composer!.left);
      expect(action.right).toBeLessThanOrEqual(layout.composer!.right);
    }
  });
});
