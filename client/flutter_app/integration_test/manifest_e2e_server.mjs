// 检查更新真机 E2E 用的本地 manifest 假服务：GET /api/client/manifest
// 按 manifest_state.json 的 mode 字段返回状态（A=已是最新 / B=发现新版 /
// C=500 失败 / E=发现新版且 url 指向本地真下载端点）。改状态文件即生效，
// 无需重启服务。
//
// E 模式配套 GET/HEAD /downloads/fake-setup.exe：吐 ~12MB 真实字节
// （含 Content-Length），供应用内下载流程的真机链路取证（流式进度、
// .part→成品改名、downloaded 态）。重启安装腿（exit→静默装→拉起）不在
// E2E 内点，需真实安装包在发版时人工闭环。
import http from "node:http";
import { readFileSync, writeFileSync } from "node:fs";

const STATE = "C:/Users/Administrator/AppData/Local/Temp/manifest_e2e_state.json";

// 12MB 伪安装包：回环下载毫秒级完成，但足以驱动真实流式分块
const FAKE_SETUP = Buffer.alloc(12 * 1024 * 1024, 0x4e); // 'N'

function state() {
  try {
    return JSON.parse(readFileSync(STATE, "utf8"));
  } catch {
    return { mode: "A" };
  }
}

function manifestFor(mode) {
  if (mode === "B" || mode === "E") {
    return {
      latest: "9.9.9",
      minVersion: "0.0.1",
      url: mode === "E"
        ? "http://127.0.0.1:18500/downloads/fake-setup.exe"
        : "https://example.com/download/Nextbot-Setup-9.9.9.exe",
      notes: "真机 E2E 测试版本说明：验证发现新版本浮卡。",
      channel: "byok",
    };
  }
  // F：本地版本低于 minVersion → forcedUpdate → 不可关闭的强锁升级弹窗
  if (mode === "F") {
    return {
      latest: "9.9.9",
      minVersion: "99.0.0",
      url: "https://example.com/download/Nextbot-Setup-9.9.9.exe",
      notes: "",
      channel: "byok",
    };
  }
  // A：与本地版本相同 → upToDate
  return {
    latest: "0.2.0",
    minVersion: "0.0.1",
    url: "https://example.com/download/Nextbot-Setup-0.2.0.exe",
    notes: "",
    channel: "byok",
  };
}

const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url.startsWith("/api/client/manifest")) {
    const { mode } = state();
    if (mode === "C") {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "e2e-simulated-failure" }));
      console.log(`[${new Date().toISOString()}] mode=C -> 500`);
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(manifestFor(mode)));
    console.log(`[${new Date().toISOString()}] mode=${mode} -> manifest`);
    return;
  }
  if (
    (req.method === "GET" || req.method === "HEAD") &&
    req.url.startsWith("/downloads/fake-setup.exe")
  ) {
    res.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "Content-Length": FAKE_SETUP.length,
    });
    res.end(req.method === "HEAD" ? undefined : FAKE_SETUP);
    console.log(`[${new Date().toISOString()}] ${req.method} fake-setup.exe`);
    return;
  }
  res.writeHead(404);
  res.end();
});

writeFileSync(STATE, JSON.stringify({ mode: "A" }));
server.listen(18500, "127.0.0.1", () =>
  console.log("manifest e2e server on http://127.0.0.1:18500"),
);
