import { useCallback, useEffect, useState } from "react";

interface ScheduleItem {
  id: string;
  title: string;
  time: string;
  description?: string;
  completed?: boolean;
}

/** 从 URL 参数或 Electron preload 获取 WebSocket 连接信息 */
function getWsConfig() {
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
  const month = now.getMonth() + 1;
  const day = now.getDate();
  return `${month}月${day}日 ${weekdays[now.getDay()]}`;
}

/** 独立桌面悬浮窗 — 今日安排（日程 Widget） */
export function ScheduleFloatingWidget() {
  const [schedules, setSchedules] = useState<ScheduleItem[]>([]);
  const [collapsed, setCollapsed] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });

  const { wsUrl, httpBase } = getWsConfig();

  /** 加载今日日程数据 */
  const loadSchedules = useCallback(async () => {
    try {
      // 尝试从服务端 API 获取日程数据
      if (httpBase) {
        const response = await fetch(`${httpBase.replace(/\/$/, "")}/api/schedule/today`, {
          headers: { "Content-Type": "application/json" },
        });
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

      // 如果 API 调用失败，尝试通过 WebSocket 获取（如果可用）
      if (wsUrl && (window as unknown as Record<string, unknown>).scheduleData) {
        const data = (window as unknown as Record<string, unknown>).scheduleData;
        if (Array.isArray(data)) {
          setSchedules(data as ScheduleItem[]);
          return;
        }
      }

      // 默认空状态
      setSchedules([]);
    } catch {
      setSchedules([]);
    }
  }, [wsUrl, httpBase]);

  useEffect(() => {
    loadSchedules();
    // 每 30 秒刷新一次日程数据
    const interval = setInterval(loadSchedules, 30000);
    return () => clearInterval(interval);
  }, [loadSchedules]);

  /** 监听来自主窗口的日程更新消息 */
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (event.data?.type === "schedule-update" && Array.isArray(event.data.schedules)) {
        setSchedules(event.data.schedules);
      }
    };
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, []);

  /** 开始拖动 */
  const handleDragStart = useCallback(
    (e: React.PointerEvent) => {
      if ((e.target as HTMLElement).closest(".schedule-float__action")) return;
      setIsDragging(true);
      setDragOffset({ x: e.clientX, y: e.clientY });
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);

      // 通知 Electron 开始拖动
      window.sphereOverlay?.setIgnoreMouseEvents?.(false, true);
    },
    []
  );

  /** 拖动中 */
  const handleDragMove = useCallback(
    (e: React.PointerEvent) => {
      if (!isDragging) return;
      const dx = e.clientX - dragOffset.x;
      const dy = e.clientY - dragOffset.y;

      // 通过 IPC 移动窗口
      if (window.electronAPI?.moveWindow) {
        window.electronAPI.moveWindow(dx, dy);
      }

      setDragOffset({ x: e.clientX, y: e.clientY });
    },
    [isDragging, dragOffset]
  );

  /** 结束拖动 */
  const handleDragEnd = useCallback(() => {
    setIsDragging(false);
    window.sphereOverlay?.setIgnoreMouseEvents?.(true, true);
  }, []);

  /** 切换展开/折叠 */
  const toggleCollapse = useCallback(() => {
    setCollapsed((prev) => !prev);
    // 通知 Electron 调整窗口大小
    if (window.electronAPI?.resizeWindow) {
      window.electronAPI.resizeWindow(!collapsed);
    }
  }, [collapsed]);

  const pendingCount = schedules.filter((s) => !s.completed).length;
  const todayLabel = formatTodayLabel();

  return (
    <div
      className={`schedule-float${collapsed ? " schedule-float--collapsed" : ""}`}
      onPointerDown={handleDragStart}
      onPointerMove={handleDragMove}
      onPointerUp={handleDragEnd}
      onPointerCancel={handleDragEnd}
      style={{ cursor: isDragging ? "grabbing" : "grab" }}
    >
      {/* 标题栏 — 可拖动区域 */}
      <div className="schedule-float__header">
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
            title={collapsed ? "展开" : "折叠"}
          >
            {collapsed ? "▼" : "▲"}
          </button>
        </div>
      </div>

      {/* 内容区域 */}
      {!collapsed && (
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
      )}

      {/* 底部提示 */}
      {!collapsed && schedules.length > 0 && (
        <div className="schedule-float__footer">
          共 {schedules.length} 项 · {pendingCount} 待执行
        </div>
      )}
    </div>
  );
}

/** 全局类型声明 */
declare global {
  interface Window {
    sphereOverlay?: {
      setIgnoreMouseEvents?: (ignore: boolean, forward: boolean) => void;
      onPatch?: (callback: (patch: Record<string, unknown>) => void) => void;
      onRoam?: (callback: () => void) => void;
      setMenuExpanded?: (expanded: boolean) => void;
    };
    electronAPI?: {
      moveWindow: (dx: number, dy: number) => void;
      resizeWindow: (collapsed: boolean) => void;
    };
  }
}
