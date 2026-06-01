/**
 * 用户与 Agent 五子棋对战页（独立于 Agent World 观战 SPA）。
 * Agent 在对话中开桌后发送 /play/gomoku/{tableId} 链接；用户打开即可执白加入。
 */

const SESSION_KEY = "gomoku_user_session_id";

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatTime(iso) {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    const h = String(d.getHours()).padStart(2, "0");
    const m = String(d.getMinutes()).padStart(2, "0");
    const s = String(d.getSeconds()).padStart(2, "0");
    return `${h}:${m}:${s}`;
  } catch {
    return "";
  }
}

function getSessionId() {
  let id = localStorage.getItem(SESSION_KEY);
  if (!id) {
    id = `user-${crypto.randomUUID?.() ?? Date.now()}`;
    localStorage.setItem(SESSION_KEY, id);
  }
  return id.trim();
}

function parseTableIdFromPath() {
  const parts = window.location.pathname.split("/").filter(Boolean);
  // /play/gomoku/{tableId}
  if (parts[0] === "play" && parts[1] === "gomoku" && parts[2]) {
    return decodeURIComponent(parts[2]);
  }
  return null;
}

async function apiGet(path) {
  const r = await fetch(path, { headers: { Accept: "application/json" } });
  const j = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, json: j };
}

async function apiPost(path, body) {
  const r = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, json: j };
}

function wsHref() {
  const u = new URL("/ws", window.location.href);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  return u.href;
}

let ws = null;
let wsReady = false;
const wsListeners = new Set();

function wsSend(type, payload = {}) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  ws.send(JSON.stringify({ type, payload: { sessionId: getSessionId(), ...payload } }));
  return true;
}

function ensureWebSocket() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  ws = new WebSocket(wsHref());
  ws.addEventListener("open", () => {
    wsReady = true;
    ws.send(
      JSON.stringify({
        type: "session.init",
        payload: { sessionId: getSessionId(), userId: getSessionId() },
      }),
    );
  });
  ws.addEventListener("message", (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      for (const fn of wsListeners) fn(msg);
    } catch {
      /* ignore */
    }
  });
  ws.addEventListener("close", () => {
    wsReady = false;
    setTimeout(ensureWebSocket, 2000);
  });
}

function subscribeWs(fn) {
  wsListeners.add(fn);
  return () => wsListeners.delete(fn);
}

function renderBoard(board, snap) {
  if (!board || !Array.isArray(board)) {
    return '<div class="loading">等待棋盘…</div>';
  }
  const symbols = { 0: "·", 1: "●", 2: "○" };
  const classes = { 0: "empty", 1: "black", 2: "white" };
  let html = '<div class="board"><div class="board-col-head">';
  for (let c = 0; c < 15; c++) {
    html += `<span>${c}</span>`;
  }
  html += "</div>";
  for (let r = 0; r < 15; r++) {
    html += `<div class="board-row"><span class="board-coord">${r}</span>`;
    for (let c = 0; c < 15; c++) {
      const cell = board[r][c];
      const clickable =
        snap?.role === snap?.currentPlayer &&
        cell === 0 &&
        snap?.status === "playing";
      html += `<span class="cell ${classes[cell] ?? "empty"}${clickable ? " clickable" : ""}" data-row="${r}" data-col="${c}">${symbols[cell] ?? "·"}</span>`;
    }
    html += "</div>";
  }
  html += "</div></div>";
  return html;
}

function roleLabel(role) {
  if (role === "black") return "黑棋（先手）";
  if (role === "white") return "白棋（后手）";
  if (role === "spectator") return "观战";
  return "访客";
}

async function main() {
  const root = document.getElementById("root");
  const tableId = parseTableIdFromPath();
  const sid = getSessionId();

  if (!tableId || !/^gomoku_[a-f0-9]+$/i.test(tableId)) {
    root.innerHTML = `
      <div class="alert error">
        无效的对局链接。请在 Agent 对话中说「陪我下一盘五子棋」，使用 Agent 发来的完整链接进入。
      </div>`;
    return;
  }

  let snap = null;
  const banterLines = [];

  function mergeBanterFromSnapshot(s) {
    const list = s?.banter;
    if (!Array.isArray(list)) return;
    const seen = new Set(banterLines.map((b) => b.id));
    for (const line of list) {
      if (!line?.id || seen.has(line.id)) continue;
      seen.add(line.id);
      banterLines.push(line);
    }
  }

  function appendBanterLine(line) {
    if (!line?.id || banterLines.some((b) => b.id === line.id)) return;
    banterLines.push(line);
  }

  function latestBanterText() {
    if (banterLines.length === 0) return "";
    return String(banterLines[banterLines.length - 1]?.text ?? "").trim();
  }

  function statusHint(status, role, current) {
    if (status === "waiting" && (role === "black" || role === "white")) {
      return "已加入，等待开局…";
    }
    if (status === "playing" && (role === "black" || role === "white")) {
      if (role === current) return "轮到你啦，点击棋盘落子";
      return "Agent 思考中…";
    }
    return "";
  }

  function resultLine(winner, role) {
    if (!winner) return "";
    if (role === winner) return "你赢了！";
    if (role === "black" || role === "white") return "Agent 获胜";
    return "";
  }

  const paint = () => {
    if (!snap) {
      root.innerHTML = '<div class="loading">连接对局…</div>';
      return;
    }
    const status = String(snap.status || "—");
    const role = String(snap.role || "guest");
    const current = snap.currentPlayer ? String(snap.currentPlayer) : "";
    const winner = snap.winner ? String(snap.winner) : "";
    const humanColor = String(snap.humanColor || role);
    const agentColor = String(snap.agentColor || (humanColor === "black" ? "white" : "black"));
    const hint = statusHint(status, role, current);
    const result = resultLine(winner, role);
    const stone = (c) => (c === "black" ? "黑 ●" : "白 ○");
    const caption = `你执${stone(humanColor)} · Agent 执${stone(agentColor)}`;

    root.innerHTML = `
      <div class="game-layout">
        <div class="game-left">
          ${hint ? `<p class="status-hint">${escapeHtml(hint)}</p>` : ""}
          ${result ? `<p class="status-result">${escapeHtml(result)}</p>` : ""}
          <div class="board-wrap">${renderBoard(snap.board, snap)}</div>
          <p class="board-caption">${escapeHtml(caption)}</p>
          <button type="button" class="btn" id="leave-btn">离开对局</button>
        </div>
      </div>
    `;

    if (status === "playing" && (role === "black" || role === "white")) {
      root.querySelectorAll(".cell.clickable").forEach((cell) => {
        cell.addEventListener("click", async () => {
          const row = Number(cell.dataset.row);
          const col = Number(cell.dataset.col);
          const r = await apiPost("/world/gomoku/play", {
            sessionId: sid,
            tableId,
            row,
            col,
          });
          if (r.ok && r.json?.ok) {
            snap = r.json.snapshot;
            mergeBanterFromSnapshot(snap);
            paint();
          } else {
            alert("落子失败：" + (r.json?.reason || "未知错误"));
          }
        });
      });
    }

    document.getElementById("leave-btn")?.addEventListener("click", async () => {
      await apiPost("/world/gomoku/leave", { sessionId: sid, tableId });
      root.innerHTML =
        '<div class="alert">已离开对局。可关闭页面或返回 Agent 对话。</div>';
    });
  };

  async function loadSnapshot() {
    const r = await apiGet(
      `/world/gomoku/table/${encodeURIComponent(tableId)}?sessionId=${encodeURIComponent(sid)}`,
    );
    if (!r.ok || !r.json?.ok) {
      root.innerHTML = `<div class="alert error">无法加载对局（${escapeHtml(r.json?.reason || r.status)}）</div>`;
      return false;
    }
    snap = r.json.snapshot;
    mergeBanterFromSnapshot(snap);
    if (snap?.role === "guest" && snap?.status === "waiting") {
      const join = await apiPost("/world/gomoku/join", {
        sessionId: sid,
        tableId,
        role: "player",
      });
      if (!join.ok || !join.json?.ok) {
        root.innerHTML = `<div class="alert error">加入对局失败：${escapeHtml(join.json?.reason || "请确认 Agent 已开桌")}</div>`;
        return false;
      }
      const again = await apiGet(
        `/world/gomoku/table/${encodeURIComponent(tableId)}?sessionId=${encodeURIComponent(sid)}`,
      );
      if (again.ok && again.json?.ok) {
        snap = again.json.snapshot;
        mergeBanterFromSnapshot(snap);
      }
    }
    mergeBanterFromSnapshot(snap);
    paint();
    return true;
  }

  ensureWebSocket();
  subscribeWs((msg) => {
    if (msg.type === "world.gomoku.banter" && msg.payload?.tableId === tableId && msg.payload.line) {
      appendBanterLine(msg.payload.line);
      paint();
      return;
    }
    if (msg.type === "world.gomoku.snapshot" && msg.payload?.tableId === tableId && msg.payload.snapshot) {
      snap = msg.payload.snapshot;
      mergeBanterFromSnapshot(snap);
      paint();
    }
  });

  const ok = await loadSnapshot();
  if (ok) {
    setTimeout(() => wsSend("world.gomoku.subscribe", { tableId }), 400);
  }
}

main().catch(() => {
  document.getElementById("root").innerHTML =
    '<div class="alert error">页面加载失败，请刷新重试。</div>';
});
