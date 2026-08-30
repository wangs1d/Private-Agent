import { createServer } from "http";
import { readFile } from "fs/promises";
import { join, extname } from "path";

const ROOT = "D:/ws-project/Private-Agent/server/web";
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".woff2": "font/woff2",
};

// 与 server/src/routes/http/chat-web.ts 相同的映射规则
function resolveChatPath(urlPath) {
  if (urlPath === "/" || urlPath === "/chat" || urlPath === "/chat/") {
    return "chat/index.html";
  }
  if (urlPath.startsWith("/chat/assets/avatar/")) {
    return "chat" + urlPath.slice("/chat/assets".length); // chat/assets/avatar/...
  }
  if (urlPath.startsWith("/chat/assets/")) {
    return "chat/" + urlPath.slice("/chat/assets/".length); // chat/app.js 等
  }
  return urlPath.replace(/^\/+/, "");
}

// 注入 WebSocket 桩：拦截页面真实 WS 连接，并暴露 __dispatch 便于从外部
// 注入模拟服务端事件（走 app.js 真实的事件处理路径渲染 UI）。
const WS_STUB = `<script>
  (function () {
    window.__pageErrors = [];
    window.addEventListener("error", function (e) {
      window.__pageErrors.push(String(e.message) + " @" + String(e.filename || "") + ":" + String(e.lineno || ""));
    });
    window.addEventListener("unhandledrejection", function (e) {
      window.__pageErrors.push("rejection: " + String(e.reason));
    });
    class FakeWS extends EventTarget {
      constructor(url) {
        super();
        this.url = url;
        this.readyState = 1;
        FakeWS.instances.push(this);
        setTimeout(() => this.dispatchEvent(new Event("open")), 30);
      }
      send(data) { (window.__wsSent = window.__wsSent || []).push(data); }
      close() { this.readyState = 3; }
    }
    FakeWS.instances = [];
    FakeWS.CONNECTING = 0;
    FakeWS.OPEN = 1;
    FakeWS.CLOSING = 2;
    FakeWS.CLOSED = 3;
    window.WebSocket = FakeWS;
    window.__dispatch = function (type, payload) {
      const data = JSON.stringify({ type, payload });
      for (const ws of FakeWS.instances) {
        ws.dispatchEvent(new MessageEvent("message", { data }));
      }
    };
  })();
</script>`;

createServer(async (req, res) => {
  try {
    const urlPath = decodeURIComponent((req.url ?? "/").split("?")[0]);
    const rel = resolveChatPath(urlPath);
    // content-summary-card.js 在仓库里是 TypeScript 源码（浏览器无法解析，
    // 会导致整页模块图崩溃——线上同样存在此问题）；截图环境改用等价 JS 垫片。
    const shimPath = rel.endsWith("content-summary-card.js")
      ? "D:/ws-project/Private-Agent/tmp/content-summary-card.shim.js"
      : null;
    let file = await readFile(shimPath ?? join(ROOT, rel));
    if (extname(rel) === ".html") {
      let html = file.toString("utf8");
      html = html.replace("</head>", `${WS_STUB}\n</head>`);
      file = Buffer.from(html, "utf8");
    }
    const headers = { "content-type": MIME[extname(rel)] ?? "application/octet-stream", "cache-control": "no-store" };
    res.writeHead(200, headers);
    res.end(file);
  } catch {
    res.writeHead(404);
    res.end("not found");
  }
}).listen(8793, "127.0.0.1", () => console.log("serving on http://127.0.0.1:8793"));
