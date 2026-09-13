// 屏幕感知传感器（screen_sensor）—— "用户当前在干什么"的实感来源。
//
// 数据链路：desktop-visual-subprocess 窗口枚举（前台窗口 processName + title）
// → 零 LLM 规则分类（编码/会议/视频/浏览/聊天/游戏/闲置）→ 仅在分类变化或
// 15min 心跳时产出 Signal。这是仲裁层打断成本模型的核心输入
// （贾维斯模型的支配项：Tony 正在焊东西还是闲着）。
//
// 视觉子进程不可用时（未配置/子进程未启动）：collect 抛错 → 内核熔断记健康，
// 仲裁层 screenFocus 为 null 走无屏幕先验的兜底成本。
import type { DesktopVisualPort } from "../../services/desktop-visual-port.js";
import type { ProactiveSensor, ScreenFocusKind, Signal } from "./types.js";

/** 分类默认轮询间隔 */
export const SCREEN_POLL_MS = 60_000;
/** 同分类心跳间隔（前台一直没变也定期产出，供节律/专注时长统计） */
const SCREEN_HEARTBEAT_MS = 15 * 60_000;

/** 进程名/窗口标题 → 专注分类（零 LLM 规则表，小写匹配） */
const CLASSIFY_RULES: Array<[ScreenFocusKind, RegExp]> = [
  ["meeting", /(zoom|teams|wemeet|tencent.?meeting|meeting|腾讯会议|webex|vov?o)/i],
  ["coding", /(code|idea|pycharm|webstorm|clion|goland|rider|studio64|xcode|devenv|cursor|sublime|vim|nvim|zed)/i],
  ["terminal", /(windowsterminal|powershell|cmd\.exe|conhost|wezterm|alacritty|iterm|terminal)/i],
  ["video", /(bilibili|youtube|netflix|iqiyi|youku|优酷|爱奇艺|potplayer|vlc|mpv|douyu|huya)/i],
  ["music", /(cloudmusic|spotify|qqmusic|kugou|kuwo|foobar|musicbee)/i],
  ["browsing", /(chrome|msedge|firefox|safari|arc|360se|qqbrowser|browser)/i],
  ["office", /(winword|excel|powerpnt|wps|outlook|notion|obsidian|typora|acroret|acrobat|sumatrapdf)/i],
  ["chat", /(wechat|weixin|telegram|slack|dingtalk|feishu|lark|qq\.exe|discord)/i],
  ["game", /(steam|epicgames|riotclients|game|minecraft|unity|unreal)/i],
];

/** 窗口信息 → 专注分类（导出供单测） */
export function classifyWindow(win: { processName?: string; title?: string }): ScreenFocusKind {
  const hay = `${win.processName ?? ""} ${win.title ?? ""}`;
  for (const [kind, re] of CLASSIFY_RULES) {
    if (re.test(hay)) return kind;
  }
  return "idle";
}

export type ScreenSensorOptions = {
  /** 视觉端口（desktop-visual-subprocess 实例；window({op:"list"})） */
  visualPort: DesktopVisualPort | null;
  pollIntervalMs?: number;
  nowFn?: () => number;
};

export class ScreenSensor implements ProactiveSensor {
  readonly id = "screen_foreground";
  readonly stream = "screen" as const;
  readonly pollIntervalMs: number;
  private lastKind: ScreenFocusKind | null = null;
  private lastEmitAt = 0;
  private readonly nowFn: () => number;

  constructor(private readonly opts: ScreenSensorOptions) {
    this.pollIntervalMs = opts.pollIntervalMs ?? SCREEN_POLL_MS;
    this.nowFn = opts.nowFn ?? Date.now;
  }

  /** 最近分类（仲裁层 ContextSnapshot 直读，绕过事件流延迟） */
  latest(): ScreenFocusKind | null {
    return this.lastKind;
  }

  async collect(_since: number): Promise<Signal[]> {
    const port = this.opts.visualPort;
    if (!port?.window) throw new Error("visual_port_unavailable");
    const result = await port.window({ op: "list" });
    if (!result.ok) throw new Error(result.error ?? "window_list_failed");
    const windows = result.windows ?? [];
    const fg = windows.find((w) => w.foreground === true) ?? windows.find((w) => !w.minimized) ?? null;
    const kind: ScreenFocusKind = fg ? classifyWindow(fg) : "absent";
    const now = this.nowFn();
    const heartbeatDue = now - this.lastEmitAt >= SCREEN_HEARTBEAT_MS;
    if (kind === this.lastKind && !heartbeatDue) return []; // 无变化不产出
    const changed = kind !== this.lastKind;
    this.lastKind = kind;
    this.lastEmitAt = now;
    const label = fg?.processName?.trim() || fg?.title?.slice(0, 40) || "无前台窗口";
    return [
      {
        stream: this.stream,
        at: now,
        fingerprint: `screen:${kind}:${changed ? "change" : "beat"}:${Math.floor(now / SCREEN_HEARTBEAT_MS)}`,
        salience: "low",
        delta: changed
          ? `前台应用切换 → ${screenFocusLabel(kind)}（${label}）`
          : `持续${screenFocusLabel(kind)}（${label}）`,
        payload: { kind, processName: fg?.processName ?? "", title: fg?.title?.slice(0, 80) ?? "" },
      },
    ];
  }
}

/** 分类中文标签（模板/观察流共用） */
export function screenFocusLabel(kind: ScreenFocusKind): string {
  switch (kind) {
    case "coding": return "写代码";
    case "terminal": return "用终端";
    case "meeting": return "开会";
    case "video": return "看视频";
    case "music": return "听音乐";
    case "browsing": return "浏览网页";
    case "office": return "处理文档";
    case "chat": return "聊天";
    case "game": return "玩游戏";
    case "idle": return "闲置";
    case "absent": return "离开电脑";
  }
}
