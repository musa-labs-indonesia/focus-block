import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
// Bundled, not fetched: the app's CSP is `default-src 'self'`, so a remote font could never load.
// Space Grotesk speaks for display type, Inter for body, JetBrains Mono for the countdown digits.
import "@fontsource-variable/space-grotesk";
import "@fontsource-variable/inter";
import "@fontsource-variable/jetbrains-mono";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
