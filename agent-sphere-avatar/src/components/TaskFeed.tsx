import { useEffect, useRef, useState } from "react";
import type { TaskEvent, TaskEventType } from "../types/agent";

const TYPE_ICON: Record<TaskEventType, string> = {
  progress: "⟳",
  success: "✓",
  warning: "⚠",
  error: "✗",
  info: "ℹ",
};

const TYPE_LABEL: Record<TaskEventType, string> = {
  progress: "进行中",
  success: "完成",
  warning: "警告",
  error: "错误",
  info: "信息",
};

const MAX_FEED_ITEMS = 12;
const AUTO_COLLAPSE_MS = 8000;

/** 过滤掉乱码/无意义的垃圾事件 */
function isGarbageEvent(title: string): boolean {
  if (!title || title.trim().length === 0) return true;
  const trimmed = title.trim();
  // 检测乱码特征：连续不可读字符、纯符号、过短无意义文本
  if (/^[\x00-\x08\x0B\x0C\x0E-\x1F]+$/.test(trimmed)) return true;
  if (/^[^\u4e00-\u9fa5a-zA-Z0-9\s\u3000-\u303f\uff00-\uffef]{3,}$/.test(trimmed)) return true;
  // 检测 "X无法件" 类乱码模式
  if (/^[A-Z]无法/.test(trimmed)) return true;
  if (/pretaction|无法件|unknow/i.test(trimmed)) return true;
  return false;
}

interface TaskFeedProps {
  events: TaskEvent[];
}

export function TaskFeed({ events }: TaskFeedProps) {
  const [expanded, setExpanded] = useState(false);
  const collapseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 过滤掉垃圾事件
  const cleanEvents = events.filter((ev) => !isGarbageEvent(ev.title));
  const visibleEvents = cleanEvents.slice(-MAX_FEED_ITEMS);
  const hasEvents = visibleEvents.length > 0;
  const lastEvent = visibleEvents[visibleEvents.length - 1];

  useEffect(() => {
    if (!hasEvents) {
      setExpanded(false);
      return;
    }
    setExpanded(true);
    if (collapseTimerRef.current) clearTimeout(collapseTimerRef.current);
    collapseTimerRef.current = setTimeout(() => {
      setExpanded(false);
    }, AUTO_COLLAPSE_MS);
    return () => {
      if (collapseTimerRef.current) clearTimeout(collapseTimerRef.current);
    };
  }, [hasEvents, events.length]);

  if (!hasEvents) return null;

  return (
    <div
      className={`task-feed ${expanded ? "task-feed--expanded" : "task-feed--collapsed"}`}
      onMouseEnter={() => {
        if (collapseTimerRef.current) clearTimeout(collapseTimerRef.current);
        setExpanded(true);
      }}
      onMouseLeave={() => {
        if (collapseTimerRef.current) clearTimeout(collapseTimerRef.current);
        collapseTimerRef.current = setTimeout(() => setExpanded(false), AUTO_COLLAPSE_MS);
      }}
    >
      {!expanded && lastEvent ? (
        <div className={`task-feed__indicator task-feed__indicator--${lastEvent.type}`}>
          <span className="task-feed__indicator-icon">{TYPE_ICON[lastEvent.type]}</span>
          <span className="task-feed__indicator-text">{lastEvent.title}</span>
        </div>
      ) : null}

      {expanded ? (
        <div className="task-feed__panel">
          <div className="task-feed__header">
            <span className="task-feed__header-title">实时任务</span>
            <span className="task-feed__header-count">{visibleEvents.length}</span>
          </div>
          <div className="task-feed__list">
            {visibleEvents.map((ev) => (
              <div key={ev.id} className={`task-feed__item task-feed__item--${ev.type}`}>
                <span className="task-feed__item-icon">{TYPE_ICON[ev.type]}</span>
                <div className="task-feed__item-body">
                  <div className="task-feed__item-title">{ev.title}</div>
                  {ev.detail ? (
                    <div className="task-feed__item-detail">{ev.detail}</div>
                  ) : null}
                  <div className="task-feed__item-meta">
                    <span className="task-feed__item-type">{TYPE_LABEL[ev.type]}</span>
                    <span className="task-feed__item-time">
                      {ev.timestamp.toLocaleTimeString("zh-CN", {
                        hour: "2-digit",
                        minute: "2-digit",
                        second: "2-digit",
                      })}
                    </span>
                  </div>
                </div>
                {ev.type === "progress" ? (
                  <span className="task-feed__item-spinner" />
                ) : null}
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
