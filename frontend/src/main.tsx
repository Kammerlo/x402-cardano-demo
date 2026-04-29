import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { MeshProvider } from "@meshsdk/react";
import "@meshsdk/react/styles.css";
import "./styles.css";
import App from "./App";

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("missing #root element");

createRoot(rootEl).render(
  <StrictMode>
    <MeshProvider>
      <App />
    </MeshProvider>
  </StrictMode>,
);
