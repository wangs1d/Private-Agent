import { useCallback, useEffect, useRef, useState } from "react";

interface ScheduleItem {
  id: string;
  title: string;
  time: string;
  description?: string;
  completed?: boolean;
}

/** 从 URL 参数获取连接信息 */
function getConfig() {
  const params = new URLSearchParams(window.location.search);
  return {
    wsUrl: params.get("ws") || "",
    sessionId: params.get("sessionId") || "",
    httpBase: params.get("httpBase") || "",
  };
}

/** 格式化今日日期 */
function formatTodayLabel(): string {
  const now = new Date();
  const weekdays = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
  return `${now.getMonth() + 1}月${now.getDate()}日 ${weekdays[now.getDay()]}`;
}

/**
 * 独立桌面悬浮窗 — 今日安排
 *
 * 拖动策略（双保险）：
 * 1. 优先尝试 CSS `-webkit-app-region: drag`（由 Electron/Chromium 系统处理）
 * 2. 兜底：JS 拖动 — 使用 rAF 批处理 + IPC 节流，确保 60fps 平滑
 */
export function ScheduleFloatingWidget() {
  const [schedules, setSchedules] = useState<ScheduleItem[]>([]);
  const [collapsed, setCollapsed] = useState(false);

  const { httpBase } = getConfig();

  /** 拖动状态 — 用 ref 避免触发重渲染 */
  const dragStateRef = useRef<{
    startX: number;
    startY: number;
    lastX: number;
    lastY: number;
    accumDx: number;
    accumDy: number;
    rafId: number | null;
  } | null>(null);

  /** 加载日程 */
  const loadSchedules = useCallback(async () => {
    try {
      if (httpBase) {
        const response = await fetch(
          `${httpBase.replace(/\/$/, "")}/api/schedule/today`,
          { headers: { "Content-Type": "application/json" } },
        );
        if (response.ok) {
          const data = await response.json();
          if (Array.isArray(data) && data.length > 0) {
            const items: ScheduleItem[] = data.map((item: Record<string, unknown>) => ({
              id: String(item.id ?? Date.now()),
              title: String(item.title ?? "未命名"),
              time: item.startAt
                ? new Date(item.startAt as string).toLocaleTimeString("zh-CN", {
                    hour: "2-digit",
                    minute: "2-digit",
                  })
                : "",
              description: item.notes ? String(item.notes) : undefined,
              completed: item.completed as boolean | undefined,
            }));
            setSchedules(items);
            return;
          }
        }
      }
      setSchedules([]);
    } catch {
      setSchedules([]);
    }
  }, [httpBase]);

  useEffect(() => {
    loadSchedules();
    const interval = setInterval(loadSchedules, 30000);
    return () => clearInterval(interval);
  }, [loadSchedules]);

  /** 监听来自宿主窗口的日程更新 */
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (event.data?.type === "schedule-update" && Array.isArray(event.data.schedules)) {
        setSchedules(event.data.schedules);
      }
    };
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, []);

  /**
   * 拖动开始 — Pointer Capture + 初始化 ref
   */
  const handleHeaderPointerDown = useCallback((e: React.PointerEvent<HTMLElement>) => {
    // 如果点击的是按钮/角标，不触发拖动
    if ((e.target as HTMLElement).closest(".schedule-float__action, .schedule-float__badge")) {
      return;
    }
    e.preventDefault();
    e.stopPropagation();

    const el = e.currentTarget;
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }

    dragStateRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      lastX: e.clientX,
      lastY: e.clientY,
      accumDx: 0,
      accumDy: 0,
      rafId: null,
    };

    // 拖动期间不要让点击穿透到桌面
    window.sphereOverlay?.setIgnoreMouseEvents?.(false, true);
  }, []);

  /**
   * 拖动中 — 每帧只 flush 一次（rAF 批处理）
   *
   * 原生 onPointerMove 可能 1 帧触发多次（高 DPI 鼠标），
   * 但 IPC send + 进程间通讯 + setBounds 都不该被高频调用。
   * 这里用累加 + rAF 调度，60fps 上限。
   */
  const handleHeaderPointerMove = useCallback((e: React.PointerEvent<HTMLElement>) => {
    const state = dragStateRef.current;
    if (!state) return;

    const dx = e.clientX - state.lastX;
    const dy = e.clientY - state.lastY;
    state.lastX = e.clientX;
    state.lastY = e.clientY;
    state.accumDx += dx;
    state.accumDy += dy;

    // 如果这一帧已经调度过 rAF，不再重复
    if (state.rafId !== null) return;

    state.rafId = requestAnimationFrame(() => {
      const s = dragStateRef.current;
      if (!s) return;
      s.rafId = null;

      // 一次性把本帧累计的 delta 发给主进程
      if (s.accumDx !== 0 || s.accumDy !== 0) {
        window.sphereOverlay?.moveBy?.(s.accumDx, s.accumDy);
        s.accumDx = 0;
        s.accumDy = 0;
      }
    });
  }, []);

  /** 拖动结束 */
  const handleHeaderPointerUp = useCallback((e: React.PointerEvent<HTMLElement>) => {
    const state = dragStateRef.current;
    if (!state) return;

    // flush 剩余 delta
    if (state.accumDx !== 0 || state.accumDy !== 0) {
      window.sphereOverlay?.moveBy?.(state.accumDx, state.accumDy);
    }
    if (state.rafId !== null) {
      cancelAnimationFrame(state.rafId);
    }

    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }

    dragStateRef.current = null;

    // 折叠时恢复鼠标穿透
    if (collapsed) {
      window.sphereOverlay?.setIgnoreMouseEvents?.(true, true);
    }
  }, [collapsed]);

  /** 切换展开/折叠 */
  const toggleCollapse = useCallback((e?: React.MouseEvent) => {
    e?.stopPropagation();
    e?.preventDefault();
    setCollapsed((prev) => {
      const next = !prev;
      window.sphereOverlay?.setIgnoreMouseEvents?.(next, true);
      return next;
    });
  }, []);

  const pendingCount = schedules.filter((s) => !s.completed).length;
  const todayLabel = formatTodayLabel();

  return (
    <div className={`schedule-float${collapsed ? " schedule-float--collapsed" : ""}`}>
      {/* 标题栏 — JS 拖动为主，CSS app-region 兜底 */}
      <header
        className="schedule-float__header"
        onPointerDown={handleHeaderPointerDown}
        onPointerMove={handleHeaderPointerMove}
        onPointerUp={handleHeaderPointerUp}
        onPointerCancel={handleHeaderPointerUp}
      >
        <div className="schedule-float__title-row">
          <span className="schedule-float__icon">📅</span>
          <span className="schedule-float__title">今日安排</span>
          <span className="schedule-float__date">{todayLabel}</span>
        </div>
        <div className="schedule-float__actions">
          {schedules.length > 0 && (
            <span className="schedule-float__badge">{pendingCount}</span>
          )}
          <button
            type="button"
            className="schedule-float__action"
            onClick={toggleCollapse}
            onPointerDown={(e) => e.stopPropagation()}
            title={collapsed ? "展开" : "折叠"}
          >
            {collapsed ? "▼" : "▲"}
          </button>
        </div>
      </header>

      {!collapsed && (
        <>
          <div className="schedule-float__body">
            {schedules.length === 0 ? (
              <div className="schedule-float__empty">
                <span className="schedule-float__empty-icon">📝</span>
                <span>暂无日程数据</span>
              </div>
            ) : (
              <ul className="schedule-float__list">
                {schedules.map((item) => (
                  <li
                    key={item.id}
                    className={`schedule-float__item${item.completed ? " is-completed" : ""}`}
                  >
                    <span className="schedule-float__item-time">{item.time}</span>
                    <span className="schedule-float__item-title">{item.title}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {schedules.length > 0 && (
            <div className="schedule-float__footer">
              共 {schedules.length} 项 · {pendingCount} 待执行
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** 全局类型声明 — 扩展 window.electronAPI（sphereOverlay 已在 useOverlayWindowMotion 中声明） */
declare global {
  interface Window {
    electronAPI?: {
      moveWindow: (dx: number, dy: number) => void;
      resizeWindow: (collapsed: boolean) => void;
    };
  }
}
