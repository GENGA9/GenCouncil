import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
// the looks' stylesheets, ahead of styles.css as they were when the looks were part of the first
// load: the looks themselves are loaded later (App.tsx), and rules of the same weight must keep their order
import "./vision/vision.css";
import "./vision/sheet.css";
import "./avatar/avatar.css";
import "./avatar/meeting.css";
import "./components/float.css";
import "./styles.css";
import { applyTheme } from "./theme";

// before the first paint, so a saved theme never flashes the other one
applyTheme();

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

// built app only: on the dev server it would keep serving the old, unhashed source files from its cache
if (import.meta.env.PROD && "serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost")) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => undefined);
  });
}
