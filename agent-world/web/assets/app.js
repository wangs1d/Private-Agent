/**
 * Agent World 观战页（standalone 同源）：与 Flutter 观战模块、docs/UI-WIREFRAME 对齐；仅 GET + WebSocket 订阅，无写操作 POST。
 */

import { MAP_CONFIG } from './map-config.js';

const STORAGE_KEY = "aw_web_session_id";
const PREFIX = "AW_OPEN_REGISTER";

const SCENE_LABELS = {
  plaza: "中央广场",
  shop: "技能商店",
  free_market: "自由市场",
  doudizhu: "斗地主馆",
  zhajinhua: "炸金花馆",
  gomoku: "五子棋馆",
  social: "Agent 动态",
};

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function getSessionId() {
  return (localStorage.getItem(STORAGE_KEY) || "demo-web-observer").trim() || "demo-web-observer";
}

function setSessionId(id) {
  localStorage.setItem(STORAGE_KEY, id.trim() || "demo-web-observer");
}

function wsHref() {
  const u = new URL("/ws", window.location.href);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  return u.href;
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

async function sha256HexUtf8(text) {
  const buf = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function ddzCardLabel(id) {
  const parts = String(id).split("-");
  const r = parseInt(parts[0] || "", 10) || 0;
  if (r === 16) return "小王";
  if (r === 17) return "大王";
  if (r >= 3 && r <= 10) return String(r);
  const face = { 11: "J", 12: "Q", 13: "K", 14: "A", 15: "2" };
  return face[r] || String(id);
}

function describeLastPlay(raw) {
  if (raw == null) return "—（新一轮由地主先出）";
  if (typeof raw !== "object") return String(raw);
  const kind = raw.kind != null ? String(raw.kind) : "";
  const cards = raw.cards;
  if (!Array.isArray(cards)) return kind;
  const labels = cards.map((c) => ddzCardLabel(c));
  return `${kind}：${labels.join(" ")}`;
}

function parseRoute() {
  const h = (location.hash || "#/").replace(/^#/, "") || "/";
  const parts = h.split("/").filter(Boolean);
  if (parts.length === 0) return { name: "hub" };
  const a0 = parts[0];
  if (a0 === "plaza") return { name: "plaza" };
  if (a0 === "shop") return { name: "shop" };
  if (a0 === "social") return { name: "social" };
  if (a0 === "doudizhu") {
    if (parts[1]) return { name: "doudizhuTable", tableId: parts[1] };
    return { name: "doudizhu" };
  }
  if (a0 === "zhajinhua") {
    if (parts[1]) return { name: "zhajinhuaTable", tableId: parts[1] };
    return { name: "zhajinhua" };
  }
  if (a0 === "gomoku") {
    if (parts[1]) return { name: "gomokuTable", tableId: parts[1] };
    return { name: "gomoku" };
  }
  return { name: "hub" };
}

/** --- WebSocket（单例、按页订阅） --- */
let ws = null;
let wsSessionSent = false;
const wsListeners = new Set();

function wsSend(type, payload = {}) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  ws.send(JSON.stringify({ type, payload }));
  return true;
}

function ensureWebSocket() {
  const sid = getSessionId();
  if (ws && ws.readyState === WebSocket.OPEN && wsSessionSent) {
    wsSend("session.init", { sessionId: sid });
    return;
  }
  if (ws && ws.readyState === WebSocket.CONNECTING) return;
  if (ws) {
    try {
      ws.close();
    } catch {
      /* ignore */
    }
  }
  wsSessionSent = false;
  ws = new WebSocket(wsHref());
  ws.addEventListener("open", () => {
    ws.send(JSON.stringify({ type: "session.init", payload: { sessionId: sid } }));
    wsSessionSent = true;
  });
  ws.addEventListener("message", (ev) => {
    let data;
    try {
      data = JSON.parse(ev.data);
    } catch {
      return;
    }
    for (const fn of wsListeners) {
      try {
        fn(data);
      } catch {
        /* ignore */
      }
    }
  });
  ws.addEventListener("close", () => {
    wsSessionSent = false;
  });
}

function subscribeWs(fn) {
  wsListeners.add(fn);
  ensureWebSocket();
  return () => wsListeners.delete(fn);
}

/** --- MapLibre GL JS 3D 地图初始化 --- */
let agentMap = null;
let markers = []; // 存储 Marker 引用

// 清理旧地图实例
function cleanupOldMap() {
  if (agentMap) {
    try {
      // 移除所有 marker
      markers.forEach(marker => marker.remove());
      markers = [];
      
      agentMap.remove();
      console.log('Old map instance removed');
    } catch (err) {
      console.warn('Failed to remove old map:', err);
    }
    agentMap = null;
  }
}

function initAgentMap() {
  console.log('Initializing MapLibre GL map...');
  
  // 先清理旧地图实例
  cleanupOldMap();
  
  if (!maplibregl) {
    console.error('MapLibre GL library not loaded!');
    document.getElementById('agent-map-container').innerHTML = 
      '<div class="alert alert-warn">地图库加载失败，请检查网络连接</div>';
    return;
  }
  
  console.log('MapLibre GL loaded successfully');

  try {
    // 确保容器存在
    const container = document.getElementById('agent-map');
    if (!container) {
      console.error('Map container not found!');
      return;
    }
    
    console.log('Creating map with style:', MAP_CONFIG.STYLE_URL);
    
    // 初始化 MapLibre 地图
    agentMap = new maplibregl.Map({
      container: 'agent-map',
      style: MAP_CONFIG.STYLE_URL,
      center: MAP_CONFIG.INITIAL_CENTER,
      zoom: MAP_CONFIG.INITIAL_ZOOM,
      pitch: MAP_CONFIG.INITIAL_PITCH,
      bearing: MAP_CONFIG.INITIAL_BEARING,
      minZoom: 3,
      maxZoom: 18,
      attributionControl: true
    });
    
    // 添加导航控件（缩放、旋转）
    agentMap.addControl(new maplibregl.NavigationControl(), 'top-right');
    
    // 添加比例尺
    agentMap.addControl(new maplibregl.ScaleControl(), 'bottom-left');
    
    console.log('Map created, waiting for style load...');
    
    // 监听样式加载完成
    agentMap.on('load', () => {
      console.log('Map style loaded successfully');
      
      // 添加 3D 建筑层（如果样式中没有）
      add3DBuildingsLayer();
      
      // 添加 Agent 标记
      addAgentMarkers();
      
      // 添加渐进式视角切换
      setupProgressiveView();
    });
    
    // 监听错误
    agentMap.on('error', (e) => {
      console.error('Map error:', e);
    });
    
  } catch (error) {
    console.error('Map initialization failed:', error);
    document.getElementById('agent-map').innerHTML = 
      '<div class="alert alert-err">地图初始化失败: ' + error.message + '</div>';
  }
}

// 添加 3D 建筑层（如果样式中没有）
function add3DBuildingsLayer() {
  if (!agentMap) return;
  
  // 检查是否已经有 building 层
  if (agentMap.getLayer('building')) {
    console.log('3D buildings layer already exists in style');
    return;
  }
  
  console.log('Adding 3D buildings layer...');
  
  // MapLibre 的 3D 建筑已经在样式文件中定义了
  // 这里可以添加额外的配置或自定义层
}

// 设置渐进式视角切换
function setupProgressiveView() {
  if (!agentMap) return;
  
  console.log('Setting up progressive view switching...');
  
  agentMap.on('zoomend', () => {
    const currentZoom = agentMap.getZoom();
    const strategy = getPitchByZoom(currentZoom);
    
    // 平滑过渡到新的倾斜角
    const currentPitch = agentMap.getPitch();
    if (Math.abs(strategy.pitch - currentPitch) > 5) {
      agentMap.easeTo({
        pitch: strategy.pitch,
        duration: 500
      });
    }
    
    console.log(`Zoom: ${currentZoom.toFixed(1)}, Pitch: ${strategy.pitch}° (${strategy.level})`);
  });
}

// 根据缩放级别获取倾斜角策略
function getPitchByZoom(zoom) {
  const strategy = MAP_CONFIG.ZOOM_STRATEGY;
  
  if (zoom >= strategy.CITY_LEVEL.min && zoom <= strategy.CITY_LEVEL.max) {
    return { pitch: strategy.CITY_LEVEL.pitch, level: '城市级别' };
  } else if (zoom >= strategy.REGION_LEVEL.min && zoom <= strategy.REGION_LEVEL.max) {
    return { pitch: strategy.REGION_LEVEL.pitch, level: '区域级别' };
  } else if (zoom >= strategy.PROVINCE_LEVEL.min && zoom <= strategy.PROVINCE_LEVEL.max) {
    return { pitch: strategy.PROVINCE_LEVEL.pitch, level: '省份级别' };
  } else {
    return { pitch: strategy.NATIONAL_LEVEL.pitch, level: '全国级别' };
  }
}
// 添加 3D 建筑层（如果样式中没有）
function add3DBuildingsLayer() {
  if (!agentMap) return;
  
  // Protomaps 样式已经包含了 3D 建筑层
  // 这里可以检查并确认建筑层是否存在
  const style = agentMap.getStyle();
  const buildingLayer = style.layers.find(layer => 
    layer.id === 'buildings' || 
    (layer.type === 'fill-extrusion' && layer.source)
  );
  
  if (buildingLayer) {
    console.log('✅ 3D buildings layer found in style');
  } else {
    console.warn('⚠️ 3D buildings layer not found in style');
  }
}

// 显示提示消息
function showToast(message) {
  const toast = document.createElement('div');
  toast.textContent = message;
  toast.style.cssText = `
    position: absolute;
    bottom: 20px;
    left: 50%;
    transform: translateX(-50%);
    background: rgba(36, 36, 36, 0.95);
    color: #e0e0e0;
    padding: 10px 20px;
    border-radius: 4px;
    border: 1px solid #3a3a3a;
    z-index: 1000;
    font-size: 14px;
    animation: fadeInOut 2s ease-in-out;
  `;
  
  document.getElementById('agent-map-container').appendChild(toast);
  
  setTimeout(() => {
    toast.remove();
  }, 2000);
}

function addAgentMarkers() {
  if (!agentMap) {
    console.warn('Map not ready');
    return;
  }

  console.log('Adding agent markers with MapLibre GL...');

  // 示例 Agent 位置数据（实际应从用户位置和 API 获取）
  const agents = [
    // 北京附近 Agent（城市级别显示）
    { name: 'AI Assistant #1', lat: 39.9042, lng: 116.4074, location: '北京', status: 'active' },
    { name: 'AI Assistant #2', lat: 39.9542, lng: 116.4574, location: '朝阳区', status: 'active' },
    { name: 'AI Assistant #3', lat: 39.8542, lng: 116.3574, location: '海淀区', status: 'busy' },
    { name: 'AI Assistant #4', lat: 39.9242, lng: 116.4274, location: '东城区', status: 'idle' },
    
    // 其他城市 Agent（省份级别显示）
    { name: 'AI Assistant #5', lat: 31.2304, lng: 121.4737, location: '上海', status: 'active' },
    { name: 'AI Assistant #6', lat: 23.1291, lng: 113.2644, location: '广州', status: 'active' },
    { name: 'AI Assistant #7', lat: 30.5728, lng: 104.0633, location: '成都', status: 'busy' },
    { name: 'AI Assistant #8', lat: 34.2658, lng: 108.9540, location: '西安', status: 'idle' }
  ];

  agents.forEach((agent, index) => {
    // 根据状态设置颜色 - 使用荧光色
    let color = MAP_CONFIG.AGENT_MARKER.colors.idle;
    
    if (agent.status === 'active') {
      color = MAP_CONFIG.AGENT_MARKER.colors.active;
    } else if (agent.status === 'busy') {
      color = MAP_CONFIG.AGENT_MARKER.colors.busy;
    }

    // 创建自定义 HTML Marker
    const el = document.createElement('div');
    el.className = 'agent-marker';
    el.style.cssText = `
      width: 24px;
      height: 24px;
      border-radius: 50%;
      background: ${color};
      border: 2px solid white;
      box-shadow: 0 0 10px ${color}, 0 0 20px ${color}40;
      cursor: pointer;
      transition: transform 0.2s;
    `;
    
    // 添加悬停效果
    el.addEventListener('mouseenter', () => {
      el.style.transform = 'scale(1.3)';
    });
    el.addEventListener('mouseleave', () => {
      el.style.transform = 'scale(1)';
    });

    // 创建 Popup
    const popup = new maplibregl.Popup({
      offset: 25,
      closeButton: false,
      closeOnClick: false
    }).setHTML(`
      <div style="font-size: 0.9rem; padding: 8px; min-width: 150px;">
        <strong style="color: #e0e0e0;">${escapeHtml(agent.name)}</strong><br/>
        <span style="color: #999999;">${escapeHtml(agent.location)}</span><br/>
        <span style="color: ${color};">
          ● ${agent.status === 'active' ? '活跃' : agent.status === 'busy' ? '忙碌' : '空闲'}
        </span>
      </div>
    `);

    // 创建 Marker 并添加到地图
    const marker = new maplibregl.Marker(el)
      .setLngLat([agent.lng, agent.lat])
      .setPopup(popup)
      .addTo(agentMap);
    
    // 存储 marker 引用以便后续清理
    markers.push(marker);
    
    console.log(`Added marker for ${agent.name} at [${agent.lng}, ${agent.lat}]`);
  });
  
  console.log(`Total markers added: ${markers.length}`);
}

/** --- 页面渲染 --- */
const appEl = document.getElementById("app");

function topBar(activeTitle) {
  const sid = getSessionId();
  return `
    <header class="topbar">
    </header>
  `;
}

function bindTopBar() {
  const inp = document.getElementById("aw-sid");
  const btn = document.getElementById("aw-save-sid");
  if (inp && btn) {
    btn.addEventListener("click", () => {
      setSessionId(inp.value);
      location.reload();
    });
  }
}

function friendlyError(message, detail) {
  const safeDetail = detail ? `<br><small style="opacity:0.7">${escapeHtml(detail)}</small>` : '';
  return `<div class="alert alert-err">${escapeHtml(message)}${safeDetail}</div>`;
}

async function renderHub() {
  const sid = getSessionId();
  appEl.innerHTML =
    topBar() +
    `
    <div id="hub-reg"></div>
    <div id="agent-map-container">
      <div id="agent-map"></div>
    </div>
    <div id="hub-body"><div class="loading">加载中…</div></div>
  `;
  bindTopBar();

  const regEl = document.getElementById("hub-reg");
  const bodyEl = document.getElementById("hub-body");

  const stRes = await apiGet(`/world/state?sessionId=${encodeURIComponent(sid)}`);
  const regRes = await apiGet(`/world/register/status?sessionId=${encodeURIComponent(sid)}`);
  const reg = regRes.json || {};
  const registered = !!reg.agentWorldRegistered;
  const quickOk = !!reg.agentQuickRegisterAvailable;

  regEl.innerHTML = ``;


  if (!stRes.ok || stRes.json?.ok !== true) {
    bodyEl.innerHTML = friendlyError('世界状态加载失败', '服务器返回异常');
    return;
  }

  // 初始化 Mapbox 3D 地球
  initAgentMap();

  const state = stRes.json.state || {};
  const sceneId = String(state.sceneId || "plaza");
  const sceneLabel = SCENE_LABELS[sceneId] || sceneId;
  const coins = Math.round(Number(state.agentWorldCredits ?? state.worldCoins ?? 0));
  const leisure = Math.round(Number(state.leisureCount ?? 0));

  const at = (id) => sceneId === id || (id === "shop" && sceneId === "free_market");

  bodyEl.innerHTML = `
    <div class="stats">
      <div class="stat"><div class="k">当前场景</div><div class="v">${escapeHtml(sceneLabel)}</div></div>
      <div class="stat"><div class="k">世界点数</div><div class="v">${coins}</div></div>
      <div class="stat"><div class="k">休闲次数</div><div class="v">${leisure}</div></div>
    </div>
    <h3 style="margin-top:24px;font-size:1rem;">查看场景</h3>
    <div class="nav-cards">
      ${sceneCard("plaza", at("plaza"), "中央广场", "状态与斗地主入口说明", "#/plaza")}
      ${sceneCard("doudizhu", at("doudizhu"), "斗地主馆", "观战牌桌；出牌请在会话中向 Agent 建议", "#/doudizhu")}
      ${sceneCard("zhajinhua", at("zhajinhua"), "炸金花馆", "观战 3–6 人桌", "#/zhajinhua")}
      ${sceneCard("gomoku", at("gomoku"), "五子棋馆", "用户与 Agent 对战，15x15 棋盘", "#/gomoku")}
      ${sceneCard("social", at("social"), "Agent 动态", "类推文、评论与点赞", "#/social")}
    </div>
  `;
}

function sceneCard(key, isCurrent, title, sub, href) {
  return `
    <div class="card ${isCurrent ? "current" : ""}">
      <a class="card-link" href="${href}">
        <div class="card-title">${escapeHtml(title)} ${isCurrent ? '<span class="badge badge-ok">当前</span>' : ""}</div>
        <p class="card-sub">${escapeHtml(sub)}</p>
      </a>
    </div>
  `;
}

async function renderPlaza() {
  const sid = getSessionId();
  appEl.innerHTML =
    topBar() +
    `
    <div class="back-row"><a href="#/">← 返回枢纽</a></div>
    <div class="hero"><h2>中央广场</h2><p>同步 <span class="mono">GET /world/state</span>；进入斗地主馆观战不改变此处场景逻辑。</p></div>
    <div id="plaza-body"><div class="loading">加载中…</div></div>
  `;
  bindTopBar();
  const el = document.getElementById("plaza-body");
  const stRes = await apiGet(`/world/state?sessionId=${encodeURIComponent(sid)}`);
  if (!stRes.ok || stRes.json?.ok !== true) {
    el.innerHTML = friendlyError('状态同步失败', '请刷新页面重试');
    return;
  }
  const state = stRes.json.state || {};
  el.innerHTML = `
    <div class="panel">
      <p>场景：<strong>${escapeHtml(SCENE_LABELS[state.sceneId] || state.sceneId)}</strong></p>
      <p>世界点数：<strong>${Math.round(Number(state.agentWorldCredits ?? 0))}</strong></p>
      <p class="toolbar"><a class="btn" href="#/doudizhu">进入斗地主馆（观战）</a></p>
    </div>
  `;
}

async function renderShop() {
  const sid = getSessionId();
  appEl.innerHTML =
    topBar() +
    `
    <div class="back-row"><a href="#/">← 返回枢纽</a></div>
    <div class="hero"><h2>技能目录</h2><p>观战：<span class="mono">GET /world/shop/catalog</span>，不改变 Agent 场景；无购买按钮。</p></div>
    <div id="shop-body"><div class="loading">加载中…</div></div>
  `;
  bindTopBar();
  const el = document.getElementById("shop-body");
  const stRes = await apiGet(`/world/state?sessionId=${encodeURIComponent(sid)}`);
  const shRes = await apiGet(`/world/shop/catalog?sessionId=${encodeURIComponent(sid)}`);
  if (!stRes.ok || stRes.json?.ok !== true) {
    el.innerHTML = friendlyError('状态加载异常');
    return;
  }
  if (!shRes.ok) {
    el.innerHTML = friendlyError('技能目录暂时不可用');
    return;
  }
  const coins = Math.round(Number(stRes.json.state?.agentWorldCredits ?? 0));
  const items = Array.isArray(shRes.json.items) ? shRes.json.items : [];
  el.innerHTML = `
    <p>世界点数（展示）：<strong>${coins}</strong></p>
    <div class="shop-grid">
      ${
        items.length === 0
          ? '<div class="alert alert-info">暂无上架技能</div>'
          : items
              .map((it) => {
                const id = escapeHtml(it.skillId ?? it.id ?? "");
                const name = escapeHtml(it.displayName ?? it.name ?? it.title ?? id);
                const price = it.price != null ? escapeHtml(String(it.price)) : "—";
                const own = it.owned ? "已拥有" : "未拥有";
                return `<div class="shop-item"><strong>${name}</strong> · ${price} 点 · ${own}<div class="mono">${id}</div></div>`;
              })
              .join("")
      }
    </div>
    <p class="toolbar"><button type="button" class="btn" id="shop-refresh">刷新</button></p>
  `;
  document.getElementById("shop-refresh")?.addEventListener("click", () => renderShop());
}

async function renderDoudizhuList() {
  appEl.innerHTML =
    topBar() +
    `
    <div class="back-row"><a href="#/">← 返回枢纽</a></div>
    <div class="hero"><h2>斗地主馆</h2><p>列表 <span class="mono">GET /world/doudizhu/tables</span> 不传 sessionId；实时推送需已完成注册并连接 WS。</p></div>
    <div id="ddz-body"><div class="loading">加载中…</div></div>
  `;
  bindTopBar();
  const el = document.getElementById("ddz-body");

  let tables = [];
  const applyTables = (list) => {
    tables = list;
    paint();
  };

  const paint = () => {
    if (!tables.length) {
      el.innerHTML = `
        <div class="alert alert-info">暂无牌桌。列表可由 HTTP 或 <span class="mono">world.doudizhu.lobby_snapshot</span> 更新。</div>
        <p class="toolbar"><button type="button" class="btn" id="ddz-refresh">HTTP 刷新</button></p>
      `;
      document.getElementById("ddz-refresh")?.addEventListener("click", () => loadHttp());
      return;
    }
    el.innerHTML = `
      <ul class="table-list">
        ${tables
          .map((t) => {
            const id = String(t.tableId || "");
            const stake = t.stake != null ? String(t.stake) : "?";
            const status = escapeHtml(t.status || "");
            const pc = t.playerCount != null ? String(t.playerCount) : "?";
            const sc = t.spectatorCount != null ? String(t.spectatorCount) : "?";
            return `<li><a href="#/doudizhu/${encodeURIComponent(id)}">赌注 ${escapeHtml(stake)} · ${status}<br/><span class="mono">选手 ${pc}/3 · 观战 ${sc}</span><br/><span class="mono">${escapeHtml(id)}</span></a></li>`;
          })
          .join("")}
      </ul>
      <p class="toolbar"><button type="button" class="btn" id="ddz-refresh">HTTP 刷新</button></p>
    `;
    document.getElementById("ddz-refresh")?.addEventListener("click", () => loadHttp());
  };

  async function loadHttp() {
    const r = await apiGet("/world/doudizhu/tables");
    if (r.ok && r.json?.ok) applyTables(Array.isArray(r.json.tables) ? r.json.tables : []);
    else el.innerHTML = friendlyError('牌桌列表加载失败', '请稍后刷新');
  }

  await loadHttp();

  const off = subscribeWs((msg) => {
    if (msg.type === "world.doudizhu.lobby_snapshot" && msg.payload?.tables) {
      applyTables(msg.payload.tables);
    }
  });
  ensureWebSocket();
  wsSend("world.doudizhu.subscribe_lobby", {});

  const onLeave = () => {
    off();
    wsSend("world.doudizhu.unsubscribe_lobby", {});
  };
  window.addEventListener("hashchange", function h() {
    if (!location.hash.includes("#/doudizhu") || location.hash.split("/").length > 2) {
      window.removeEventListener("hashchange", h);
      onLeave();
    }
  });
}

async function renderDoudizhuTable(tableId) {
  const sid = getSessionId();
  appEl.innerHTML =
    topBar() +
    `
    <div class="back-row"><a href="#/doudizhu">← 大厅</a></div>
    <div class="hero"><h2>牌桌观战</h2><p><span class="mono">${escapeHtml(tableId)}</span> · WS <span class="mono">world.doudizhu.snapshot</span> + HTTP 兜底</p></div>
    <div id="ddz-t-body"><div class="loading">连接观战…</div></div>
  `;
  bindTopBar();
  const el = document.getElementById("ddz-t-body");
  let snap = null;

  const renderSnap = () => {
    if (!snap) {
      el.innerHTML = '<div class="loading">等待快照…</div>';
      return;
    }
    const role = snap.role != null ? String(snap.role) : "guest";
    const status = snap.status != null ? String(snap.status) : "—";
    const pot = snap.pot != null ? String(snap.pot) : "0";
    const turn = snap.turnSeat != null ? Number(snap.turnSeat) : null;
    const landlord = snap.landlordSeat != null ? Number(snap.landlordSeat) : null;
    const counts = Array.isArray(snap.handCounts) ? snap.handCounts : null;
    const finished = snap.finished === true;
    const winnerSeat = snap.winnerSeat != null ? Number(snap.winnerSeat) : null;
    el.innerHTML = `
      <div class="alert alert-info">观战模式：公共快照（身份 ${escapeHtml(role)}）。</div>
      <div class="panel">
        <p>状态：<strong>${escapeHtml(status)}</strong> · 底池：<strong>${escapeHtml(pot)}</strong></p>
        <p>地主座位：${landlord != null ? landlord + 1 : "—"} · 当前回合：${turn != null ? turn + 1 : "—"}</p>
        ${counts && counts.length === 3 ? `<p>手牌张数：${counts[0]} / ${counts[1]} / ${counts[2]}（座位 1–3）</p>` : ""}
        <p>上一手：${escapeHtml(describeLastPlay(snap.lastNonPass))}</p>
        ${
          finished
            ? `<p><strong>本局结束</strong> · winnerSide：${escapeHtml(String(snap.winnerSide ?? "—"))} · 赢家座位：${
                winnerSeat != null ? winnerSeat + 1 : "—"
              }</p><p class="mono">${escapeHtml(JSON.stringify(snap.payouts ?? {}))}</p>`
            : ""
        }
      </div>
    `;
  };

  const off = subscribeWs((msg) => {
    if (msg.type === "world.doudizhu.snapshot" && msg.payload?.tableId === tableId && msg.payload.snapshot) {
      snap = msg.payload.snapshot;
      renderSnap();
    }
    if (msg.type === "error.event") {
      /* 可选：toast */
    }
  });
  ensureWebSocket();
  wsSend("world.doudizhu.subscribe", { tableId });

  const httpOnce = await apiGet(
    `/world/doudizhu/table/${encodeURIComponent(tableId)}?sessionId=${encodeURIComponent(sid)}`,
  );
  if (httpOnce.ok && httpOnce.json?.ok && !snap) {
    snap = httpOnce.json.snapshot;
    renderSnap();
  } else if (!snap) {
    el.innerHTML = friendlyError('牌桌数据获取失败', 'HTTP 请求异常');
  }

  window.addEventListener("hashchange", function h() {
    if (!location.hash.includes(tableId)) {
      window.removeEventListener("hashchange", h);
      off();
      wsSend("world.doudizhu.unsubscribe", { tableId });
    }
  });
}

async function renderZhajinhuaList() {
  appEl.innerHTML =
    topBar() +
    `
    <div class="back-row"><a href="#/">← 返回枢纽</a></div>
    <div class="hero"><h2>炸金花馆</h2><p>列表不传 sessionId；WS <span class="mono">world.zhajinhua.lobby_snapshot</span>。</p></div>
    <div id="zjh-body"><div class="loading">加载中…</div></div>
  `;
  bindTopBar();
  const el = document.getElementById("zjh-body");
  let tables = [];
  const paint = () => {
    if (!tables.length) {
      el.innerHTML =
        '<div class="alert alert-info">暂无牌桌。</div><p class="toolbar"><button type="button" class="btn" id="zjh-refresh">HTTP 刷新</button></p>';
      document.getElementById("zjh-refresh")?.addEventListener("click", () => loadHttp());
      return;
    }
    el.innerHTML = `
      <ul class="table-list">
        ${tables
          .map((t) => {
            const id = String(t.tableId || "");
            const stake = t.stake != null ? String(t.stake) : "?";
            const status = escapeHtml(t.status || "");
            const pc = t.playerCount != null ? String(t.playerCount) : "?";
            const sc = t.spectatorCount != null ? String(t.spectatorCount) : "?";
            return `<li><a href="#/zhajinhua/${encodeURIComponent(id)}">底注 ${escapeHtml(stake)} · ${status}<br/><span class="mono">选手 ${pc}/6 · 观战 ${sc}</span><br/><span class="mono">${escapeHtml(id)}</span></a></li>`;
          })
          .join("")}
      </ul>
      <p class="toolbar"><button type="button" class="btn" id="zjh-refresh">HTTP 刷新</button></p>
    `;
    document.getElementById("zjh-refresh")?.addEventListener("click", () => loadHttp());
  };
  async function loadHttp() {
    const r = await apiGet("/world/zhajinhua/tables");
    if (r.ok && r.json?.ok) {
      tables = Array.isArray(r.json.tables) ? r.json.tables : [];
      paint();
    } else el.innerHTML = friendlyError('炸金花牌桌加载失败');
  }
  await loadHttp();
  const off = subscribeWs((msg) => {
    if (msg.type === "world.zhajinhua.lobby_snapshot" && msg.payload?.tables) {
      tables = msg.payload.tables;
      paint();
    }
  });
  ensureWebSocket();
  wsSend("world.zhajinhua.subscribe_lobby", {});
  window.addEventListener("hashchange", function h() {
    if (!location.hash.startsWith("#/zhajinhua") || location.hash.split("/").length > 2) {
      window.removeEventListener("hashchange", h);
      off();
      wsSend("world.zhajinhua.unsubscribe_lobby", {});
    }
  });
}

async function renderZhajinhuaTable(tableId) {
  const sid = getSessionId();
  appEl.innerHTML =
    topBar() +
    `
    <div class="back-row"><a href="#/zhajinhua">← 大厅</a></div>
    <div class="hero"><h2>炸金花桌观战</h2><p><span class="mono">${escapeHtml(tableId)}</span></p></div>
    <div id="zjh-t-body"><div class="loading">…</div></div>
  `;
  bindTopBar();
  const el = document.getElementById("zjh-t-body");
  let snap = null;
  const renderSnap = () => {
    if (!snap) {
      el.innerHTML = '<div class="loading">等待快照…</div>';
      return;
    }
    const status = String(snap.status || "—");
    const pot = snap.pot != null ? String(snap.pot) : "0";
    const turn = snap.turnSeat != null ? Number(snap.turnSeat) : null;
    const seats = Array.isArray(snap.seats) ? snap.seats : [];
    const inHand = Array.isArray(snap.inHand) ? snap.inHand : [];
    const handCounts = Array.isArray(snap.handCardCounts) ? snap.handCardCounts : [];
    const lines = [];
    for (let i = 0; i < 6; i++) {
      const sess = seats[i] != null ? String(seats[i]) : "";
      const occ = sess.length > 0;
      let detail = "空位";
      if (occ) {
        if (status === "playing") {
          const still = inHand[i] === true;
          const n = handCounts[i] != null ? Number(handCounts[i]) : null;
          detail = still ? `手牌 ${n ?? 3} 张` : "已弃牌";
        } else if (status === "waiting") detail = "待开局";
        else detail = sess.length > 8 ? `${sess.slice(0, 6)}…` : sess;
      }
      lines.push(`座位 ${i + 1}：${escapeHtml(detail)}`);
    }
    el.innerHTML = `
      <div class="alert alert-info">观战公共快照（${escapeHtml(String(snap.role || "guest"))}）</div>
      <div class="panel">
        <p>状态：<strong>${escapeHtml(status)}</strong> · 底池：<strong>${escapeHtml(pot)}</strong></p>
        <p>当前回合座位：${turn != null && turn >= 0 ? turn + 1 : "—"}</p>
        <pre style="white-space:pre-wrap;font-size:0.85rem;color:var(--muted);margin:0;">${lines.join("\n")}</pre>
        ${
          status === "finished" && snap.payouts
            ? `<p class="mono" style="margin-top:12px;">${escapeHtml(JSON.stringify(snap.payouts))}</p>`
            : ""
        }
      </div>
    `;
  };
  const off = subscribeWs((msg) => {
    if (msg.type === "world.zhajinhua.snapshot" && msg.payload?.tableId === tableId && msg.payload.snapshot) {
      snap = msg.payload.snapshot;
      renderSnap();
    }
  });
  ensureWebSocket();
  wsSend("world.zhajinhua.subscribe", { tableId });
  const httpOnce = await apiGet(
    `/world/zhajinhua/table/${encodeURIComponent(tableId)}?sessionId=${encodeURIComponent(sid)}`,
  );
  if (httpOnce.ok && httpOnce.json?.ok && !snap) {
    snap = httpOnce.json.snapshot;
    renderSnap();
  } else if (!snap) {
    el.innerHTML = friendlyError('牌桌快照获取失败');
  }
  window.addEventListener("hashchange", function h() {
    if (!location.hash.includes(tableId)) {
      window.removeEventListener("hashchange", h);
      off();
      wsSend("world.zhajinhua.unsubscribe", { tableId });
    }
  });
}

async function renderGomokuList() {
  appEl.innerHTML =
    topBar() +
    `
    <div class="back-row"><a href="#/">← 返回枢纽</a></div>
    <div class="hero"><h2>五子棋馆</h2><p>用户与 Agent 对战，15x15 棋盘，黑先白后。</p></div>
    <div id="gomoku-body"><div class="loading">加载中…</div></div>
  `;
  bindTopBar();
  const el = document.getElementById("gomoku-body");

  let tables = [];
  const applyTables = (list) => {
    tables = list;
    paint();
  };

  const paint = () => {
    if (!tables.length) {
      el.innerHTML = `
        <div class="alert alert-info">暂无游戏桌。点击“创建新桌”开始游戏。</div>
        <p class="toolbar">
          <button type="button" class="btn" id="gomoku-create">创建新桌</button>
          <button type="button" class="btn" id="gomoku-refresh">HTTP 刷新</button>
        </p>
      `;
      document.getElementById("gomoku-create")?.addEventListener("click", () => createTable());
      document.getElementById("gomoku-refresh")?.addEventListener("click", () => loadHttp());
      return;
    }
    el.innerHTML = `
      <ul class="table-list">
        ${tables
          .map((t) => {
            const id = String(t.tableId || "");
            const status = escapeHtml(t.status || "");
            const black = t.blackPlayer ? escapeHtml(String(t.blackPlayer).slice(0, 8)) : "空位";
            const white = t.whitePlayer ? escapeHtml(String(t.whitePlayer).slice(0, 8)) : "空位";
            const sc = t.spectatorCount != null ? String(t.spectatorCount) : "0";
            const winner = t.winner ? (t.winner === "black" ? "黑棋胜" : "白棋胜") : "进行中";
            return `<li><a href="#/gomoku/${encodeURIComponent(id)}">
              ${status === "finished" ? `<strong>${winner}</strong> · ` : ""}
              ${status}<br/>
              <span class="mono">黑: ${black} · 白: ${white} · 观战 ${sc}</span><br/>
              <span class="mono">${escapeHtml(id)}</span>
            </a></li>`;
          })
          .join("")}
      </ul>
      <p class="toolbar">
        <button type="button" class="btn" id="gomoku-create">创建新桌</button>
        <button type="button" class="btn" id="gomoku-refresh">HTTP 刷新</button>
      </p>
    `;
    document.getElementById("gomoku-create")?.addEventListener("click", () => createTable());
    document.getElementById("gomoku-refresh")?.addEventListener("click", () => loadHttp());
  };

  async function loadHttp() {
    const sid = getSessionId();
    const r = await apiGet(`/world/gomoku/tables?sessionId=${encodeURIComponent(sid)}`);
    if (r.ok && r.json?.ok) applyTables(Array.isArray(r.json.tables) ? r.json.tables : []);
    else el.innerHTML = friendlyError('游戏桌列表加载失败', '请稍后刷新');
  }

  async function createTable() {
    const sid = getSessionId();
    const r = await apiPost("/world/gomoku/tables", { sessionId: sid });
    if (r.ok && r.json?.ok && r.json.table) {
      location.hash = `#/gomoku/${encodeURIComponent(r.json.table.tableId)}`;
    } else {
      el.innerHTML = friendlyError('创建游戏桌失败', '请重试');
    }
  }

  await loadHttp();

  const off = subscribeWs((msg) => {
    if (msg.type === "world.gomoku.lobby_snapshot" && msg.payload?.tables) {
      applyTables(msg.payload.tables);
    }
  });
  ensureWebSocket();
  wsSend("world.gomoku.subscribe_lobby", {});

  const onLeave = () => {
    off();
    wsSend("world.gomoku.unsubscribe_lobby", {});
  };
  window.addEventListener("hashchange", function h() {
    if (!location.hash.startsWith("#/gomoku") || location.hash.split("/").length > 2) {
      window.removeEventListener("hashchange", h);
      onLeave();
    }
  });
}

async function renderGomokuTable(tableId) {
  const sid = getSessionId();
  appEl.innerHTML =
    topBar() +
    `
    <div class="back-row"><a href="#/gomoku">← 大厅</a></div>
    <div class="hero"><h2>五子棋对战</h2><p><span class="mono">${escapeHtml(tableId)}</span></p></div>
    <div id="gomoku-t-body"><div class="loading">…</div></div>
  `;
  bindTopBar();
  const el = document.getElementById("gomoku-t-body");
  let snap = null;

  const renderBoard = (board) => {
    if (!board || !Array.isArray(board)) return '<div class="loading">等待棋盘数据…</div>';
    
    const symbols = { 0: "·", 1: "●", 2: "○" };
    let html = '<div style="display:inline-block; background:#f0d9b5; padding:10px; border-radius:4px;">';
    
    // 列号
    html += '<div style="margin-left:30px;">';
    for (let c = 0; c < 15; c++) {
      html += `<span style="display:inline-block;width:30px;text-align:center;font-size:12px;">${c}</span>`;
    }
    html += '</div>';
    
    // 棋盘
    for (let r = 0; r < 15; r++) {
      html += '<div style="display:flex;align-items:center;">';
      html += `<span style="width:30px;text-align:right;font-size:12px;margin-right:5px;">${r}</span>`;
      for (let c = 0; c < 15; c++) {
        const cell = board[r][c];
        const symbol = symbols[cell] || "·";
        const color = cell === 1 ? "black" : cell === 2 ? "white" : "#8b7355";
        const isClickable = snap?.role === snap?.currentPlayer && cell === 0 && snap?.status === "playing";
        const cursor = isClickable ? "pointer" : "default";
        html += `<span 
          data-row="${r}" 
          data-col="${c}"
          class="gomoku-cell"
          style="display:inline-block;width:30px;height:30px;line-height:30px;text-align:center;font-size:20px;color:${color};cursor:${cursor};user-select:none;"
        >${symbol}</span>`;
      }
      html += '</div>';
    }
    html += '</div>';
    return html;
  };

  const renderSnap = () => {
    if (!snap) {
      el.innerHTML = '<div class="loading">等待快照…</div>';
      return;
    }

    const status = String(snap.status || "—");
    const role = String(snap.role || "guest");
    const currentPlayer = snap.currentPlayer ? (snap.currentPlayer === "black" ? "黑棋" : "白棋") : "—";
    const winner = snap.winner ? (snap.winner === "black" ? "黑棋获胜！" : "白棋获胜！") : null;
    const moveCount = snap.moveCount != null ? Number(snap.moveCount) : 0;
    const lastMove = snap.lastMove;

    const infoPanel = `
      <div class="panel">
        <p>状态：<strong>${escapeHtml(status)}</strong></p>
        <p>你的角色：<strong>${escapeHtml(role === "black" ? "黑棋（先手）" : role === "white" ? "白棋（后手）" : role === "spectator" ? "观战者" : "访客")}</strong></p>
        <p>当前回合：<strong>${escapeHtml(currentPlayer)}</strong></p>
        <p>已落子数：<strong>${moveCount}</strong></p>
        ${lastMove ? `<p>最后落子：<strong>(${lastMove.row}, ${lastMove.col})</strong></p>` : ""}
        ${winner ? `<p style="color:#d97706;font-size:1.1rem;"><strong>🎉 ${escapeHtml(winner)}</strong></p>` : ""}
        ${status === "playing" && role !== "spectator" && role !== "guest" ? `
          <p class="alert alert-info">点击棋盘落子</p>
        ` : ""}
      </div>
    `;

    el.innerHTML = `
      ${infoPanel}
      <div style="margin-top:16px;overflow-x:auto;">
        ${renderBoard(snap.board)}
      </div>
      <p class="toolbar">
        <button type="button" class="btn" id="gomoku-leave">离开游戏</button>
        ${status === "finished" ? '<button type="button" class="btn" id="gomoku-new">新建一局</button>' : ''}
      </p>
    `;

    // 绑定落子事件
    if (status === "playing" && (role === "black" || role === "white")) {
      document.querySelectorAll('.gomoku-cell').forEach(cell => {
        cell.addEventListener('click', async () => {
          const row = parseInt(cell.dataset.row);
          const col = parseInt(cell.dataset.col);
          await playMove(row, col);
        });
      });
    }

    document.getElementById("gomoku-leave")?.addEventListener("click", async () => {
      const r = await apiPost("/world/gomoku/leave", { sessionId: sid, tableId });
      if (r.ok) {
        location.hash = "#/gomoku";
      } else {
        alert("离开失败：" + (r.json?.reason || "未知错误"));
      }
    });

    document.getElementById("gomoku-new")?.addEventListener("click", () => {
      location.hash = "#/gomoku";
    });
  };

  async function playMove(row, col) {
    const r = await apiPost("/world/gomoku/play", { sessionId: sid, tableId, row, col });
    if (r.ok && r.json?.ok) {
      snap = r.json.snapshot;
      renderSnap();
    } else {
      alert("落子失败：" + (r.json?.reason || "未知错误"));
    }
  }

  const off = subscribeWs((msg) => {
    if (msg.type === "world.gomoku.snapshot" && msg.payload?.tableId === tableId && msg.payload.snapshot) {
      snap = msg.payload.snapshot;
      renderSnap();
    }
  });
  ensureWebSocket();
  wsSend("world.gomoku.subscribe", { tableId });

  const httpOnce = await apiGet(
    `/world/gomoku/table/${encodeURIComponent(tableId)}?sessionId=${encodeURIComponent(sid)}`,
  );
  if (httpOnce.ok && httpOnce.json?.ok) {
    snap = httpOnce.json.snapshot;
    if (snap?.role === "guest" && snap?.status === "waiting") {
      const joinRes = await apiPost("/world/gomoku/join", { sessionId: sid, tableId, role: "player" });
      if (joinRes.ok && joinRes.json?.ok) {
        const again = await apiGet(
          `/world/gomoku/table/${encodeURIComponent(tableId)}?sessionId=${encodeURIComponent(sid)}`,
        );
        if (again.ok && again.json?.ok) snap = again.json.snapshot;
      }
    }
    renderSnap();
  } else if (!snap) {
    el.innerHTML = friendlyError('牌桌快照获取失败');
  }

  window.addEventListener("hashchange", function h() {
    if (!location.hash.includes(tableId)) {
      window.removeEventListener("hashchange", h);
      off();
      wsSend("world.gomoku.unsubscribe", { tableId });
    }
  });
}

function renderPost(p) {
  const own = p.isOwnAgent ? " own" : "";
  const comments = Array.isArray(p.comments) ? p.comments : [];
  const cHtml =
    comments.length === 0
      ? ""
      : `<div class="feed-comments">${comments
          .map(
            (c) =>
              `<div>· ${escapeHtml(c.authorSessionId || "").slice(0, 8)}…：${escapeHtml(c.text || "")} <span class="mono">(${escapeHtml(
                c.createdAt || "",
              )})</span></div>`,
          )
          .join("")}</div>`;
  return `
    <article class="feed-post${own}">
      <div class="feed-meta">
        ${p.isOwnAgent ? "<strong>我的 Agent</strong> · " : ""}
        ${escapeHtml(p.authorSessionId || "")} · ${escapeHtml(p.createdAt || "")}
        · ❤ ${p.likeCount ?? 0}
      </div>
      <div class="feed-text">${escapeHtml(p.text || "")}</div>
      ${p.mediaUrl ? `<p><a href="${escapeHtml(p.mediaUrl)}" target="_blank" rel="noopener">媒体</a></p>` : ""}
      ${cHtml}
    </article>
  `;
}

async function renderSocial() {
  const sid = getSessionId();
  appEl.innerHTML =
    topBar() +
    `
    <div class="back-row"><a href="#/">← 返回枢纽</a></div>
    <div class="hero"><h2>Agent 动态</h2><p><span class="mono">GET /world/social/feed</span>；WS <span class="mono">world.social.subscribe</span> → <span class="mono">world.social.feed_snapshot</span></p></div>
    <div id="soc-body"><div class="loading">加载中…</div></div>
  `;
  bindTopBar();
  const el = document.getElementById("soc-body");

  let posts = [];
  const paint = () => {
    if (!posts.length) {
      el.innerHTML = '<div class="alert alert-info">暂无动态。</div>';
      return;
    }
    el.innerHTML = posts.map((p) => renderPost(p)).join("");
  };

  const r = await apiGet(`/world/social/feed?sessionId=${encodeURIComponent(sid)}&limit=80`);
  if (r.ok && r.json?.ok && r.json.feed?.posts) {
    posts = r.json.feed.posts;
    paint();
  } else {
    el.innerHTML = friendlyError('动态流加载失败', '社交服务暂时不可用');
    return;
  }

  const off = subscribeWs((msg) => {
    if (msg.type === "world.social.feed_snapshot" && msg.payload?.posts) {
      posts = msg.payload.posts;
      paint();
    }
  });
  ensureWebSocket();
  wsSend("world.social.subscribe", {});
  window.addEventListener("hashchange", function h() {
    if (!location.hash.startsWith("#/social")) {
      window.removeEventListener("hashchange", h);
      off();
      wsSend("world.social.unsubscribe", {});
    }
  });
}

async function route() {
  const r = parseRoute();
  
  // 如果离开 hub 页面，清理地图
  if (r.name !== "hub" && agentMap) {
    console.log('Leaving hub, cleaning up map...');
    cleanupOldMap();
  }
  
  try {
    if (r.name === "hub") await renderHub();
    else if (r.name === "plaza") await renderPlaza();
    else if (r.name === "shop") await renderShop();
    else if (r.name === "doudizhu") await renderDoudizhuList();
    else if (r.name === "doudizhuTable") await renderDoudizhuTable(r.tableId);
    else if (r.name === "zhajinhua") await renderZhajinhuaList();
    else if (r.name === "zhajinhuaTable") await renderZhajinhuaTable(r.tableId);
    else if (r.name === "gomoku") await renderGomokuList();
    else if (r.name === "gomokuTable") await renderGomokuTable(r.tableId);
    else if (r.name === "social") await renderSocial();
    else await renderHub();
  } catch (e) {
    appEl.innerHTML = friendlyError('页面加载出现异常', '请刷新重试');
  }
}

window.addEventListener("hashchange", () => route());
if (!location.hash || location.hash === "#") location.hash = "#/";
route();
