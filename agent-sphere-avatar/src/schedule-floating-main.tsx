import { createRoot } from "react-dom/client";
import { ScheduleFloatingWidget } from "../components/ScheduleFloatingWidget";
import "./schedule-floating.css";

/** 独立桌面日程悬浮窗入口 */
createRoot(document.getElementById("root")!).render(<ScheduleFloatingWidget />);
