import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { EmbedApp } from "./modes/EmbedApp";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <EmbedApp />
  </StrictMode>,
);
