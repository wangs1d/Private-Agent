/**
 * 管理控制台页面（管理员）：自包含 HTML，无外部依赖。
 *
 * 左侧导航 + 五个标签：概览 / 用户 / 支付 / 站内信 / 反馈管理。
 * 数据接口：反馈走 /api/feedback*（同源无鉴权，与客户端一致）；
 * 其余管理接口带 x-admin-token（localStorage 保存，与 gateway-admin 同一令牌）。
 * 页内脚本用字符串拼接渲染，内容全部经 esc() 转义；事件用委托，不用内联 onclick。
 */

const STATUS_LABELS: Record<string, string> = {
  open: "待处理",
  processing: "处理中",
  resolved: "已解决",
};

const TYPE_LABELS: Record<string, string> = {
  bug: "问题报障",
  suggestion: "功能建议",
  other: "其他",
};

export function renderAdminConsolePage(): string {
  const statusLabelsJson = JSON.stringify(STATUS_LABELS);
  const typeLabelsJson = JSON.stringify(TYPE_LABELS);
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>管理控制台 · Private-Agent</title>
<style>
  :root {
    --bg: #f3f5f9; --card: #ffffff; --line: #e4e8ef;
    --text: #1c2333; --muted: #6b7280;
    --accent: #3b82f6; --accent-weak: #eff6ff;
    --side: #1c2333; --side-text: #9aa4b8;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--text);
    font-family: -apple-system, "Segoe UI", "Microsoft YaHei", "PingFang SC", sans-serif;
    font-size: 14px; line-height: 1.6;
  }
  aside {
    position: fixed; left: 0; top: 0; bottom: 0; width: 208px;
    background: var(--side); color: var(--side-text);
    display: flex; flex-direction: column; padding: 18px 12px;
  }
  aside .brand { color: #fff; font-size: 16px; font-weight: 600; padding: 4px 10px 2px; }
  aside .brand-sub { font-size: 11px; padding: 0 10px 14px; border-bottom: 1px solid #2a3247; }
  nav { margin-top: 12px; flex: 1; }
  nav a {
    display: block; padding: 9px 12px; margin: 2px 0; border-radius: 8px;
    color: var(--side-text); text-decoration: none; font-size: 13px;
  }
  nav a:hover { background: #242d42; color: #dbe3f0; }
  nav a.on { background: var(--accent); color: #fff; }
  .tokenbox { border-top: 1px solid #2a3247; padding: 12px 10px 4px; }
  .tokenbox label { font-size: 11px; display: block; margin-bottom: 6px; }
  .tokenbox input {
    width: 100%; border: 1px solid #2a3247; background: #242d42; color: #dbe3f0;
    border-radius: 6px; padding: 5px 8px; font-size: 12px;
  }
  .tokenbox .hint { font-size: 10px; color: #5d6880; margin-top: 5px; }
  main { margin-left: 208px; padding: 26px 28px 70px; }
  h1 { font-size: 19px; margin: 0 0 4px; }
  .sub { color: var(--muted); font-size: 12px; margin-bottom: 18px; }
  section.tab { display: none; }
  section.tab.on { display: block; }
  .stats { display: flex; gap: 12px; flex-wrap: wrap; margin-bottom: 16px; }
  .stat {
    background: var(--card); border: 1px solid var(--line); border-radius: 10px;
    padding: 10px 18px; min-width: 112px;
  }
  .stat b { display: block; font-size: 22px; }
  .stat span { color: var(--muted); font-size: 12px; }
  .stat .stat-sub { font-size: 11px; color: var(--accent); margin-top: 2px; }
  .bars { display: flex; gap: 4px; align-items: flex-end; }
  .bar-col { flex: 1; display: flex; flex-direction: column; align-items: center; gap: 3px; }
  .bar-v { width: 100%; border-radius: 3px 3px 0 0; min-height: 2px; }
  .bar-label { font-size: 9px; color: var(--muted); white-space: nowrap; }
  .toolbar {
    display: flex; gap: 8px; align-items: center; flex-wrap: wrap;
    background: var(--card); border: 1px solid var(--line); border-radius: 10px;
    padding: 10px 12px; margin-bottom: 16px;
  }
  .seg { display: inline-flex; border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
  .seg button {
    border: 0; background: transparent; padding: 6px 14px; cursor: pointer;
    font-size: 13px; color: var(--muted);
  }
  .seg button.on { background: var(--accent); color: #fff; }
  select, input[type=search] {
    border: 1px solid var(--line); border-radius: 8px; padding: 6px 10px; font-size: 13px;
    background: #fff; color: var(--text);
  }
  input[type=search] { flex: 1; min-width: 140px; }
  .btn {
    border: 1px solid var(--line); background: #fff; border-radius: 8px;
    padding: 6px 14px; cursor: pointer; font-size: 13px; color: var(--text);
  }
  .btn:hover { border-color: var(--accent); color: var(--accent); }
  .btn.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
  .btn.primary:hover { opacity: .9; color: #fff; }
  .btn.danger:hover { border-color: #dc2626; color: #dc2626; }
  .card {
    background: var(--card); border: 1px solid var(--line); border-radius: 12px;
    padding: 16px 18px; margin-bottom: 12px;
  }
  .card h3 { font-size: 15px; margin: 0; flex: 1; min-width: 200px; }
  .card .head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .chip { font-size: 12px; border-radius: 999px; padding: 1px 10px; border: 1px solid transparent; }
  .chip.bug { background: #fee2e2; color: #dc2626; }
  .chip.suggestion { background: #ede9fe; color: #7c3aed; }
  .chip.other { background: #e5e7eb; color: #4b5563; }
  .chip.open { background: #fef3c7; color: #d97706; }
  .chip.processing { background: #dbeafe; color: #2563eb; }
  .chip.resolved { background: #dcfce7; color: #16a34a; }
  .chip.ok { background: #dcfce7; color: #16a34a; }
  .chip.bad { background: #fee2e2; color: #dc2626; }
  .chip.online { background: #dcfce7; color: #16a34a; }
  .chip.offline { background: #e5e7eb; color: #6b7280; }
  .meta { color: var(--muted); font-size: 12px; margin-top: 4px; }
  .desc { white-space: pre-wrap; margin: 10px 0 4px; }
  table { border-collapse: collapse; width: 100%; }
  th, td {
    text-align: left; border-bottom: 1px solid var(--line);
    padding: 8px 10px; font-size: 13px; vertical-align: top;
  }
  th { color: var(--muted); font-weight: 500; font-size: 12px; }
  td.wrap, .kv-val { max-width: 420px; overflow-wrap: anywhere; }
  .kv td:first-child { color: var(--muted); width: 190px; background: #f8fafc; }
  details.diag { margin: 8px 0; }
  details.diag summary { cursor: pointer; color: var(--muted); font-size: 12px; }
  pre.json {
    background: #f8fafc; border: 1px solid var(--line); border-radius: 8px;
    padding: 10px 12px; font-size: 12px; overflow: auto; max-height: 420px;
  }
  .replybox { margin-top: 12px; border-top: 1px dashed var(--line); padding-top: 10px; }
  .replybox .existing {
    background: var(--accent-weak); border-radius: 8px; padding: 8px 12px;
    font-size: 13px; margin-bottom: 8px;
  }
  textarea {
    width: 100%; border: 1px solid var(--line); border-radius: 8px;
    padding: 8px 10px; font-size: 13px; font-family: inherit; resize: vertical;
  }
  .actions { display: flex; gap: 8px; margin-top: 8px; flex-wrap: wrap; align-items: center; }
  .saved { color: #16a34a; font-size: 12px; }
  .empty { text-align: center; color: var(--muted); padding: 50px 0; }
  .err { background: #fee2e2; color: #b91c1c; border-radius: 8px; padding: 10px 14px; margin-bottom: 12px; }
  .ok-note { background: #dcfce7; color: #166534; border-radius: 8px; padding: 8px 14px; margin-bottom: 12px; }
  .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  @media (max-width: 900px) { .grid2 { grid-template-columns: 1fr; } }
  .card .card-title { font-size: 14px; font-weight: 600; margin-bottom: 8px; }
</style>
</head>
<body>
<aside>
  <div class="brand">管理控制台</div>
  <div class="brand-sub">Private-Agent · 部署后台</div>
  <nav id="nav">
    <a href="#overview" data-tab="overview">概览</a>
    <a href="#users" data-tab="users">用户</a>
    <a href="#payments" data-tab="payments">支付</a>
    <a href="#messages" data-tab="messages">站内信</a>
    <a href="#feedback" data-tab="feedback">反馈管理</a>
  </nav>
  <div class="tokenbox">
    <label>管理员 Token（管理数据接口）</label>
    <input id="adminToken" placeholder="ADMIN_UPLOAD_TOKEN">
    <div class="hint">保存于本浏览器 localStorage</div>
  </div>
</aside>
<main>
  <div id="err"></div>

  <section class="tab" id="tab-overview">
    <h1>概览</h1>
    <div class="sub">用户增长 · 站内信 · 支付收入 · 反馈 · 设备</div>
    <div id="overviewBody"><div class="empty">加载中…</div></div>
  </section>

  <section class="tab" id="tab-users">
    <h1>用户</h1>
    <div class="sub">注册数据与增长变化</div>
    <div id="usersBody"><div class="empty">加载中…</div></div>
  </section>

  <section class="tab" id="tab-payments">
    <h1>支付</h1>
    <div class="sub">付费意愿（下单量）与收入（已支付金额）</div>
    <div id="paymentsBody"><div class="empty">加载中…</div></div>
  </section>

  <section class="tab" id="tab-messages">
    <h1>站内信</h1>
    <div class="sub">消息量 · 平台分布 · 最近消息</div>
    <div id="messagesBody"><div class="empty">加载中…</div></div>
  </section>

  <section class="tab" id="tab-feedback">
    <h1>反馈管理</h1>
    <div class="sub">用户提交的报障与建议，流转状态并回复（用户端可见）</div>
    <div class="stats" id="fbStats"></div>
    <div class="toolbar">
      <div class="seg" id="fbStatusSeg"></div>
      <select id="fbTypeSel">
        <option value="">全部类型</option>
        <option value="bug">问题报障</option>
        <option value="suggestion">功能建议</option>
        <option value="other">其他</option>
      </select>
      <input type="search" id="fbKw" placeholder="搜索标题 / 描述 / 身份 / 联系方式">
      <button class="btn primary" id="fbRefresh">刷新</button>
    </div>
    <div id="fbList"><div class="empty">加载中…</div></div>
  </section>
</main>
<script>
var STATUS_LABELS = ${statusLabelsJson};
var TYPE_LABELS = ${typeLabelsJson};
var STATUS_FLOW = [
  { status: "processing", label: "标记处理中", cls: "btn primary" },
  { status: "resolved", label: "标记已解决", cls: "btn" },
  { status: "open", label: "重新打开", cls: "btn" }
];
var allFeedback = [];
var fbStatusFilter = "";
var currentTab = "overview";

function $(id) { return document.getElementById(id); }

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function token() { return localStorage.getItem("pa_admin_token") || $("adminToken").value.trim(); }

function api(path, opts) {
  opts = Object.assign({}, opts || {});
  opts.headers = Object.assign({ "x-admin-token": token() }, opts.headers || {});
  // 服务端 watch 重启后，浏览器连接池里的旧 keep-alive 连接可能半死：
  // fetch 永远 pending 而不是 reject。每次尝试 6 秒无响应就 abort 换新连接，
  // 最多试 3 次；HTTP 4xx/5xx 照常透传给调用方处理。
  var attempt = function (delayMs) {
    var prepare = delayMs
      ? new Promise(function (res) { setTimeout(res, delayMs); })
      : Promise.resolve();
    return prepare.then(function () {
      var ctrl = new AbortController();
      var timer = setTimeout(function () { ctrl.abort(); }, 6000);
      opts.signal = ctrl.signal;
      return fetch(path, opts).finally(function () { clearTimeout(timer); });
    });
  };
  return attempt(0).catch(function () {
    return attempt(600);
  }).catch(function () {
    return attempt(1500);
  });
}

function fmtTime(isoOrMs) {
  if (!isoOrMs) return "-";
  var d = new Date(isoOrMs);
  if (isNaN(d.getTime())) return "-";
  var p = function (n) { return (n < 10 ? "0" : "") + n; };
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) +
    " " + p(d.getHours()) + ":" + p(d.getMinutes());
}

function fmtBytes(n) {
  if (!n && n !== 0) return "-";
  var units = ["B", "KB", "MB", "GB"];
  var i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return n.toFixed(1) + " " + units[i];
}

function fmtUptime(ms) {
  var s = Math.floor(ms / 1000);
  var d = Math.floor(s / 86400); s %= 86400;
  var h = Math.floor(s / 3600); s %= 3600;
  var m = Math.floor(s / 60);
  if (d > 0) return d + " 天 " + h + " 时 " + m + " 分";
  if (h > 0) return h + " 时 " + m + " 分";
  return m + " 分 " + (s % 60) + " 秒";
}

function showErr(msg) { $("err").innerHTML = '<div class="err">' + esc(msg) + "</div>"; }
function clearErr() { $("err").innerHTML = ""; }
function okNote(msg) { return '<div class="ok-note">' + esc(msg) + "</div>"; }

function kvTable(pairs) {
  return '<table class="kv">' + pairs.map(function (p) {
    return "<tr><td>" + esc(p[0]) + '</td><td class="kv-val">' + p[1] + "</td></tr>";
  }).join("") + "</table>";
}

function chip(cls, text) { return '<span class="chip ' + cls + '">' + esc(text) + "</span>"; }

// ---------- 标签路由 ----------
function showTab(name) {
  currentTab = name;
  var tabs = document.querySelectorAll("section.tab");
  for (var i = 0; i < tabs.length; i++) tabs[i].classList.remove("on");
  var target = $("tab-" + name);
  if (target) target.classList.add("on");
  var links = document.querySelectorAll("#nav a");
  for (var j = 0; j < links.length; j++) {
    links[j].classList.toggle("on", links[j].getAttribute("data-tab") === name);
  }
  if (name === "overview") loadOverview();
  else if (name === "users") loadUsers();
  else if (name === "payments") loadPayments();
  else if (name === "messages") loadMessages();
  else if (name === "feedback") loadFeedback();
}

// ---------- 概览（业务：用户 / 站内信 / 支付 / 反馈 / 设备） ----------
function statCard(n, label) {
  return '<div class="stat"><b>' + n + "</b><span>" + label + "</span></div>";
}

function kpiCard(n, label, sub) {
  return '<div class="stat"><b>' + n + "</b><span>" + label +
    '</span><div class="stat-sub">' + esc(sub) + "</div></div>";
}

function barChart(series, color) {
  var max = 1;
  series.forEach(function (s) { if (s.count > max) max = s.count; });
  var bars = series.map(function (s) {
    var h = Math.max(2, Math.round((s.count / max) * 110));
    return '<div class="bar-col" title="' + esc(s.day) + '：' + s.count + '">' +
      '<div class="bar-v" style="height:' + h + 'px;background:' + color + '"></div>' +
      '<div class="bar-label">' + esc(s.day.slice(5)) + "</div></div>";
  }).join("");
  return '<div class="bars">' + bars + "</div>";
}

function loadOverview() {
  var body = $("overviewBody");
  api("/api/admin/overview").then(function (r) { return r.json().then(function (j) { return { code: r.status, j: j }; }); })
    .then(function (res) {
      if (res.code === 401) throw new Error("需要管理员 Token（左侧输入后自动重试）");
      if (res.j.ok !== true) throw new Error("概览接口异常");
      var d = res.j;
      var html = '<div class="stats">' +
        kpiCard(d.users.total, "注册用户", "今日 +" + d.users.newToday + " · 7 日 +" + d.users.new7d) +
        (d.messages
          ? kpiCard(d.messages.messages, "站内信", "今日 " + d.messages.today + " · 发出 " + d.messages.outbound)
          : kpiCard("-", "站内信", "未启用")) +
        (d.orders
          ? kpiCard(d.orders.total, "支付订单", "已付 " + d.orders.paid + " · 待付 " + d.orders.pending + " · 关闭 " + d.orders.closed)
          : kpiCard("-", "支付订单", "未启用")) +
        (d.orders
          ? kpiCard("¥" + d.orders.paidAmount, "收入", d.orders.paid + " 笔已支付")
          : "") +
        "</div>";
      html += '<div class="grid2" style="margin-bottom:12px">' +
        '<div class="card"><div class="card-title">注册趋势（近 14 天）</div>' + barChart(d.users.series, "#3b82f6") + "</div>" +
        '<div class="card"><div class="card-title">站内信趋势（近 14 天）</div>' +
        (d.messages ? barChart(d.messages.series, "#16a34a") : '<div class="meta">未启用</div>') +
        "</div></div>";
      html += '<div class="stats">' +
        statCard(d.feedback.open, "反馈 · 待处理") +
        statCard(d.feedback.processing, "反馈 · 处理中") +
        statCard(d.feedback.resolved, "反馈 · 已解决") +
        "</div>";
      html += '<div class="meta">服务器：运行 ' + fmtUptime(d.server.uptimeMs) + " · 内存 " +
        fmtBytes(d.server.rssBytes) + " · " + esc(d.server.nodeVersion) + " · " + esc(d.server.platform) + "</div>";
      body.innerHTML = html;
    })
    .catch(function (e) {
      body.innerHTML = '<div class="empty">加载失败：' + esc(e.message) + "</div>";
      showErr(e.message);
    });
}

// ---------- 反馈管理 ----------
function loadFeedback() {
  clearErr();
  api("/api/feedback?limit=200").then(function (r) { return r.json(); }).then(function (data) {
    if (data.ok !== true) throw new Error("接口返回异常");
    allFeedback = data.items || [];
    renderFbStats();
    renderFbList();
  }).catch(function (e) {
    $("fbList").innerHTML = "";
    showErr("反馈加载失败：" + e.message);
  });
}

function renderFbStats() {
  var c = { open: 0, processing: 0, resolved: 0 };
  allFeedback.forEach(function (r) { if (c[r.status] != null) c[r.status]++; });
  $("fbStats").innerHTML =
    statCard(c.open, "待处理") + statCard(c.processing, "处理中") +
    statCard(c.resolved, "已解决") + statCard(allFeedback.length, "全部");
}

function filteredFeedback() {
  var kw = $("fbKw").value.trim().toLowerCase();
  var type = $("fbTypeSel").value;
  return allFeedback.filter(function (r) {
    if (fbStatusFilter && r.status !== fbStatusFilter) return false;
    if (type && r.type !== type) return false;
    if (kw) {
      var hay = (r.title + " " + r.description + " " + r.actorId + " " + (r.contact || "")).toLowerCase();
      if (hay.indexOf(kw) < 0) return false;
    }
    return true;
  });
}

function renderFbList() {
  var items = filteredFeedback();
  if (!items.length) {
    $("fbList").innerHTML = '<div class="empty">没有符合条件的反馈</div>';
    return;
  }
  $("fbList").innerHTML = items.map(function (r) {
    var h = '<div class="card"><div class="head"><h3>' + esc(r.title) + "</h3>" +
      chip(r.type, TYPE_LABELS[r.type] || r.type) + chip(r.status, STATUS_LABELS[r.status] || r.status) + "</div>";
    h += '<div class="meta">#' + esc(r.id) + " · " + esc(r.actorId) + " · " + fmtTime(r.createdAt) +
      (r.contact ? " · 联系方式：" + esc(r.contact) : "") + "</div>";
    h += '<div class="desc">' + esc(r.description) + "</div>";
    var diagKeys = Object.keys(r.diagnostics || {});
    if (diagKeys.length) {
      h += '<details class="diag"><summary>诊断信息</summary><table>' + diagKeys.map(function (k) {
        return "<tr><td>" + esc(k) + '</td><td class="kv-val">' + esc(r.diagnostics[k]) + "</td></tr>";
      }).join("") + "</table></details>";
    }
    h += '<div class="replybox">';
    if (r.replyNote) h += '<div class="existing">已回复：' + esc(r.replyNote) + "</div>";
    h += '<textarea id="note-' + esc(r.id) + '" rows="2" placeholder="回复说明（随状态一并保存，用户端可见）">' +
      esc(r.replyNote || "") + "</textarea>";
    h += '<div class="actions">' + STATUS_FLOW.map(function (f) {
      return '<button class="' + f.cls + '" data-act="fb-status" data-id="' + esc(r.id) +
        '" data-status="' + f.status + '">' + f.label + "</button>";
    }).join("") + '<span class="saved" id="saved-' + esc(r.id) + '"></span></div>';
    h += "</div></div>";
    return h;
  }).join("");
}

function updateFeedbackStatus(id, status) {
  var note = $("note-" + id).value.trim();
  api("/api/feedback/" + encodeURIComponent(id) + "/status", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status: status, replyNote: note })
  }).then(function (r) { return r.json(); }).then(function (data) {
    if (data.ok !== true) throw new Error(data.message || "更新失败");
    loadFeedback();
  }).catch(function (e) { showErr("反馈更新失败：" + e.message); });
}

// ---------- 用户 ----------
function loadUsers() {
  clearErr();
  var body = $("usersBody");
  api("/api/admin/users").then(function (r) { return r.json().then(function (j) { return { code: r.status, j: j }; }); })
    .then(function (res) {
      if (res.code === 401) throw new Error("需要管理员 Token（左侧输入后重试）");
      var s = res.j.stats || {};
      var html = '<div class="stats">' +
        statCard(s.total, "注册用户") +
        statCard("+" + (s.newToday || 0), "今日新增") +
        statCard("+" + (s.new7d || 0), "近 7 日新增") +
        "</div>";
      html += '<div class="card" style="margin-bottom:12px"><div class="card-title">注册趋势（近 30 天）</div>' +
        barChart(s.series || [], "#3b82f6") + "</div>";
      var users = res.j.users || [];
      if (!users.length) {
        html += '<div class="card"><div class="empty">还没有注册用户。客户端注册账号后会出现在这里。</div></div>';
      } else {
        var rows = users.map(function (u) {
          return "<tr>" +
            "<td>" + esc(u.displayName || "-") + "</td>" +
            '<td class="wrap">' + esc(u.userId) + "</td>" +
            "<td>" + esc(u.email || "-") + "</td>" +
            "<td>" + (u.setupComplete ? chip("ok", "已初始化") : chip("other", "未完成")) + "</td>" +
            "<td>" + fmtTime(u.createdAt) + "</td>" +
            "</tr>";
        }).join("");
        html += '<div class="card"><table><tr>' +
          "<th>显示名</th><th>身份 ID</th><th>邮箱</th><th>状态</th><th>注册时间</th>" +
          "</tr>" + rows + "</table></div>";
      }
      body.innerHTML = html;
    })
    .catch(function (e) {
      body.innerHTML = '<div class="empty">加载失败：' + esc(e.message) + "</div>";
    });
}

// ---------- 支付 ----------
function loadPayments() {
  clearErr();
  var body = $("paymentsBody");
  api("/api/admin/orders").then(function (r) { return r.json().then(function (j) { return { code: r.status, j: j }; }); })
    .then(function (res) {
      if (res.code === 401) throw new Error("需要管理员 Token（左侧输入后重试）");
      if (res.j.enabled !== true) {
        body.innerHTML = '<div class="card"><div class="empty">支付服务未启用</div></div>';
        return;
      }
      var s = res.j.stats || {};
      var html = '<div class="stats">' +
        statCard(s.total, "总订单（付费意愿）") +
        statCard(s.paid, "已支付") +
        statCard(s.pending, "待支付") +
        statCard("¥" + s.paidAmount, "收入") +
        "</div>";
      var orders = res.j.orders || [];
      if (!orders.length) {
        html += '<div class="card"><div class="empty">还没有支付订单。</div></div>';
      } else {
        var statusChip = function (st) {
          var cls = st === "paid" ? "ok" : (st === "pending" ? "open" : "offline");
          return chip(cls, st === "paid" ? "已支付" : (st === "pending" ? "待支付" : (st === "closed" ? "已关闭" : st)));
        };
        var rows = orders.map(function (o) {
          return "<tr>" +
            '<td class="wrap">' + esc(o.outTradeNo) + "</td>" +
            "<td>" + esc(o.provider) + " / " + esc(o.method) + "</td>" +
            "<td>¥" + o.amount + "</td>" +
            '<td class="wrap">' + esc(o.description || "-") + "</td>" +
            "<td>" + statusChip(o.status) + "</td>" +
            "<td>" + fmtTime(o.createdAt) + "</td>" +
            "</tr>";
        }).join("");
        html += '<div class="card"><table><tr>' +
          "<th>商户单号</th><th>渠道 / 方式</th><th>金额</th><th>描述</th><th>状态</th><th>创建时间</th>" +
          "</tr>" + rows + "</table></div>";
      }
      body.innerHTML = html;
    })
    .catch(function (e) {
      body.innerHTML = '<div class="empty">加载失败：' + esc(e.message) + "</div>";
    });
}

// ---------- 站内信 ----------
function loadMessages() {
  clearErr();
  var body = $("messagesBody");
  api("/api/admin/messages").then(function (r) { return r.json().then(function (j) { return { code: r.status, j: j }; }); })
    .then(function (res) {
      if (res.code === 401) throw new Error("需要管理员 Token（左侧输入后重试）");
      if (res.j.enabled !== true) {
        body.innerHTML = '<div class="card"><div class="empty">消息聚合中心未启用</div></div>';
        return;
      }
      var s = res.j.stats;
      var html = "";
      if (s) {
        html += '<div class="stats">' +
          statCard(s.messages, "消息总量") +
          statCard(s.today, "今日消息") +
          statCard(s.outbound, "发出") +
          statCard(s.inbound, "收到") +
          "</div>";
        html += '<div class="card" style="margin-bottom:12px"><div class="card-title">消息趋势（近 14 天）</div>' +
          barChart(s.series || [], "#16a34a") + "</div>";
      }
      var platforms = res.j.byPlatform || [];
      html += '<div class="card" style="margin-bottom:12px"><div class="card-title">平台分布</div>';
      html += platforms.length
        ? "<table><tr><th>平台</th><th>会话数</th><th>消息数</th></tr>" + platforms.map(function (p) {
            return "<tr><td>" + esc(p.platform) + "</td><td>" + p.conversations + "</td><td>" + p.messages + "</td></tr>";
          }).join("") + "</table>"
        : '<div class="meta">暂无会话数据</div>';
      html += "</div>";
      var recent = res.j.recent || [];
      html += '<div class="card"><div class="card-title">最近消息</div>';
      html += recent.length
        ? '<table style="margin-top:6px"><tr><th>时间</th><th>平台</th><th>方向</th><th>身份</th><th>内容</th></tr>' +
          recent.map(function (m) {
            var preview = m.text.length > 40 ? m.text.slice(0, 40) + "…" : m.text;
            return "<tr>" +
              "<td>" + fmtTime(m.createdAt) + "</td>" +
              "<td>" + esc(m.platform) + "</td>" +
              "<td>" + (m.direction === "outbound" ? "发出" : "收到") + "</td>" +
              "<td>" + esc(m.actorId) + "</td>" +
              '<td class="wrap">' + esc(preview) + "</td>" +
              "</tr>";
          }).join("") + "</table>"
        : '<div class="empty">暂无消息</div>';
      html += "</div>";
      body.innerHTML = html;
    })
    .catch(function (e) {
      body.innerHTML = '<div class="empty">加载失败：' + esc(e.message) + "</div>";
    });
}

// ---------- 事件委托与初始化 ----------
document.addEventListener("click", function (ev) {
  var el = ev.target.closest ? ev.target.closest("[data-act]") : null;
  if (!el) return;
  var act = el.getAttribute("data-act");
  var id = el.getAttribute("data-id") || "";
  if (act === "fb-status") updateFeedbackStatus(id, el.getAttribute("data-status"));
});

$("nav").addEventListener("click", function (ev) {
  var a = ev.target.closest ? ev.target.closest("a[data-tab]") : null;
  if (!a) return;
  ev.preventDefault();
  var tab = a.getAttribute("data-tab");
  if (location.hash !== "#" + tab) location.hash = "#" + tab;
  else showTab(tab);
});

$("adminToken").addEventListener("change", function () {
  localStorage.setItem("pa_admin_token", $("adminToken").value.trim());
});
$("adminToken").value = localStorage.getItem("pa_admin_token") || "";

$("fbStatusSeg").addEventListener("click", function (ev) {
  var btn = ev.target.closest ? ev.target.closest("button") : null;
  if (!btn) return;
  fbStatusFilter = btn.getAttribute("data-v");
  var all = $("fbStatusSeg").querySelectorAll("button");
  for (var i = 0; i < all.length; i++) all[i].classList.toggle("on", all[i] === btn);
  renderFbList();
});
$("fbTypeSel").addEventListener("change", renderFbList);
$("fbKw").addEventListener("input", renderFbList);
$("fbRefresh").addEventListener("click", loadFeedback);

var segOpts = [
  { v: "", l: "全部" }, { v: "open", l: "待处理" },
  { v: "processing", l: "处理中" }, { v: "resolved", l: "已解决" }
];
$("fbStatusSeg").innerHTML = segOpts.map(function (o) {
  return '<button data-v="' + o.v + '"' + (o.v === "" ? ' class="on"' : "") + ">" + o.l + "</button>";
}).join("");

var initTab = (location.hash || "#overview").slice(1);
if (!document.getElementById("tab-" + initTab)) initTab = "overview";
showTab(initTab);
window.addEventListener("hashchange", function () {
  var tab = (location.hash || "#overview").slice(1);
  if (document.getElementById("tab-" + tab) && tab !== currentTab) showTab(tab);
});
</script>
</body>
</html>`;
}
