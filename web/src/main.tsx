import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { resolveToken } from "./api";
import { App } from "./App";
import "./styles.css";

// Capture (and strip) the `?token=` the daemon opened us with, before the app makes any request.
resolveToken();

const root = document.getElementById("root");
if (!root) throw new Error("missing #root element");
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
