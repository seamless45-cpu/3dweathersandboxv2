import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App";
import { initPwa } from "./pwa";

// Register the service worker and wire the install/offline/update events before the first render
// so the UI can show the correct PWA state on its very first paint instead of flashing in later.
initPwa();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
