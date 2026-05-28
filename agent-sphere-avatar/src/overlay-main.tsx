import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { OverlayApp } from "./modes/OverlayApp";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <OverlayApp />
  </StrictMode>,
);
