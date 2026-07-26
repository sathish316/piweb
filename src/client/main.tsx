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

  const update = () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      const root = document.documentElement;
      const offsetTop = viewport.pageTop - window.scrollY;
      const offsetLeft = viewport.pageLeft - window.scrollX;
      root.style.setProperty("--app-viewport-height", `${Math.round(viewport.height)}px`);
      root.style.setProperty("--app-viewport-width", `${Math.round(viewport.width)}px`);
      root.style.setProperty(
        "--app-viewport-top",
        `${Math.round(Number.isFinite(offsetTop) ? offsetTop : viewport.offsetTop)}px`,
      );
      root.style.setProperty(
        "--app-viewport-left",
        `${Math.round(Number.isFinite(offsetLeft) ? offsetLeft : viewport.offsetLeft)}px`,
      );
    });
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
    subscribeToViewport();
    settle();
  };

  const focusControl = (event: FocusEvent) => {
    const target = event.target;
    if (!(target instanceof HTMLElement) || !target.matches("input, textarea, select, [contenteditable='true']")) return;
    resume();
  };

  subscribeToViewport();
  settle();
  window.addEventListener("resize", update);
  window.addEventListener("orientationchange", settle);
  window.addEventListener("pageshow", resume);
  window.addEventListener("focus", resume);
  document.addEventListener("visibilitychange", resume);
  document.addEventListener("focusin", focusControl);
}
