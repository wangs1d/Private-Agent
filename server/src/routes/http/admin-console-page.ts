/**
 * 管理控制台页面（管理员）：自包含 HTML，无外部依赖。
 *
 * 左侧导航 + 七个标签：概览 / 用户 / 支付 / 站内信 / 反馈管理 / 下载分发 / 系统。
 * 数据接口：反馈提交与「我的反馈」走开放接口；全量反馈、状态流转与所有
 * /api/admin/* 管理接口带 x-admin-token（localStorage 保存）。
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
  nav { margin-top: 12px; flex: 1; overflow-y: auto; }
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
  .btn.small { padding: 2px 10px; font-size: 12px; }
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
  .chip.warn { background: #fef3c7; color: #d97706; }
  .chip.info { background: #e0f2fe; color: #0369a1; }
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
    <a href="#downloads" data-tab="downloads">下载分发</a>
    <a href="#system" data-tab="system">系统</a>
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
    <div class="sub">用户增长 · 站内信 · 支付收入 · 反馈 · 服务器</div>
    <div id="overviewBody"><div class="empty">加载中…</div></div>
  </section>

  <section class="tab" id="tab-users">
    <h1>用户</h1>
    <div class="sub">注册数据 · 搜索 · 禁用/恢复（禁用后该用户无法继续对话）</div>
    <div class="toolbar">
      <input type="search" id="userKw" placeholder="搜索显示名 / 身份 ID / 邮箱">
      <button class="btn primary" id="userRefresh">刷新</button>
    </div>
    <div id="usersBody"><div class="empty">加载中…</div></div>
  </section>

  <section class="tab" id="tab-payments">
    <h1>支付</h1>
    <div class="sub">付费意愿（下单量）与收入（已支付金额）· 模拟/真实订单拆分</div>
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

  <section class="tab" id="tab-downloads">
    <h1>下载分发</h1>
    <div class="sub">桌面应用安装包管理：上传 / 列表 / 下架（客户端从 /downloads/ 下载）</div>
    <div class="toolbar">
      <input type="file" id="dlFile" style="display:none">
      <button class="btn primary" id="dlUploadBtn">上传安装包</button>
      <span class="meta" id="dlUploadHint">支持 .exe .zip .dmg .msi .apk .tar.gz .deb .rpm，同名覆盖</span>
      <button class="btn" id="dlRefresh">刷新</button>
    </div>
    <div id="dlList"><div class="empty">加载中…</div></div>
  </section>

  <section class="tab" id="tab-system">
    <h1>系统</h1>
    <div class="sub">运行状态 · 存储占用 · 依赖探活 · 服务配置 · 管理操作审计</div>
    <div id="systemBody"><div class="empty">加载中…</div></div>
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
var allUsers = [];
var allDownloads = [];
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
  else if (name === "downloads") loadDownloads();
  else if (name === "system") loadSystem();
}

// ---------- 通用小组件 ----------
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

// ---------- 概览 ----------
function loadOverview() {
  var body = $("overviewBody");
  api("/api/admin/overview").then(function (r) { return r.json().then(function (j) { return { code: r.status, j: j }; }); })
    .then(function (res) {
      if (res.code === 401) throw new Error("需要管理员 Token（左侧输入后自动重试）");
      if (res.code === 503) throw new Error("ADMIN_UPLOAD_TOKEN 未配置，管理接口已锁定（部署侧设置环境变量后重启）");
      if (res.j.ok !== true) throw new Error("概览接口异常");
      var d = res.j;
      var html = '<div class="stats">' +
        kpiCard(d.users.total, "注册用户", "今日 +" + d.users.newToday + " · 7 日 +" + d.users.new7d +
          (d.users.disabled ? " · 禁用 " + d.users.disabled : "")) +
        (d.messages
          ? kpiCard(d.messages.messages, "站内信", "今日 " + d.messages.today + " · 发出 " + d.messages.outbound)
          : kpiCard("-", "站内信", "未启用")) +
        (d.orders
          ? kpiCard(d.orders.total, "支付订单", "已付 " + d.orders.paid + " · 待付 " + d.orders.pending +
            " · 关闭 " + d.orders.closed + (d.orders.refunded ? " · 退款 " + d.orders.refunded : ""))
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
        fmtBytes(d.server.rssBytes) + " · " + esc(d.server.nodeVersion) + " · " + esc(d.server.platform) +
        ' · <a href="#system">详细状态 →</a></div>';
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
  api("/api/feedback?limit=500").then(function (r) { return r.json(); }).then(function (data) {
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
    statCard(c.resolved, "已解决") + statCard(allFeedback.length, "当前加载");
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
      if (res.code === 503) throw new Error("ADMIN_UPLOAD_TOKEN 未配置，管理接口已锁定");
      allUsers = res.j.users || [];
      var s = res.j.stats || {};
      var html = '<div class="stats">' +
        statCard(s.total, "注册用户") +
        statCard("+" + (s.newToday || 0), "今日新增") +
        statCard("+" + (s.new7d || 0), "近 7 日新增") +
        (s.disabled ? statCard(s.disabled, "已禁用") : "") +
        "</div>";
      html += '<div class="card" style="margin-bottom:12px"><div class="card-title">注册趋势（近 30 天）</div>' +
        barChart(s.series || [], "#3b82f6") + "</div>";
      html += '<div id="userTableWrap"></div>';
      body.innerHTML = html;
      renderUserTable();
    })
    .catch(function (e) {
      body.innerHTML = '<div class="empty">加载失败：' + esc(e.message) + "</div>";
    });
}

function filteredUsers() {
  var kw = ($("userKw") ? $("userKw").value.trim() : "").toLowerCase();
  if (!kw) return allUsers;
  return allUsers.filter(function (u) {
    var hay = ((u.displayName || "") + " " + u.userId + " " + (u.email || "")).toLowerCase();
    return hay.indexOf(kw) >= 0;
  });
}

function renderUserTable() {
  var wrap = $("userTableWrap");
  if (!wrap) return;
  var users = filteredUsers();
  if (!allUsers.length) {
    wrap.innerHTML = '<div class="card"><div class="empty">还没有注册用户。客户端注册账号后会出现在这里。</div></div>';
    return;
  }
  if (!users.length) {
    wrap.innerHTML = '<div class="card"><div class="empty">没有匹配的用户</div></div>';
    return;
  }
  var rows = users.map(function (u) {
    var statusChip = u.disabled ? chip("bad", "已禁用") : (u.setupComplete ? chip("ok", "正常") : chip("other", "未完成初始化"));
    var toggleBtn = u.disabled
      ? '<button class="btn small" data-act="user-toggle" data-user="' + esc(u.userId) + '" data-disabled="0">恢复启用</button>'
      : '<button class="btn small danger" data-act="user-toggle" data-user="' + esc(u.userId) + '" data-disabled="1">禁用</button>';
    return "<tr" + (u.disabled ? ' style="opacity:.55"' : "") + ">" +
      "<td>" + esc(u.displayName || "-") + "</td>" +
      '<td class="wrap">' + esc(u.userId) + "</td>" +
      "<td>" + esc(u.email || "-") + "</td>" +
      "<td>" + statusChip + "</td>" +
      "<td>" + fmtTime(u.createdAt) + "</td>" +
      "<td>" + toggleBtn + "</td>" +
      "</tr>";
  }).join("");
  wrap.innerHTML = '<div class="card"><table><tr>' +
    "<th>显示名</th><th>身份 ID</th><th>邮箱</th><th>状态</th><th>注册时间</th><th>操作</th>" +
    "</tr>" + rows + "</table></div>";
}

function toggleUser(userId, disable) {
  var verb = disable ? "禁用" : "恢复启用";
  if (!confirm("确定要" + verb + "用户 " + userId + " 吗？" +
    (disable ? "禁用后该用户将无法继续与 Agent 对话。" : ""))) return;
  api("/api/admin/users/" + encodeURIComponent(userId) + "/disabled", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ disabled: !!disable })
  }).then(function (r) { return r.json().then(function (j) { return { code: r.status, j: j }; }); })
    .then(function (res) {
      if (res.code !== 200 || res.j.ok !== true) throw new Error(res.j.message || "操作失败");
      loadUsers();
    })
    .catch(function (e) { showErr(verb + "失败：" + e.message); });
}

// ---------- 支付 ----------
function orderStatusChip(st) {
  if (st === "paid") return chip("ok", "已支付");
  if (st === "pending") return chip("open", "待支付");
  if (st === "closed") return chip("offline", "已关闭");
  if (st === "refunded") return chip("info", "已退款");
  return chip("offline", st || "-");
}

function modeChip(mode) {
  return mode === "live" ? chip("online", "真实") : chip("other", "模拟");
}

function modeStatsLine(m) {
  if (!m) return "-";
  return m.total + " 笔 · 已付 " + m.paid + " · ¥" + m.paidAmount;
}

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
      var mock = (s.byMode && s.byMode.mock) || null;
      var live = (s.byMode && s.byMode.live) || null;
      var html = '<div class="stats">' +
        statCard(s.total, "总订单（付费意愿）") +
        statCard(s.paid, "已支付") +
        statCard("¥" + s.paidAmount, "收入") +
        "</div>";
      html += '<div class="stats">' +
        kpiCard(mock ? mock.total : 0, "模拟订单", modeStatsLine(mock)) +
        kpiCard(live ? live.total : 0, "真实订单（微信/支付宝）", modeStatsLine(live)) +
        "</div>";
      if (live && live.total === 0 && mock && mock.total > 0) {
        html += '<div class="meta" style="margin-bottom:12px">提示：尚无真实订单。渠道侧真实交易的本地状态由客户端轮询回写，' +
          '历史订单需重新查询一次才会进入台账。</div>';
      }
      var orders = res.j.orders || [];
      if (!orders.length) {
        html += '<div class="card"><div class="empty">还没有支付订单。</div></div>';
      } else {
        var rows = orders.map(function (o) {
          return "<tr>" +
            '<td class="wrap">' + esc(o.outTradeNo) + "</td>" +
            "<td>" + esc(o.provider) + " / " + esc(o.method) + "</td>" +
            "<td>" + modeChip(o.mode) + "</td>" +
            "<td>¥" + o.amount + "</td>" +
            '<td class="wrap">' + esc(o.description || "-") + "</td>" +
            "<td>" + orderStatusChip(o.status) + "</td>" +
            "<td>" + fmtTime(o.createdAt) + "</td>" +
            "</tr>";
        }).join("");
        html += '<div class="card"><table><tr>' +
          "<th>商户单号</th><th>渠道 / 方式</th><th>模式</th><th>金额</th><th>描述</th><th>状态</th><th>创建时间</th>" +
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

// ---------- 下载分发 ----------
function loadDownloads() {
  clearErr();
  var body = $("dlList");
  api("/api/admin/downloads/list").then(function (r) { return r.json().then(function (j) { return { code: r.status, j: j }; }); })
    .then(function (res) {
      if (res.code === 401) throw new Error("需要管理员 Token（左侧输入后重试）");
      allDownloads = Array.isArray(res.j) ? res.j : [];
      renderDownloadTable();
    })
    .catch(function (e) {
      body.innerHTML = '<div class="empty">加载失败：' + esc(e.message) + "</div>";
    });
}

function renderDownloadTable() {
  var body = $("dlList");
  if (!allDownloads.length) {
    body.innerHTML = '<div class="card"><div class="empty">还没有安装包。点击上方「上传安装包」发布新版本。</div></div>';
    return;
  }
  var rows = allDownloads.map(function (f) {
    return "<tr>" +
      '<td class="wrap">' + esc(f.name) + "</td>" +
      "<td>" + fmtBytes(f.size) + "</td>" +
      "<td>" + esc(f.modified || "-") + "</td>" +
      '<td><a href="/downloads/' + encodeURIComponent(f.name) + '" target="_blank">下载链接</a></td>' +
      '<td><button class="btn small danger" data-act="dl-delete" data-file="' + esc(f.name) + '">删除</button></td>' +
      "</tr>";
  }).join("");
  body.innerHTML = '<div class="card"><table><tr>' +
    "<th>文件名</th><th>大小</th><th>修改日期</th><th>链接</th><th>操作</th>" +
    "</tr>" + rows + "</table></div>";
}

function uploadDownload(file) {
  var hint = $("dlUploadHint");
  var fd = new FormData();
  fd.append("file", file, file.name);
  hint.textContent = "正在上传 " + file.name + "（" + fmtBytes(file.size) + "）…";
  api("/api/admin/downloads/upload", { method: "POST", body: fd })
    .then(function (r) { return r.json().then(function (j) { return { code: r.status, j: j }; }); })
    .then(function (res) {
      if (res.code !== 200 || res.j.ok !== true) throw new Error(res.j.message || res.j.error || "上传失败");
      hint.textContent = "已发布：" + res.j.file;
      loadDownloads();
    })
    .catch(function (e) {
      hint.textContent = "支持 .exe .zip .dmg .msi .apk .tar.gz .deb .rpm，同名覆盖";
      showErr("上传失败：" + e.message);
    });
}

function deleteDownload(name) {
  if (!confirm("确定要下架并删除 " + name + " 吗？客户端将无法再下载该文件。")) return;
  api("/api/admin/downloads/" + encodeURIComponent(name), { method: "DELETE" })
    .then(function (r) { return r.json().then(function (j) { return { code: r.status, j: j }; }); })
    .then(function (res) {
      if (res.code !== 200 || res.j.ok !== true) throw new Error("删除失败");
      loadDownloads();
    })
    .catch(function (e) { showErr("删除失败：" + e.message); });
}

// ---------- 系统 ----------
function depChip(d) {
  if (!d.configured) return chip("offline", "未配置");
  return d.ok ? chip("online", "正常") : chip("bad", "异常");
}

function loadSystem() {
  clearErr();
  var body = $("systemBody");
  body.innerHTML = '<div class="empty">加载中…</div>';
  Promise.all([
    api("/api/admin/system").then(function (r) { return r.json().then(function (j) { return { code: r.status, j: j }; }); }),
    api("/api/admin/config").then(function (r) { return r.json().then(function (j) { return { code: r.status, j: j }; }); }),
    api("/api/admin/audit?limit=50").then(function (r) { return r.json().then(function (j) { return { code: r.status, j: j }; }); })
  ]).then(function (results) {
    var sys = results[0], cfg = results[1], audit = results[2];
    if (sys.code === 401 || cfg.code === 401) throw new Error("需要管理员 Token（左侧输入后重试）");
    if (sys.j.ok !== true) throw new Error("系统状态接口异常");
    var d = sys.j;

    var html = '<div class="stats">' +
      kpiCard(fmtUptime(d.server.uptimeMs), "运行时长", "PID " + d.server.pid) +
      kpiCard(fmtBytes(d.server.rssBytes), "内存 RSS", "堆 " + fmtBytes(d.server.heapUsedBytes)) +
      kpiCard(fmtBytes(d.storage.dataDir.totalBytes), "data 目录", d.storage.dataDir.entries.length + " 个条目") +
      kpiCard(fmtBytes(d.storage.downloadsDir.bytes), "下载目录", d.storage.downloadsDir.files + " 个文件") +
      "</div>";

    html += '<div class="grid2" style="margin-bottom:12px">';
    html += '<div class="card"><div class="card-title">主机与进程</div>' + kvTable([
      ["主机名", esc(d.os.hostname)],
      ["操作系统", esc(d.server.platform) + " / " + esc(d.server.arch)],
      ["Node 版本", esc(d.server.nodeVersion)],
      ["工作目录", esc(d.server.cwd)],
      ["物理内存", fmtBytes(d.os.totalMemBytes) + "（可用 " + fmtBytes(d.os.freeMemBytes) + "）"],
      ["负载", esc(d.os.loadavg.join(" / "))],
      ["定时任务", d.jobs.total + " 个（待执行 " + d.jobs.pending + " · 已完成 " + d.jobs.completed +
        " · 已取消 " + d.jobs.cancelled + "）" + (d.jobs.nextRunAt ? "，下次 " + fmtTime(d.jobs.nextRunAt) : "")],
      ["账号 / 反馈", d.accounts.total + " 个账号（禁用 " + d.accounts.disabled + "）· 反馈待处理 " + d.feedback.open]
    ]) + "</div>";
    html += '<div class="card"><div class="card-title">存储占用（data 目录明细）</div>';
    var entries = (d.storage.dataDir.entries || []).slice(0, 12);
    html += entries.length
      ? "<table><tr><th>条目</th><th>体积</th><th>文件数</th></tr>" + entries.map(function (e) {
          return "<tr><td>" + esc(e.name) + (e.isDir ? "" : " 📄") + "</td><td>" + fmtBytes(e.bytes) + "</td><td>" +
            (e.isDir ? e.files : "-") + "</td></tr>";
        }).join("") + "</table>"
      : '<div class="meta">data 目录为空</div>';
    html += '<div class="meta" style="margin-top:6px">路径：' + esc(d.storage.dataDir.path) + "</div>";
    html += "</div></div>";

    html += '<div class="card" style="margin-bottom:12px"><div class="card-title">依赖探活</div>' +
      "<table><tr><th>组件</th><th>配置</th><th>状态</th><th>详情</th></tr>" +
      "<tr><td>外部模型</td><td>" + (d.deps.model.configured ? "已配置" : "未配置") + "</td><td>" + depChip(d.deps.model) +
      '</td><td class="wrap">' + esc(d.deps.model.detail) + "</td></tr>" +
      "<tr><td>Redis</td><td>" + (d.deps.redis.configured ? "已配置" : "未配置") + "</td><td>" + depChip(d.deps.redis) +
      '</td><td class="wrap">' + esc(d.deps.redis.detail) + "</td></tr>" +
      "<tr><td>Qdrant（向量库）</td><td>" + (d.deps.qdrant.configured ? "已配置" : "未配置") + "</td><td>" + depChip(d.deps.qdrant) +
      '</td><td class="wrap">' + esc(d.deps.qdrant.detail) + "</td></tr>" +
      "</table></div>";

    if (cfg.j.ok === true) {
      var c = cfg.j;
      html += '<div class="card" style="margin-bottom:12px"><div class="card-title">服务配置</div>' +
        "<table><tr><th>服务</th><th>配置</th></tr>";
      html += "<tr><td>微信支付</td><td>模式 " + esc(c.payment.wechat.mode) +
        " · AppID " + esc(c.payment.wechat.appId || "未配置") +
        " · 商户号 " + esc(c.payment.wechat.mchId || "未配置") +
        " · APIv3 密钥 " + (c.payment.wechat.apiKeySet ? "已设置" : "未设置") +
        " · 商户私钥 " + (c.payment.wechat.privateKeySet ? "已设置" : "未设置") + "</td></tr>";
      html += "<tr><td>支付宝</td><td>模式 " + esc(c.payment.alipay.mode) +
        " · AppID " + esc(c.payment.alipay.appId || "未配置") +
        " · 应用私钥 " + (c.payment.alipay.privateKeySet ? "已设置" : "未设置") +
        " · 支付宝公钥 " + (c.payment.alipay.publicKeySet ? "已设置" : "未设置") + "</td></tr>";
      html += "<tr><td>支付回调</td><td>" + esc(c.payment.notifyBaseUrl || "未配置 PAYMENT_NOTIFY_BASE_URL（live 模式建议配置）") + "</td></tr>";
      html += "<tr><td>外部模型</td><td>" + (c.model.configured
        ? esc(c.model.providerId + " · " + (c.model.model || "默认模型") + " · " + c.model.baseUrl)
        : "未配置") + "</td></tr>";
      html += "<tr><td>Agent 邮箱域</td><td>" + esc(c.mail.agentMailDomain) +
        " · 入站密钥 " + (c.mail.inboundSecretSet ? "已设置" : "未设置") +
        " · 出站 SMTP " + (c.mail.outboundSmtpConfigured
          ? "已配置（" + esc(c.mail.outboundSmtpHost || "") + "）"
          : "未配置") + "</td></tr>";
      html += "<tr><td>下载目录</td><td>" + esc(c.paths.downloadsDir) + "</td></tr>";
      html += "</table></div>";
    }

    var entriesAudit = (audit.j && audit.j.ok === true ? audit.j.entries : []) || [];
    html += '<div class="card"><div class="head"><div class="card-title">管理操作审计（最近 ' + entriesAudit.length + " 条）</div>" +
      '<button class="btn small" data-act="sys-reload">刷新</button></div>';
    html += entriesAudit.length
      ? '<table style="margin-top:6px"><tr><th>时间</th><th>操作</th><th>详情</th><th>来源 IP</th></tr>' +
        entriesAudit.map(function (a) {
          return "<tr>" +
            "<td>" + fmtTime(a.time) + "</td>" +
            "<td>" + esc(a.action) + "</td>" +
            '<td class="wrap">' + esc(JSON.stringify(a.detail || {})) + "</td>" +
            "<td>" + esc(a.ip || "-") + "</td>" +
            "</tr>";
        }).join("") + "</table>"
      : '<div class="empty">暂无审计记录（管理写操作会记录在这里）</div>';
    html += "</div>";

    body.innerHTML = html;
  }).catch(function (e) {
    body.innerHTML = '<div class="empty">加载失败：' + esc(e.message) + "</div>";
    showErr(e.message);
  });
}

// ---------- 事件委托与初始化 ----------
document.addEventListener("click", function (ev) {
  var el = ev.target.closest ? ev.target.closest("[data-act]") : null;
  if (!el) return;
  var act = el.getAttribute("data-act");
  var id = el.getAttribute("data-id") || "";
  if (act === "fb-status") updateFeedbackStatus(id, el.getAttribute("data-status"));
  else if (act === "user-toggle") toggleUser(el.getAttribute("data-user"), el.getAttribute("data-disabled") === "1");
  else if (act === "dl-delete") deleteDownload(el.getAttribute("data-file"));
  else if (act === "sys-reload") loadSystem();
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

$("userKw").addEventListener("input", renderUserTable);
$("userRefresh").addEventListener("click", loadUsers);

$("dlUploadBtn").addEventListener("click", function () { $("dlFile").click(); });
$("dlFile").addEventListener("change", function () {
  var f = this.files && this.files[0];
  if (f) uploadDownload(f);
  this.value = "";
});
$("dlRefresh").addEventListener("click", loadDownloads);

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
