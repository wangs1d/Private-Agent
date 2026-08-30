import { useEffect, useRef } from "react";

export interface Message {
  id: string;
  role: "user" | "agent";
  content: string;
  timestamp: Date;
}

interface MessageListProps {
  messages: Message[];
}

export function MessageList({ messages }: MessageListProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const prevCountRef = useRef(0);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !bottomRef.current) return;
    const count = messages.length;
    const isNewMessage = count > prevCountRef.current;
    prevCountRef.current = count;

    if (isNewMessage) {
      // 新增了一条消息：即时贴底（不做平滑滚动，避免与流式即时跟随冲突导致画面抖动）
      container.scrollTop = container.scrollHeight;
    } else if (container.scrollHeight - container.scrollTop - container.clientHeight < 8) {
      // 流式追加内容：已贴底时瞬时跟随，避免每次 chunk 平滑滚动导致最新文字持续"动"
      container.scrollTop = container.scrollHeight;
    }
  }, [messages]);

  if (messages.length === 0) return null;

  return (
    <div className="message-list" ref={containerRef}>
      <div className="message-list__inner">
        {messages.map((msg) => (
          <div key={msg.id} className={`message message--${msg.role}`}>
            <div className="message__avatar">
              {msg.role === "user" ? "👤" : "🤖"}
            </div>
            <div className="message__body">
              <div className="message__content">{msg.content}</div>
              <div className="message__time">
                {msg.timestamp.toLocaleTimeString("zh-CN", {
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </div>
            </div>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
