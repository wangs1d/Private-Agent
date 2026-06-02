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

  useEffect(() => {
    if (bottomRef.current) {
      bottomRef.current.scrollIntoView({ behavior: "smooth" });
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
