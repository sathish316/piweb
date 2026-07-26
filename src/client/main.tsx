import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

syncVisualViewport();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

function syncVisualViewport() {
  const viewport = window.visualViewport;
  if (!viewport) return;

  let frame = 0;
  let settleTimers: number[] = [];
  let keyboardWatch = 0;
  let lift = 0;
  let composerResize: ResizeObserver | undefined;
  const written = new Map<string, string>();

  const writeVariable = (name: string, value: string) => {
    if (written.get(name) === value) return;
    written.set(name, value);
    document.documentElement.style.setProperty(name, value);
  };

  const mobileLayout = () => window.matchMedia("(max-width: 820px)").matches;

  // The workbench is a fixed layer with nothing to scroll, yet Safari still scrolls the document
  // to reveal a focused field when the keyboard opens, which drags the app out of the visible band
  const resetDocumentScroll = () => {
    if (!mobileLayout() || (window.scrollX === 0 && window.scrollY === 0)) return;
    window.scrollTo(0, 0);
  };

  const update = () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      resetDocumentScroll();
      const offsetTop = viewport.pageTop - window.scrollY;
      const offsetLeft = viewport.pageLeft - window.scrollX;
      writeVariable("--app-viewport-height", `${Math.round(viewport.height)}px`);
      writeVariable("--app-viewport-width", `${Math.round(viewport.width)}px`);
      writeVariable(
        "--app-viewport-top",
        `${Math.round(Number.isFinite(offsetTop) ? offsetTop : viewport.offsetTop)}px`,
      );
      writeVariable(
        "--app-viewport-left",
        `${Math.round(Number.isFinite(offsetLeft) ? offsetLeft : viewport.offsetLeft)}px`,
      );
      keepComposerVisible();
    });
  };

  const composerControl = (): HTMLElement | undefined => {
    const active = document.activeElement;
    if (!(active instanceof HTMLElement)) return undefined;
    if (!active.matches("textarea, input, [contenteditable='true']")) return undefined;
    return active.closest(".composer") ? active : undefined;
  };

  const setLift = (value: number) => {
    const next = Math.max(0, Math.min(Math.round(value), Math.round(window.innerHeight)));
    if (next === lift) return;
    lift = next;
    writeVariable("--app-keyboard-lift", `${next}px`);
  };

  // Sizing the app to the visual viewport assumes the browser reports the on-screen keyboard.
  // Where it reports it late, partially, or not at all, the composer still ends up under the
  // keyboard, so measure what is actually hidden and lift the app by exactly that much.
  const keepComposerVisible = () => {
    const shell = document.querySelector(".composer-shell");
    if (!shell || !composerControl()) {
      setLift(0);
      return;
    }
    const hidden = shell.getBoundingClientRect().bottom - (viewport.offsetTop + viewport.height);
    if (Math.abs(hidden) < 2) return;
    setLift(lift + hidden);
  };

  const subscribeToViewport = () => {
    viewport.removeEventListener("resize", update);
    viewport.removeEventListener("scroll", update);
    viewport.addEventListener("resize", update);
    viewport.addEventListener("scroll", update);
  };

  const settle = () => {
    for (const timer of settleTimers) window.clearTimeout(timer);
    settleTimers = [];
    update();
    for (const delay of [50, 150, 300, 500, 800]) {
      settleTimers.push(window.setTimeout(update, delay));
    }
  };

  const resume = () => {
    if (document.hidden) return;
    // A resumed page may carry values written before it was hidden, so rewrite rather than skip
    written.clear();
    subscribeToViewport();
    settle();
  };

  // While the composer holds focus its own height changes as the draft grows or queue actions
  // appear, and each change moves the box the keyboard is competing with. Safari also opens,
  // resizes, and closes the keyboard without always reporting it, so keep sampling until focus
  // leaves the composer.
  const watchComposer = (control: HTMLElement) => {
    const shell = control.closest(".composer-shell");
    composerResize?.disconnect();
    composerResize = undefined;
    if (shell && typeof ResizeObserver !== "undefined") {
      composerResize = new ResizeObserver(update);
      composerResize.observe(shell);
    }
    window.clearInterval(keyboardWatch);
    keyboardWatch = window.setInterval(update, 250);
  };

  const releaseComposer = () => {
    composerResize?.disconnect();
    composerResize = undefined;
    window.clearInterval(keyboardWatch);
    keyboardWatch = 0;
  };

  const focusControl = (event: FocusEvent) => {
    const target = event.target;
    if (!(target instanceof HTMLElement) || !target.matches("input, textarea, select, [contenteditable='true']")) return;
    if (target.closest(".composer")) watchComposer(target);
    resume();
  };

  const blurControl = () => {
    releaseComposer();
    settle();
  };

  subscribeToViewport();
  settle();
  window.addEventListener("resize", update);
  window.addEventListener("orientationchange", settle);
  window.addEventListener("pageshow", resume);
  window.addEventListener("focus", resume);
  document.addEventListener("visibilitychange", resume);
  document.addEventListener("focusin", focusControl);
  document.addEventListener("focusout", blurControl);
}
