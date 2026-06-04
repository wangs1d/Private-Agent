import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";

type ScheduleTab = "calendar" | "manage";

interface ScheduleItem {
  id: string;
  title: string;
  time: string;
  description?: string;
}

interface ScheduleSidebarProps {
  open: boolean;
  onClose: () => void;
}

export function ScheduleSidebar({ open, onClose }: ScheduleSidebarProps) {
  const [activeTab, setActiveTab] = useState<ScheduleTab>("calendar");
  const [currentDate, setCurrentDate] = useState(new Date());
  const [schedules] = useState<ScheduleItem[]>([]);

  const formatDate = useCallback((date: Date) => {
    return date.toLocaleDateString("zh-CN", {
      year: "numeric",
      month: "long",
      day: "numeric",
    });
  }, []);

  const navigateDate = useCallback((direction: "prev" | "next") => {
    setCurrentDate((prev) => {
      const next = new Date(prev);
      next.setDate(next.getDate() + (direction === "next" ? 1 : -1));
      return next;
    });
  }, []);

  const goToToday = useCallback(() => {
    setCurrentDate(new Date());
  }, []);

  useEffect(() => {
    if (!open) return;
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleEsc);
    return () => window.removeEventListener("keydown", handleEsc);
  }, [open, onClose]);

  if (!open) return null;

  return createPortal(
    <div className="schedule-backdrop" onClick={onClose}>
      <div
        className="schedule-sidebar"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="日程管理"
      >
        <div className="schedule-sidebar__header">
          <span className="schedule-sidebar__title">日程</span>
          <button
            type="button"
            className="schedule-sidebar__close"
            onClick={onClose}
            aria-label="关闭"
          >
            ×
          </button>
        </div>

        <div className="schedule-sidebar__tabs">
          <button
            type="button"
            className={`schedule-sidebar__tab${activeTab === "calendar" ? " is-active" : ""}`}
            onClick={() => setActiveTab("calendar")}
          >
            日历
          </button>
          <button
            type="button"
            className={`schedule-sidebar__tab${activeTab === "manage" ? " is-active" : ""}`}
            onClick={() => setActiveTab("manage")}
          >
            日程管理
          </button>
        </div>

        <div className="schedule-sidebar__date-nav">
          <button
            type="button"
            className="schedule-sidebar__date-btn"
            onClick={() => navigateDate("prev")}
            aria-label="上一天"
          >
            ‹
          </button>
          <span className="schedule-sidebar__date-text">{formatDate(currentDate)}</span>
          <button
            type="button"
            className="schedule-sidebar__date-btn"
            onClick={() => navigateDate("next")}
            aria-label="下一天"
          >
            ›
          </button>
          <button
            type="button"
            className="schedule-sidebar__today-btn"
            onClick={goToToday}
            aria-label="回到今天"
          >
            ↻
          </button>
        </div>

        <div className="schedule-sidebar__content">
          {schedules.length === 0 ? (
            <div className="schedule-sidebar__empty">
              <p>当天暂无日程</p>
            </div>
          ) : (
            <div className="schedule-sidebar__list">
              {schedules.map((item) => (
                <div key={item.id} className="schedule-sidebar__item">
                  <div className="schedule-sidebar__item-time">{item.time}</div>
                  <div className="schedule-sidebar__item-body">
                    <div className="schedule-sidebar__item-title">{item.title}</div>
                    {item.description && (
                      <div className="schedule-sidebar__item-desc">{item.description}</div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
