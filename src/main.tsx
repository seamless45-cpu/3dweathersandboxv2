import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App";
import { ErrorBoundary } from "./ui/ErrorBoundary";
import { initPwa } from "./pwa";

// Register the service worker and wire the install/offline/update events before the first render
// so the UI can show the correct PWA state on its very first paint instead of flashing in later.
// This is strictly progressive enhancement: if any part of it fails the simulation must still
// start, so a failure is reported to the console and then ignored.
try {
  initPwa();
} catch (err) {
  console.warn("[MeteoLab] PWA setup failed; continuing without it.", err);
}

// `createRoot` clears whatever the server markup left inside #root on its first render, so the
// `#startup-fallback` card is replaced by the app without an explicit unmount here.
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>
);
