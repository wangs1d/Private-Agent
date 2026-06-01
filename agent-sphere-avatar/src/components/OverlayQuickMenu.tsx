import { OVERLAY_QUICK_COMMANDS, type QuickCommand } from "../constants/quick-commands";

interface OverlayQuickMenuProps {
  open: boolean;
  connected: boolean;
  reconnecting?: boolean;
  voiceListening?: boolean;
  voiceInterim?: string;
  onSelect: (cmd: QuickCommand) => void;
  onClose: () => void;
}

/** 点击玻璃屏后弹出的快捷指令菜单 */
export function OverlayQuickMenu({
  open,
  connected,
  reconnecting = false,
  voiceListening = false,
  voiceInterim,
  onSelect,
  onClose,
}: OverlayQuickMenuProps) {
  if (!open) return null;

  return (
    <div className="overlay-menu-backdrop" onClick={onClose}>
      <div
        className="overlay-quick-menu"
        onClick={(e) => e.stopPropagation()}
        role="menu"
        aria-label="Agent 快捷指令"
      >
        <div className="overlay-quick-menu__header">
          <span>Agent 指令</span>
          <button type="button" className="overlay-quick-menu__close" onClick={onClose} aria-label="关闭">
            ×
          </button>
        </div>

        {voiceListening ? (
          <div className="overlay-quick-menu__voice">
            <span className="overlay-quick-menu__voice-pulse" />
            {voiceInterim ? `「${voiceInterim}」` : "正在聆听…"}
          </div>
        ) : null}

        <div className="overlay-quick-menu__grid">
          {OVERLAY_QUICK_COMMANDS.map((cmd) => (
            <button
              key={cmd.id}
              type="button"
              className={`overlay-quick-menu__item${!connected && cmd.action !== "roam" && cmd.action !== "voice" ? " is-disabled" : ""}`}
              disabled={!connected && cmd.action !== "roam" && cmd.action !== "voice"}
              onClick={() => onSelect(cmd)}
            >
              <span className="overlay-quick-menu__icon">{cmd.icon}</span>
              <span className="overlay-quick-menu__label">{cmd.label}</span>
            </button>
          ))}
        </div>

        {reconnecting ? (
          <p className="overlay-quick-menu__hint">正在重连主 Agent…</p>
        ) : !connected ? (
          <p className="overlay-quick-menu__hint">未连接主 Agent，部分指令不可用</p>
        ) : null}
      </div>
    </div>
  );
}
