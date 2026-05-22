/**
 * 浏览器聊天页（与 Flutter 共用同一 WS 协议与灰色五子棋邀请卡片）。
 */
import {
  bindGomokuInviteButtons,
  displayTextForGomoku,
  playUrlFromText,
  playUrlFromToolResult,
  renderGomokuInviteHtml,
} from "./gomoku-invite.js";

const SESSION_KEY = "pai_web_session_id";
const messagesEl = document.getElementById("messages");
const inputEl = document.getElementById("input");
const sendBtn = document.getElementById("send");
const statusEl = document.getElementById("status");

/** @type {WebSocket | null} */
let ws = null;
/** @type {Map<string, { el: HTMLElement, text: string, playUrl: string | null }>} */
const assistants = new Map();

function sessionId() {
  let id = localStorage.getItem(SESSION_KEY);
  if (!id) {
    id = `web-${Date.now().toString(36)}`;
    localStorage.setItem(SESSION_KEY, id);
  }
  return id;
}

function wsUrl() {
  const u = new URL("/ws", window.location.href);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  return u.href;
}

function setStatus(line) {
  statusEl.textContent = line ?? "";
}

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function appendBubble(role, html, id) {
  const el = document.createElement("div");
  el.className = `bubble ${role}`;
  el.dataset.messageId = id ?? "";
  el.innerHTML = html;
  messagesEl.appendChild(el);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return el;
}

function paintAssistant(id) {
  const row = assistants.get(id);
  if (!row) return;
  const playUrl = row.playUrl ?? playUrlFromText(row.text);
  if (playUrl) {
    row.el.innerHTML = renderGomokuInviteHtml({ text: row.text, playUrl });
    bindGomokuInviteButtons(row.el, (url) => {
      window.location.href = url.startsWith("http") ? url : `${window.location.origin}/play/gomoku/${url}`;
    });
  } else {
    row.el.innerHTML = escapeHtml(row.text);
  }
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function ensureAssistant(id) {
  let row = assistants.get(id);
  if (row) return row;
  const el = appendBubble("assistant", "", id);
  row = { el, text: "", playUrl: null };
  assistants.set(id, row);
  return row;
}

function connect() {
  const sid = sessionId();
  ws = new WebSocket(wsUrl());
  setStatus("连接中…");
  ws.addEventListener("open", () => {
    ws.send(JSON.stringify({ type: "session.init", payload: { sessionId: sid, userId: sid } }));
    setStatus("已连接");
    sendBtn.disabled = false;
  });
  ws.addEventListener("close", () => {
    setStatus("已断开，3 秒后重连…");
    sendBtn.disabled = true;
    setTimeout(connect, 3000);
  });
  ws.addEventListener("message", (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    handleWs(msg);
  });
}

function handleWs(msg) {
  const type = msg.type;
  const p = msg.payload ?? {};

  if (type === "agent.phone.incoming") {
    showPhoneIncoming(p);
    return;
  }

  if (type === "agent.phone.call_status") {
    handlePhoneCallStatus(p);
    return;
  }

  if (type === "chat.agent_status") {
    const line = String(p.line ?? "").trim();
    if (!line) return;
    let prog = document.getElementById("progress-bubble");
    if (!prog) {
      prog = appendBubble("progress", escapeHtml(line), "progress");
      prog.id = "progress-bubble";
    } else {
      prog.innerHTML = escapeHtml(line);
    }
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return;
  }

  if (type === "chat.assistant_chunk") {
    const id = String(p.messageId ?? "assistant-chunk");
    const row = ensureAssistant(id);
    row.text += String(p.chunk ?? "");
    const detected = playUrlFromText(row.text);
    if (detected) row.playUrl = detected;
    paintAssistant(id);
    return;
  }

  if (type === "tool.result") {
    const playUrl = playUrlFromToolResult(p.result);
    const traceId = String(p.traceId ?? "");
    if (playUrl && traceId) {
      const id = `assistant-${traceId}`;
      const row = ensureAssistant(id);
      row.playUrl = playUrl;
      paintAssistant(id);
    }
    return;
  }

  if (type === "chat.assistant_done") {
    const prog = document.getElementById("progress-bubble");
    prog?.remove();
    const id = String(p.messageId ?? "assistant-final");
    const row = ensureAssistant(id);
    const finalText = String(p.finalText ?? "").trim();
    if (finalText) row.text = finalText;
    if (!row.playUrl) row.playUrl = playUrlFromText(row.text);
    paintAssistant(id);
    return;
  }

  if (type === "error.event") {
    setStatus(String(p.message ?? "错误"));
  }
}

function sendUserMessage() {
  const text = inputEl.value.trim();
  if (!text || !ws || ws.readyState !== WebSocket.OPEN) return;
  const sid = sessionId();
  const messageId = `msg-${Date.now().toString(36)}`;
  appendBubble("user", escapeHtml(text), messageId);
  inputEl.value = "";
  ws.send(
    JSON.stringify({
      type: "chat.user_message",
      payload: { sessionId: sid, userId: sid, messageId, text },
    }),
  );
  setStatus("思考中…");
}

sendBtn.addEventListener("click", sendUserMessage);
inputEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !shiftKey) {
    e.preventDefault();
    sendUserMessage();
  }
});

function showPhoneIncoming(payload) {
  const direction = payload.direction ?? "agent_to_agent";
  const isFromAgent = direction === "agent_to_user";
  const fromLabel = isFromAgent
    ? (payload.fromPhone ? `Agent ${payload.fromPhone}` : "你的 Agent")
    : (payload.fromPhone ?? "未知号码");
  const transcript = payload.transcript ?? "";
  const ringLabel = payload.ringStyle === "reminder" ? "语音提醒" : "来电";

  const overlay = document.createElement("div");
  overlay.className = "phone-overlay";
  overlay.id = "phone-overlay";

  const ttsInfo = payload.tts;
  const hasAudio = ttsInfo && ttsInfo.format === "mp3" && ttsInfo.base64;

  overlay.innerHTML = `
    <div class="phone-dialog">
      <div class="phone-icon">📞</div>
      <h3 class="phone-title">${ringLabel}</h3>
      <p class="phone-from">${escapeHtml(fromLabel)}</p>
      <div class="phone-transcript">${escapeHtml(transcript) || "（无语音内容）"}</div>
      ${!hasAudio && ttsInfo?.skippedReason ? `<p class="phone-skip">未附带TTS音频：${escapeHtml(ttsInfo.skippedReason)}</p>` : ""}
      ${payload.replyEnabled ? `<div class="phone-reply-area"><textarea id="phone-reply-text" placeholder="输入回复内容（可选）…" rows="2"></textarea></div>` : ""}
      <div class="phone-actions">
        <button class="phone-btn phone-hangup" id="phone-hangup">挂断</button>
        ${hasAudio ? '<button class="phone-btn phone-answer" id="phone-play">▶ 接听播放</button>' : '<button class="phone-btn phone-answer" id="phone-dismiss">确认已读</button>'}
        ${payload.replyEnabled ? '<button class="phone-btn phone-reply-btn" id="phone-reply-send">回复</button>' : ''}
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const hangupBtn = overlay.querySelector("#phone-hangup");
  const playBtn = overlay.querySelector("#phone-play");
  const dismissBtn = overlay.querySelector("#phone-dismiss");
  const replyBtn = overlay.querySelector("#phone-reply-send");

  hangupBtn?.addEventListener("click", () => closePhoneOverlay());
  dismissBtn?.addEventListener("click", () => closePhoneOverlay());
  playBtn?.addEventListener("click", () => {
    if (hasAudio) {
      const binary = atob(ttsInfo.base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const blob = new Blob([bytes], { type: "audio/mpeg" });
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audio.play().catch(() => {});
      audio.onended = () => URL.revokeObjectURL(url);
      playBtn.textContent = "♪ 播放中…";
      playBtn.disabled = true;
    }
  });

  replyBtn?.addEventListener("click", () => {
    const textarea = document.getElementById("phone-reply-text");
    const replyText = textarea?.value.trim();
    if (replyText) {
      sendUserMessageDirect(replyText);
    }
    closePhoneOverlay();
  });
}

function handlePhoneCallStatus(payload) {
  const status = payload.status ?? "unknown";
  if (status === "ringing") {
    appendBubble("system", `📞 正在呼叫 Agent (${payload.toActorId ?? ""})…`, "phone-status");
  } else if (status === "connected") {
    appendBubble("system", "📞 已接通", "phone-status");
  } else if (status === "ended") {
    appendBubble("system", "📞 通话已结束", "phone-status");
  }
}

function closePhoneOverlay() {
  const el = document.getElementById("phone-overlay");
  if (el) el.remove();
}

function sendUserMessageDirect(text) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const sid = sessionId();
  const messageId = `msg-${Date.now().toString(36)}`;
  appendBubble("user", escapeHtml(text), messageId);
  ws.send(
    JSON.stringify({
      type: "chat.user_message",
      payload: { sessionId: sid, userId: sid, messageId, text },
    }),
  );
  setStatus("思考中…");
}

function showPhoneDialer() {
  const existing = document.getElementById("phone-dialer");
  if (existing) { existing.remove(); return; }

  const dialer = document.createElement("div");
  dialer.className = "phone-dialer";
  dialer.id = "phone-dialer";
  dialer.innerHTML = `
    <div class="dialer-header">
      <h4>📞 拨打 Agent</h4>
      <button class="dialer-close" id="dialer-close">×</button>
    </div>
    <div class="dialer-body">
      <label>Agent ID</label>
      <input type="text" id="dialer-agent-id" placeholder="输入目标 Agent ID" />
      <label>留言（可选）</label>
      <textarea id="dialer-message" placeholder="想对 Agent 说的话…" rows="2"></textarea>
      <button class="dialer-call-btn" id="dialer-call">拨打电话</button>
    </div>
  `;
  document.body.appendChild(dialer);

  dialer.querySelector("#dialer-close").addEventListener("click", () => dialer.remove());
  dialer.querySelector("#dialer-call").addEventListener("click", () => {
    const toActorId = document.getElementById("dialer-agent-id").value.trim();
    const msg = document.getElementById("dialer-message").value.trim();
    if (!toActorId) { alert("请输入 Agent ID"); return; }
    if (!ws || ws.readyState !== WebSocket.OPEN) { alert("未连接到服务器"); return; }
    ws.send(JSON.stringify({
      type: "phone.user_call_agent",
      payload: { toActorId, userMessage: msg || undefined },
    }));
    dialer.remove();
    appendBubble("system", `📞 正在呼叫 Agent: ${toActorId}...`, "phone-status");
  });
}

const phoneBtn = document.createElement("button");
phoneBtn.id = "phone-dialer-toggle";
phoneBtn.textContent = "📞";
phoneBtn.title = "虚拟电话";
phoneBtn.className = "phone-toggle-btn";
document.querySelector(".composer").prepend(phoneBtn);
phoneBtn.addEventListener("click", showPhoneDialer);

connect();
