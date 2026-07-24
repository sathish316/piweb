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
  const update = () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      if (viewport.scale !== 1) return;
      const root = document.documentElement;
      root.style.setProperty("--app-viewport-height", `${Math.round(viewport.height)}px`);
      root.style.setProperty("--app-viewport-width", `${Math.round(viewport.width)}px`);
      root.style.setProperty("--app-viewport-top", `${Math.round(viewport.offsetTop)}px`);
      root.style.setProperty("--app-viewport-left", `${Math.round(viewport.offsetLeft)}px`);
    });
  };

  update();
  viewport.addEventListener("resize", update);
  viewport.addEventListener("scroll", update);
  window.addEventListener("orientationchange", update);
}
