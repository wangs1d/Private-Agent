import { createRoot } from "react-dom/client";
import { OverlayApp } from "./modes/OverlayApp";

/** 桌宠不用 StrictMode — 避免双挂载导致 WebGL/模型闪灭 */
createRoot(document.getElementById("root")!).render(<OverlayApp />);
