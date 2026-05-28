import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { EmbedApp } from "./modes/EmbedApp";

document.documentElement.classList.add("embed-root");

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <EmbedApp />
  </StrictMode>,
);
