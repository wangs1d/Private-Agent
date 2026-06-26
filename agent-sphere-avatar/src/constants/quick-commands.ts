export interface QuickCommand {
  id: string;
  label: string;
  icon: string;
  action: "wake" | "chat" | "roam" | "voice" | "game" | "smart_home" | "schedule" | "music";
  text?: string;
  category: "user" | "agent" | "shared";
}

/** Overlay 快捷指令 */
export const OVERLAY_QUICK_COMMANDS: QuickCommand[] = [
  { id: "weather", label: "今天天气", icon: "☀", action: "chat", text: "今天天气怎么样？", category: "user" },
  { id: "schedule", label: "我的日程", icon: "📅", action: "schedule", category: "user" },
  { id: "smart_home", label: "智能家居", icon: "🏠", action: "chat", text: "帮我看看家里的智能设备状态", category: "agent" },
  { id: "game", label: "进入游戏", icon: "🎮", action: "game", category: "agent" },
  { id: "music", label: "一起听", icon: "🎵", action: "music", category: "agent" },
  { id: "voice", label: "语音输入", icon: "🎤", action: "voice", category: "shared" },
];
