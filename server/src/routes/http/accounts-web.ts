import type { FastifyInstance } from "fastify";

/**
 * 网页端注册/登录页（桌面端「立即登录」跳转目标）。
 *
 * - GET /accounts/web?cb=<回连地址>&state=<随机串>   登录页（黑白极简，零外部资源）
 *
 * 背景：服务端账号体系本就按邮箱幂等建档（无密码），「注册」「登录」在
 * /accounts/register 上是同一动作（重复注册返回「已存在」，客户端视为成功）。
 * 本页收集邮箱 → 调注册接口 → 302/跳转回桌面端的本机回环地址（cb），
 * 桌面端从回调 query 里取邮箱落盘会话，完成「网页登录 → 客户端进主界面」闭环。
 * cb 只允许本机回环地址，防止页面被当成任意跳板。
 */
export function registerAccountWebRoutes(app: FastifyInstance): void {
  app.get("/accounts/web", async (_request, reply) => {
    reply.type("text/html; charset=utf-8").send(renderAccountWebPage());
  });
}

function renderAccountWebPage(): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>NEXTBOT — 登录</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { height: 100%; }
  body {
    background: #000;
    display: flex;
    align-items: center;
    justify-content: center;
    font-family: "Noto Sans SC", "Microsoft YaHei UI", sans-serif;
    -webkit-font-smoothing: antialiased;
    padding: 24px;
  }
  .card {
    width: 400px;
    max-width: 100%;
    background: #141414;
    border: 1px solid #232323;
    border-radius: 24px;
    padding: 44px 44px 36px;
  }
  .brand { font-size: 13px; font-weight: 700; letter-spacing: 3.2px; color: #F2F2F2; }
  h1 { margin-top: 26px; font-size: 28px; font-weight: 700; line-height: 1.3; color: #F2F2F2; }
  .sub { margin-top: 10px; font-size: 14px; line-height: 1.6; color: #9B9B9B; }
  label { display: block; margin-top: 32px; font-size: 13px; font-weight: 600; color: #F2F2F2; }
  input {
    margin-top: 8px; width: 100%; height: 48px;
    background: #101010; border: 1px solid #3D3D3D; border-radius: 10px;
    padding: 0 16px; font-size: 14px; color: #F2F2F2; outline: none;
    font-family: inherit;
  }
  input:focus { border-color: #E8E8E8; }
  input::placeholder { color: #6B6B6B; }
  button {
    margin-top: 28px; width: 100%; height: 48px;
    background: #FFFFFF; color: #0A0A0A; border: none; border-radius: 24px;
    font-size: 15px; font-weight: 600; cursor: pointer; font-family: inherit;
  }
  button:disabled { background: #2E2E2E; color: #9B9B9B; cursor: default; }
  #msg { margin-top: 14px; font-size: 12px; line-height: 1.5; color: #9B9B9B; min-height: 18px; }
  #msg.err { color: #F2604E; }
  #msg.ok { color: #F2F2F2; }
  .hidden { display: none; }
</style>
</head>
<body>
  <div class="card">
    <div class="brand">NEXTBOT</div>
    <h1>登录 NEXTBOT 桌面端</h1>
    <p class="sub">输入邮箱继续，新邮箱将自动创建账号。</p>
    <form id="f" autocomplete="on">
      <label for="email">邮箱</label>
      <input id="email" name="email" type="email" placeholder="you@example.com" autofocus>
      <button id="btn" type="submit">注册 / 登录</button>
      <p id="msg"></p>
    </form>
    <p id="notice" class="sub hidden">本页面需要从桌面应用的登录窗口发起，请回到应用点击「立即登录」。</p>
  </div>
  <script>
    var qs = new URLSearchParams(location.search);
    var cb = qs.get("cb") || "";
    var state = qs.get("state") || "";
    var msg = document.getElementById("msg");
    var form = document.getElementById("f");
    var btn = document.getElementById("btn");
    var emailInput = document.getElementById("email");

    // 只允许回连本机回环地址：页面不充当任意域的跳板
    function cbAllowed(u) {
      return u.indexOf("http://127.0.0.1:") === 0
        || u.indexOf("http://localhost:") === 0
        || u.indexOf("http://[::1]:") === 0;
    }

    if (!cb || !state || !cbAllowed(cb)) {
      form.classList.add("hidden");
      document.getElementById("notice").classList.remove("hidden");
    }

    function setMsg(text, kind) {
      msg.textContent = text;
      msg.className = kind || "";
    }

    form.addEventListener("submit", function (ev) {
      ev.preventDefault();
      var email = emailInput.value.trim();
      if (!/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(email)) {
        setMsg("请输入有效的邮箱地址", "err");
        return;
      }
      btn.disabled = true;
      setMsg("提交中…", "");
      fetch("/accounts/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId: email,
          displayName: email.split("@")[0],
          email: email
        })
      }).then(function (res) {
        return res.json().then(function (data) {
          var ok = res.status === 200 && data && data.ok === true;
          // 幂等：已存在账号视为登录成功
          var dup = data && typeof data.message === "string" && data.message.indexOf("已存在") >= 0;
          if (!ok && !dup) {
            throw new Error((data && data.message) || "登录失败，请稍后重试");
          }
          return;
        });
      }).then(function () {
        setMsg("成功，正在回连桌面端…", "ok");
        var sep = cb.indexOf("?") >= 0 ? "&" : "?";
        window.location.href = cb + sep + "state=" + encodeURIComponent(state)
          + "&email=" + encodeURIComponent(email);
      }).catch(function (e) {
        setMsg(e && e.message ? e.message : "登录失败，请稍后重试", "err");
        btn.disabled = false;
      });
    });
  </script>
</body>
</html>`;
}
