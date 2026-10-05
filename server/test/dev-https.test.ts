/**
 * 本地 HTTPS 双监听测试。
 *
 * 覆盖两件事：
 *   1. dev-tls 证书链生成（根 CA → 服务器证书，SAN 覆盖本机 IP；SAN 变化自动重签）；
 *   2. dev-https 复用 Fastify 实例出 HTTPS 监听：https 路由 200 + wss 握手成功
 *      （upgrade 事件转发是 wss 能走通的关键路径）。
 *
 * 依赖 openssl（dev 机 Git 自带）；找不到 openssl 时整体 skip。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import https from "node:https";

import Fastify from "fastify";
import websocket from "@fastify/websocket";
import WebSocket from "ws";

import { collectLocalHosts, ensureDevTlsCertificate, resolveOpensslBin } from "../src/utils/dev-tls.js";
import { startDevHttpsListener } from "../src/utils/dev-https.js";

const execFileAsync = promisify(execFile);
const logLines: string[] = [];
const log = (line: string) => logLines.push(line);

test("collectLocalHosts: 始终包含 localhost 与回环地址", () => {
  const hosts = collectLocalHosts();
  assert.ok(hosts.dnsNames.includes("localhost"));
  assert.ok(hosts.ips.includes("127.0.0.1"));
});

test("dev-tls: 生成 CA+叶子证书，链可验证，SAN 变化自动重签且 CA 保持不变", async (t) => {
  const bin = await resolveOpensslBin();
  if (!bin) return t.skip("环境无 openssl");
  const dir = await mkdtemp(join(tmpdir(), "dev-tls-"));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }));

  const first = await ensureDevTlsCertificate({ certDir: dir, log });
  assert.ok(first);
  assert.ok(existsSync(join(dir, "ca.crt")));
  assert.ok(existsSync(join(dir, "server.crt")));
  assert.equal(first.caGenerated, true);
  assert.equal(first.leafGenerated, true);
  assert.ok(first.sanString.includes("DNS:localhost"));
  assert.ok(first.sanString.includes("IP:127.0.0.1"));

  // 叶子证书必须能被它自己的根 CA 验过（浏览器信任校验的等价物）
  const verify = await execFileAsync(bin, [
    "verify",
    "-CAfile",
    join(dir, "ca.crt"),
    join(dir, "server.crt"),
  ]);
  assert.match(verify.stdout, /OK/);

  const certBefore = readFileSync(join(dir, "server.crt"), "utf8");
  const second = await ensureDevTlsCertificate({ certDir: dir, log });
  assert.equal(second?.caGenerated, false, "CA 已存在则不重造");
  assert.equal(second?.leafGenerated, false, "SAN 未变化则不重签");
  assert.equal(readFileSync(join(dir, "server.crt"), "utf8"), certBefore, "证书内容不变");

  // 新增 DNS 名 → 重签叶子，但复用同一个 CA（信任库装一次即可）
  const caBefore = readFileSync(join(dir, "ca.crt"), "utf8");
  const third = await ensureDevTlsCertificate({
    certDir: dir,
    dnsNames: [...collectLocalHosts().dnsNames, "extra.example.internal"],
    ips: collectLocalHosts().ips,
    log,
  });
  assert.equal(third?.caGenerated, false);
  assert.equal(third?.leafGenerated, true, "SAN 变化触发重签");
  assert.equal(readFileSync(join(dir, "ca.crt"), "utf8"), caBefore, "CA 不变");
  assert.ok(third?.sanString.includes("extra.example.internal"));
});

test("dev-https: 同实例 HTTPS 监听，https 路由与 wss 均可用", async (t) => {
  const bin = await resolveOpensslBin();
  if (!bin) return t.skip("环境无 openssl");
  const dir = await mkdtemp(join(tmpdir(), "dev-https-"));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }));

  const app = Fastify({ logger: false });
  await app.register(websocket);
  app.get("/ping", async () => "pong");
  app.get("/ws", { websocket: true }, (socket) => {
    socket.send("hello");
  });
  await app.ready();

  const handle = await startDevHttpsListener(
    app,
    { enabled: true, port: 0, certDir: dir, autoTrust: false, opensslBin: bin },
    log,
  );
  assert.ok(handle, "HTTPS 监听应启动成功");
  const caPem = readFileSync(join(dir, "ca.crt"), "utf8");
  const agent = new https.Agent({ ca: caPem, rejectUnauthorized: true });

  try {
    // 1) HTTPS 路由走 fastify.routing 分发
    const body = await new Promise<string>((resolve, reject) => {
      https
        .get({ host: "127.0.0.1", port: handle.port, path: "/ping", agent }, (res) => {
          let data = "";
          res.on("data", (chunk) => (data += chunk));
          res.on("end", () => resolve(data));
        })
        .on("error", reject);
    });
    assert.equal(body, "pong");

    // 2) wss：upgrade 事件转发到 app.server，@fastify/websocket 正常升级
    const received = await new Promise<string>((resolve, reject) => {
      const ws = new WebSocket(`wss://127.0.0.1:${handle.port}/ws`, { ca: [caPem] });
      ws.on("message", (msg) => {
        resolve(String(msg));
        ws.close();
      });
      ws.on("error", reject);
    });
    assert.equal(received, "hello");
  } finally {
    agent.destroy();
    await handle?.close();
    await app.close();
  }
});

test("dev-https: enabled=false 直接跳过", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "dev-https-off-"));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }));
  const app = Fastify({ logger: false });
  await app.ready();
  try {
    const handle = await startDevHttpsListener(
      app,
      { enabled: false, port: 0, certDir: dir, autoTrust: false, opensslBin: null },
      log,
    );
    assert.equal(handle, null);
  } finally {
    await app.close();
  }
});
