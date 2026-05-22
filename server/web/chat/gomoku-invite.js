/**
 * 五子棋邀请卡片（网页聊天 / App 逻辑对齐）：灰色样式，不重复展示 playUrl 正文。
 */

const GOMOKU_PLAY_URL_RE =
  /https?:\/\/[^\s<>"\]]+(?:\/play\/gomoku\/|#\/gomoku\/)[^\s<>"\]]+/i;
const GOMOKU_TABLE_ID_RE = /gomoku_[a-f0-9]+/i;

export function playUrlFromToolResult(result) {
  if (!result || typeof result !== "object") return null;
  const raw = result.playUrl ?? result.watchUrl;
  if (typeof raw !== "string") return null;
  const url = raw.trim();
  return url || null;
}

export function playUrlFromText(text) {
  const t = String(text ?? "").trim();
  if (!t) return null;
  const m = GOMOKU_PLAY_URL_RE.exec(t);
  if (m) return m[0];
  if (GOMOKU_TABLE_ID_RE.test(t) && t.startsWith("gomoku_") && !t.includes("/")) return t;
  return null;
}

export function displayTextForGomoku(text, playUrl) {
  const trimmed = String(text ?? "").trim();
  if (!playUrl) return trimmed;
  let cleaned = trimmed
    .replace(GOMOKU_PLAY_URL_RE, "")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/\s{2,}/g, " ")
    .replace(/[：:]\s*$/, "")
    .trim();
  if (
    !cleaned ||
    cleaned.includes("playUrl") ||
    cleaned.includes("发给用户") ||
    cleaned.includes("Flutter") ||
    cleaned.includes("App 内")
  ) {
    return "棋局已开好，你执白棋（后手）。点击下方按钮进入对局。";
  }
  return cleaned;
}

/**
 * @param {{ text?: string, playUrl: string, onOpen?: (url: string) => void }} opts
 */
export function renderGomokuInviteHtml(opts) {
  const playUrl = String(opts.playUrl ?? "").trim();
  const body = displayTextForGomoku(opts.text ?? "", playUrl);
  const bodyHtml = body
    ? `<p class="gomoku-invite__body">${escapeHtml(body)}</p>`
    : "";
  return `
    <div class="gomoku-invite" data-play-url="${escapeAttr(playUrl)}">
      <p class="gomoku-invite__head">▦ 五子棋对局</p>
      ${bodyHtml}
      <button type="button" class="gomoku-invite__btn" data-gomoku-open>
        🎮 进入对局
      </button>
    </div>`;
}

export function bindGomokuInviteButtons(root, onOpen) {
  root.querySelectorAll("[data-gomoku-open]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const card = btn.closest(".gomoku-invite");
      const url = card?.getAttribute("data-play-url") ?? "";
      if (!url) return;
      if (typeof onOpen === "function") onOpen(url);
      else window.open(url, "_blank", "noopener");
    });
  });
}

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeAttr(s) {
  return escapeHtml(s).replace(/'/g, "&#39;");
}
