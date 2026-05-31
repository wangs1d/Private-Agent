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
import {
  parseContentSummaryV2,
  renderContentSummaryCardV2,
  storeDetailContent,
  storeSections
} from "./content-summary-card.js";

const SESSION_KEY = "pai_web_session_id";
const FULL_ACCESS_KEY = "pai_web_full_access";
const DAILY_CHAT_PREFIX = "pai_daily_chat_";
const messagesEl = document.getElementById("messages");
const inputEl = document.getElementById("input");
const sendBtn = document.getElementById("send");
const fullAccessBtn = document.getElementById("full-access");
const statusEl = document.getElementById("status");

let fullComputerAccessEnabled = localStorage.getItem(FULL_ACCESS_KEY) === "1";

function getTodayKey() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

class DailyChatStorage {
  constructor() {
    this.currentDay = getTodayKey();
    this.messages = [];
    this.loadTodayMessages();
    this.startDayChangeDetector();
  }

  getStorageKey(day) {
    return `${DAILY_CHAT_PREFIX}${day || this.currentDay}`;
  }

  loadTodayMessages() {
    try {
      const raw = localStorage.getItem(this.getStorageKey());
      if (raw) {
        this.messages = JSON.parse(raw);
        this.restoreMessagesToUI();
      }
    } catch (e) {
      console.error("[DailyChatStorage] Load failed:", e);
      this.messages = [];
    }
  }

  saveMessage(role, text, messageId, timestamp = new Date().toISOString()) {
    const msg = {
      role,
      text,
      messageId,
      timestamp,
      day: this.currentDay
    };
    this.messages.push(msg);
    this.persist();
  }

  persist() {
    try {
      localStorage.setItem(this.getStorageKey(), JSON.stringify(this.messages));
    } catch (e) {
      if (e.name === 'QuotaExceededError') {
        console.warn("[DailyChatStorage] Storage full, keeping only last 200 messages");
        this.messages = this.messages.slice(-200);
        localStorage.setItem(this.getStorageKey(), JSON.stringify(this.messages));
      } else {
        console.error("[DailyChatStorage] Save failed:", e);
      }
    }
  }

  restoreMessagesToUI() {
    if (!messagesEl) return;
    
    const todayMsgs = this.messages.filter(m => m.day === this.currentDay);
    
    for (const msg of todayMsgs) {
      if (msg.role === 'user') {
        appendBubble('user', escapeHtml(msg.text), msg.messageId);
      } else if (msg.role === 'assistant') {
        const row = ensureAssistant(msg.messageId);
        row.text = msg.text;
        paintAssistant(msg.messageId);
      } else if (msg.role === 'system') {
        appendBubble('system', escapeHtml(msg.text), msg.messageId);
      }
    }
    
    if (todayMsgs.length > 0) {
      setTimeout(() => {
        messagesEl.scrollTop = messagesEl.scrollHeight;
      }, 100);
    }
  }

  clearCurrentDay() {
    this.messages = [];
    localStorage.removeItem(this.getStorageKey());
  }

  startDayChangeDetector() {
    setInterval(() => {
      const newDay = getTodayKey();
      if (newDay !== this.currentDay) {
        console.log(`[DailyChatStorage] Day changed: ${this.currentDay} -> ${newDay}`);
        this.currentDay = newDay;
        this.messages = [];
        this.loadTodayMessages();
        
        if (typeof window.onDayChange === 'function') {
          window.onDayChange(this.currentDay);
        }
      }
    }, 60_000);
  }

  getTodayStats() {
    const todayMsgs = this.messages.filter(m => m.day === this.currentDay);
    const userCount = todayMsgs.filter(m => m.role === 'user').length;
    const assistantCount = todayMsgs.filter(m => m.role === 'assistant').length;
    return { total: todayMsgs.length, userCount, assistantCount };
  }

  async syncToServer() {
    if (!this.messages || this.messages.length === 0) return;

    const todayMsgs = this.messages.filter(m => m.day === this.currentDay);
    
    if (todayMsgs.length === 0) return;

    const syncData = {
      actorId: sessionId(),
      day: this.currentDay,
      messages: todayMsgs.map(m => ({
        role: m.role,
        text: m.text,
        messageId: m.messageId,
        timestamp: m.timestamp
      })),
      clientTimestamp: new Date().toISOString()
    };

    try {
      const response = await fetch('/api/chat/sync', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(syncData)
      });

      if (response.ok) {
        const result = await response.json();
        console.log(`[DailyChatSync] ✅ Synced ${result.messageCount} messages to server`);
        
        localStorage.setItem(`pai_last_sync_${this.currentDay}`, JSON.stringify({
          syncedAt: new Date().toISOString(),
          messageCount: result.messageCount
        }));
      } else {
        console.error('[DailyChatSync] ❌ Sync failed:', response.status);
      }
    } catch (err) {
      console.error('[DailyChatSync] ❌ Sync error:', err);
    }
  }

  startAutoSync(intervalMs = 5 * 60 * 1000) {
    setInterval(() => {
      this.syncToServer();
    }, intervalMs);

    window.addEventListener('beforeunload', () => {
      if (navigator.sendBeacon) {
        const blob = new Blob([JSON.stringify({
          actorId: sessionId(),
          day: this.currentDay,
          messages: this.messages.filter(m => m.day === this.currentDay),
          clientTimestamp: new Date().toISOString()
        })], { type: 'application/json' });
        navigator.sendBeacon('/api/chat/sync', blob);
      }
    });

    setTimeout(() => this.syncToServer(), 10_000);
  }
}

const dailyChatStorage = new DailyChatStorage();

function agentAccessMode() {
  return fullComputerAccessEnabled ? "full" : "sandbox";
}

function paintFullAccessButton() {
  if (!fullAccessBtn) return;
  fullAccessBtn.textContent = fullComputerAccessEnabled ? "🔓" : "🛡️";
  fullAccessBtn.title = fullComputerAccessEnabled
    ? "完全访问：已开启（可控制电脑等高权限操作）"
    : "沙箱模式：点击开启完全访问";
  fullAccessBtn.setAttribute("aria-pressed", fullComputerAccessEnabled ? "true" : "false");
  fullAccessBtn.classList.toggle("full-access-on", fullComputerAccessEnabled);
}

paintFullAccessButton();
fullAccessBtn?.addEventListener("click", () => {
  fullComputerAccessEnabled = !fullComputerAccessEnabled;
  localStorage.setItem(FULL_ACCESS_KEY, fullComputerAccessEnabled ? "1" : "0");
  paintFullAccessButton();
  setStatus(
    fullComputerAccessEnabled
      ? "已开启完全访问：下一条消息将携带高权限工具"
      : "已切换为沙箱模式",
  );
});

/** @type {WebSocket | null} */
let ws = null;
/** 与聊天区「处理中」进度条同步，供服务端合并用户连发消息 */
let agentProcessingUiActive = false;
/** @type {Map<string, { el: HTMLElement, text: string, playUrl: string | null }>} */
const assistants = new Map();

/** @type {HTMLIFrameElement | null} */
let avatarFrame = null;
let avatarReady = false;
let avatarSpeakingEnergy = 0.45;

function getAvatarFrame() {
  if (!avatarFrame) avatarFrame = document.getElementById("agent-avatar-frame");
  return avatarFrame;
}

/** 进入页面即加载可拖动悬浮 3D Agent（与 Flutter WebView 同源 embed） */
function initAvatarFrame() {
  const frame = getAvatarFrame();
  const host = document.getElementById("agent-avatar-float");
  if (!frame || !host) return;
  const sid = sessionId();
  frame.src = `/chat/assets/avatar/embed.html?wsOff=1&sessionId=${encodeURIComponent(sid)}`;

  let dragging = false;
  let startX = 0;
  let startY = 0;
  let originLeft = 0;
  let originTop = 0;

  const onPointerDown = (ev) => {
    if (ev.button !== undefined && ev.button !== 0) return;
    // 左键拖动旋转；Shift/Alt + 拖动移动悬浮位置
    if (!ev.shiftKey && !ev.altKey) return;
    dragging = true;
    frame.style.pointerEvents = "none";
    host.classList.add("is-dragging");
    startX = ev.clientX;
    startY = ev.clientY;
    const rect = host.getBoundingClientRect();
    originLeft = rect.left;
    originTop = rect.top;
    host.style.left = `${originLeft}px`;
    host.style.top = `${originTop}px`;
    host.style.right = "auto";
    host.setPointerCapture?.(ev.pointerId);
    ev.preventDefault();
  };

  const onPointerMove = (ev) => {
    if (!dragging) return;
    ev.preventDefault();
    const dx = ev.clientX - startX;
    const dy = ev.clientY - startY;
    const w = host.offsetWidth;
    const h = host.offsetHeight;
    const maxLeft = Math.max(0, window.innerWidth - w);
    const maxTop = Math.max(0, window.innerHeight - h);
    const nextLeft = Math.min(maxLeft, Math.max(0, originLeft + dx));
    const nextTop = Math.min(maxTop, Math.max(0, originTop + dy));
    host.style.left = `${nextLeft}px`;
    host.style.top = `${nextTop}px`;
  };

  const endDrag = (ev) => {
    if (!dragging) return;
    dragging = false;
    frame.style.pointerEvents = "auto";
    host.classList.remove("is-dragging");
    host.releasePointerCapture?.(ev.pointerId);
  };

  host.addEventListener("pointerdown", onPointerDown);
  frame.addEventListener("pointerdown", onPointerDown);
  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", endDrag);
  window.addEventListener("pointercancel", endDrag);
}

/** 向嵌入的 3D Agent 形象同步状态（服务端 embodiment.patch 或聊天事件） */
function patchAvatar(patch) {
  const frame = getAvatarFrame();
  if (!frame?.contentWindow || !avatarReady) return;
  frame.contentWindow.postMessage({ type: "agent-sphere:patch", ...patch }, "*");
}

function applyEmbodimentPatch(p) {
  patchAvatar({
    mood: p.mood,
    energy: p.energy,
    caption: p.caption === null ? undefined : p.caption,
    phase: p.phase,
    subAgentType: p.subAgentType,
    subAgentDisplayName: p.subAgentDisplayName,
    source: p.source,
  });
  if (p.mood === "happy") {
    setTimeout(() => patchAvatar({ mood: "idle", energy: 0.5, caption: undefined }), 1800);
  }
}

window.addEventListener("message", (ev) => {
  if (ev.data?.type === "agent-sphere:ready") {
    avatarReady = true;
    patchAvatar({ mood: "idle", energy: 0.5 });
    return;
  }
  if (ev.data?.type === "agent-sphere:touch") {
    const phase = ev.data.phase;
    const spin = ev.data.spinStrength ?? 0;
    if (phase === "start") {
      patchAvatar({ mood: "listening", energy: 0.62, focused: true, caption: "嗯？" });
      return;
    }
    if (phase === "end") {
      if (spin > 0.45) {
        patchAvatar({ mood: "happy", energy: 0.75, caption: "哈哈，别转了！" });
        forwardEmbodimentCommand({ action: "excite", strength: 0.85 + spin * 0.5 });
        setTimeout(() => patchAvatar({ mood: "idle", energy: 0.5, caption: undefined }), 1600);
      } else if ((ev.data.totalRotationDeg ?? 0) > 25) {
        patchAvatar({ mood: "alert", energy: 0.7, caption: "你在摸我？" });
        setTimeout(() => patchAvatar({ mood: "idle", energy: 0.5, caption: undefined }), 1200);
      }
    }
    return;
  }
  if (ev.data?.type === "agent-sphere:interact" && ev.data.action === "focus") {
    inputEl?.focus();
    inputEl?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    return;
  }
  if (ev.data?.type === "agent-sphere:boundary") {
    const host = document.getElementById("agent-avatar-float");
    if (host) {
      const edge = ev.data.edge;
      const rect = host.getBoundingClientRect();
      const w = host.offsetWidth;
      const h = host.offsetHeight;
      const maxLeft = Math.max(0, window.innerWidth - w);
      const maxTop = Math.max(0, window.innerHeight - h);
      let left = rect.left;
      let top = rect.top;
      const nudge = 52;
      if (edge === "left") left = Math.min(maxLeft, left + nudge);
      else if (edge === "right") left = Math.max(0, left - nudge);
      else if (edge === "top") top = Math.min(maxTop, top + nudge);
      else if (edge === "bottom") top = Math.max(0, top - nudge);
      else forwardEmbodimentCommand({ action: "window_roam" });
      if (edge === "left" || edge === "right" || edge === "top" || edge === "bottom") {
        host.style.left = `${left}px`;
        host.style.top = `${top}px`;
        host.style.right = "auto";
        patchAvatar({ mood: "alert", energy: 0.82, caption: "哎哟，撞到了！" });
        setTimeout(() => patchAvatar({ mood: "idle", energy: 0.5, caption: undefined }), 900);
      }
    }
    return;
  }
  if (ev.data?.type === "agent-sphere:command" && ev.data.action === "window_roam") {
    forwardEmbodimentCommand({ action: "window_roam" });
    return;
  }
  if (ev.data?.type === "agent-sphere:send" && ws?.readyState === WebSocket.OPEN) {
    const sid = sessionId();
    const action = ev.data.action;
    const text = ev.data.text;
    ws.send(
      JSON.stringify({
        type: "agent.embodiment.interact",
        payload: {
          sessionId: sid,
          userId: sid,
          action,
          ...(text ? { text } : {}),
        },
      }),
    );
    if (action === "wake" || action === "chat") {
      patchAvatar({ mood: "listening", caption: "正在聆听…", energy: 0.65 });
    }
  }
});

function forwardEmbodimentCommand(p) {
  const frame = getAvatarFrame();
  if (!frame?.contentWindow || !avatarReady) return;
  frame.contentWindow.postMessage(
    {
      type: "agent-sphere:command",
      action: p.action,
      x: p.x,
      y: p.y,
      z: p.z,
      strength: p.strength,
    },
    "*",
  );
}

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

function syncAgentProcessingUi(active) {
  if (agentProcessingUiActive === active) return;
  agentProcessingUiActive = active;
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const sid = sessionId();
  ws.send(
    JSON.stringify({
      type: "chat.agent_processing_ui",
      payload: { sessionId: sid, userId: sid, active },
    }),
  );
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
    const { summary, briefText, cleanedText } = parseContentSummaryV2(row.text);
    if (summary) {
      const cardHtml = renderContentSummaryCardV2(summary, briefText);
      
      if (summary.detailContent) {
        storeDetailContent(summary.id, summary.detailContent);
      }
      
      if (summary.sections) {
        storeSections(summary.id, summary.sections);
      }
      
      if (cleanedText && cleanedText.trim()) {
        row.el.innerHTML = cardHtml + `<div class="card-context-text" style="margin-top: 8px;">${escapeHtml(cleanedText)}</div>`;
      } else {
        row.el.innerHTML = cardHtml;
      }

      if (!window.__contentSummaries) {
        window.__contentSummaries = {};
      }
      window.__contentSummaries[summary.id] = summary;
    } else {
      row.el.innerHTML = escapeHtml(row.text);
    }
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
    syncAgentProcessingUi(false);
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

  if (type === "agent.embodiment.patch") {
    applyEmbodimentPatch(p);
    return;
  }

  if (type === "agent.embodiment.command") {
    forwardEmbodimentCommand(p);
    return;
  }

  if (type === "agent.phone.incoming") {
    showPhoneIncoming(p);
    patchAvatar({ mood: "alert", caption: "来电", energy: 0.9 });
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
      prog = appendBubble("progress", "", "progress");
      prog.id = "progress-bubble";
      prog._steps = [];
    }
    const steps = prog._steps || [];
    if (!steps.includes(line)) {
      steps.push(line);
      prog._steps = steps;
    }
    prog.innerHTML = steps
      .map((s, i) => {
        const isLast = i === steps.length - 1;
        const prefix = isLast ? '<span class="prog-active">▸</span>' : '<span class="prog-done">✓</span>';
        return `<div class="prog-step${isLast ? ' prog-step-current' : ''}">${prefix} ${escapeHtml(s)}</div>`;
      })
      .join("");
    messagesEl.scrollTop = messagesEl.scrollHeight;
    syncAgentProcessingUi(true);
    patchAvatar({ mood: "thinking", caption: line, energy: 0.72 });
    return;
  }

  if (type === "tool.call") {
    const line = String(p.userStatusLine ?? p.assistantPreamble ?? p.toolName ?? "").trim();
    if (line) {
      patchAvatar({ mood: "thinking", caption: line, energy: 0.68 });
    }
    return;
  }

  if (type === "chat.assistant_chunk") {
    const id = String(p.messageId ?? "assistant-chunk");
    const row = ensureAssistant(id);
    row.text += String(p.chunk ?? "");
    const detected = playUrlFromText(row.text);
    if (detected) row.playUrl = detected;
    paintAssistant(id);
    avatarSpeakingEnergy = Math.min(1, avatarSpeakingEnergy + 0.025);
    patchAvatar({ mood: "speaking", energy: avatarSpeakingEnergy });
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
    syncAgentProcessingUi(false);
    setStatus("已连接");
    avatarSpeakingEnergy = 0.45;
    patchAvatar({ mood: "happy", energy: 0.55 });
    setTimeout(() => patchAvatar({ mood: "idle", energy: 0.5, caption: undefined }), 1800);
    const id = String(p.messageId ?? "assistant-final");
    const row = ensureAssistant(id);
    const finalText = String(p.finalText ?? "").trim();
    if (finalText) row.text = finalText;
    if (!row.playUrl) row.playUrl = playUrlFromText(row.text);
    paintAssistant(id);
    dailyChatStorage.saveMessage('assistant', row.text, id);
    return;
  }

  if (type === "error.event") {
    document.getElementById("progress-bubble")?.remove();
    syncAgentProcessingUi(false);
    setStatus(String(p.message ?? "错误"));
    patchAvatar({ mood: "alert", caption: String(p.message ?? "错误"), energy: 0.85 });
    return;
  }

  if (type === "schedule.reminder_fired") {
    const reminderMsg = String(p.message ?? p.title ?? "提醒").trim();
    patchAvatar({ mood: "alert", caption: reminderMsg, energy: 0.9 });
    return;
  }

  if (type === "schedule.agent_task_fired") {
    const title = String(p.title ?? "自动化任务").trim();
    patchAvatar({ mood: "thinking", caption: title, energy: 0.75, phase: "agent_task" });
    return;
  }

  if (type === "agent.peer_message") {
    const preview = String(p.preview ?? p.text ?? "新消息").slice(0, 40);
    patchAvatar({ mood: "alert", caption: preview, energy: 0.82 });
  }
}

function sendUserMessage() {
  const text = inputEl.value.trim();
  if (!text || !ws || ws.readyState !== WebSocket.OPEN) return;
  const sid = sessionId();
  const messageId = `msg-${Date.now().toString(36)}`;
  appendBubble("user", escapeHtml(text), messageId);
  dailyChatStorage.saveMessage('user', text, messageId);
  inputEl.value = "";
  ws.send(
    JSON.stringify({
      type: "chat.user_message",
      payload: {
        sessionId: sid,
        userId: sid,
        messageId,
        text,
        agentAccessMode: agentAccessMode(),
      },
    }),
  );
  setStatus("处理中…");
  syncAgentProcessingUi(true);
  patchAvatar({ mood: "listening", caption: "正在聆听…", energy: 0.65 });
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
  dailyChatStorage.saveMessage('user', text, messageId);
  ws.send(
    JSON.stringify({
      type: "chat.user_message",
      payload: {
        sessionId: sid,
        userId: sid,
        messageId,
        text,
        agentAccessMode: agentAccessMode(),
      },
    }),
  );
  setStatus("思考中…");
  syncAgentProcessingUi(true);
}

function showPhoneDialer() {
  const existing = document.getElementById("phone-dialer");
  if (existing) { existing.remove(); return; }

  const dialer = document.createElement("div");
  dialer.className = "phone-dialer";
  dialer.id = "phone-dialer";
  dialer.innerHTML = `
    <div class="dialer-header">
      <h4>📞 网络电话</h4>
      <button class="dialer-close" id="dialer-close">×</button>
    </div>
    <div class="dialer-body">
      <button class="dialer-call-my-agent-btn" id="dialer-call-my-agent">📞 呼叫我的 Agent</button>
      <div class="dialer-divider"><span>或拨打指定 Agent</span></div>
      <label>Agent ID</label>
      <input type="text" id="dialer-agent-id" placeholder="输入目标 Agent ID" />
      <label>留言（可选）</label>
      <textarea id="dialer-message" placeholder="想对 Agent 说的话…" rows="2"></textarea>
      <button class="dialer-call-btn" id="dialer-call">拨打电话</button>
    </div>
  `;
  document.body.appendChild(dialer);

  dialer.querySelector("#dialer-close").addEventListener("click", () => dialer.remove());

  dialer.querySelector("#dialer-call-my-agent").addEventListener("click", () => {
    if (!ws || ws.readyState !== WebSocket.OPEN) { alert("未连接到服务器"); return; }
    const msg = document.getElementById("dialer-message")?.value.trim();
    ws.send(JSON.stringify({
      type: "phone.call_my_agent",
      payload: { userMessage: msg || undefined },
    }));
    dialer.remove();
    appendBubble("system", "📞 正在呼叫你的 Agent…", "phone-status");
  });

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
const sendBtn = document.getElementById("send");
document.querySelector(".composer").insertBefore(phoneBtn, sendBtn);
phoneBtn.addEventListener("click", showPhoneDialer);

initAvatarFrame();
connect();
dailyChatStorage.startAutoSync();
