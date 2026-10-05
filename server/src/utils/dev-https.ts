import https from "node:https";
import type { FastifyInstance } from "fastify";
import {
  collectLocalHosts,
  ensureDevTlsCertificate,
  trustCaOnWindows,
} from "./dev-tls.js";
import { isTcpPortInUse } from "./port-in-use.js";

export type DevHttpsConfig = {
  enabled: boolean;
  port: number;
  /** null → 默认 server/certs/ */
  certDir: string | null;
  autoTrust: boolean;
  opensslBin: string | null;
};

export type DevHttpsHandle = {
  port: number;
  /** 展示用入口（含 /chat），按 局域网 IP → localhost 排序 */
  urls: string[];
  caCertPath: string;
  /** 关停 HTTPS 监听（含 idle 连接清理）；接入方在 shutdown 流程里调用 */
  close: () => Promise<void>;
};

/**
 * 在既有 Fastify 实例上追加一个 HTTPS 监听（默认 :3443），HTTP 原端口不动：
 *   - 浏览器走 https://<本机IP>:3443/chat，证书由本地根 CA 签发且装入系统信任库，
 *     地址栏不再出现"不安全"标志；
 *   - Flutter 客户端与 WS 客户端继续走原 HTTP 端口，零影响。
 *
 * wss 支持方式：@fastify/websocket 把 upgrade 监听挂在 app.server 上并统一走
 * fastify.routing 分发，这里把 HTTPS server 的 upgrade 事件原样转发过去即可——
 * socket 在 TLS 层已解密，对路由与 ws 库而言与普通双工流无异。
 */
export async function startDevHttpsListener(
  app: FastifyInstance,
  config: DevHttpsConfig,
  log: (line: string) => void,
): Promise<DevHttpsHandle | null> {
  if (!config.enabled) {
    log("[https] HTTPS_ENABLED=0，跳过 HTTPS 监听");
    return null;
  }
  // 端口 0（测试用临时端口）跳过占用预检
  if (config.port > 0 && (await isTcpPortInUse(config.port, "0.0.0.0"))) {
    log(`[https] 端口 ${config.port} 已被占用，本次仅提供 HTTP（可设 HTTPS_PORT 换端口）`);
    return null;
  }

  const material = await ensureDevTlsCertificate({
    certDir: config.certDir ?? undefined,
    opensslBin: config.opensslBin,
    log,
  });
  if (!material) return null;

  if (material.caGenerated) {
    log(`[https] 已生成本地根 CA：${material.caCertPath}（有效期 10 年，换 IP 只重签服务器证书）`);
  }
  await trustCaOnWindows(material.caCertPath, {
    enabled: config.autoTrust,
    log,
  });

  const server = https.createServer(
    { key: material.keyPem, cert: material.certPem },
    (req, res) => {
      app.routing(req, res);
    },
  );
  server.on("upgrade", (req, socket, head) => {
    app.server.emit("upgrade", req, socket, head);
  });
  // 浏览器/扫描器对 TLS 端口的裸探测会握手失败，属预期噪音，降为单条警告
  let tlsWarned = false;
  server.on("tlsClientError", (err) => {
    if (!tlsWarned) {
      tlsWarned = true;
      log(`[https] TLS 握手失败（多为非 TLS 探测）：${err.message}`);
    }
  });

  // Fastify listen 之后不能再 addHook（FST_ERR_INSTANCE_ALREADY_LISTENING），
  // 因此关停不走 onClose 钩子，而是把 close 暴露给接入方的 shutdown 流程。
  const close = async (): Promise<void> => {
    server.closeIdleConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };

  try {
    await new Promise<void>((resolvePromise, rejectPromise) => {
      server.once("error", rejectPromise);
      server.listen({ port: config.port, host: "0.0.0.0" }, () => resolvePromise());
    });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EADDRINUSE") {
      log(`[https] 端口 ${config.port} 监听失败（被占用），本次仅提供 HTTP`);
      return null;
    }
    throw err;
  }

  const actualPort = (server.address() as { port: number }).port;
  const hosts = collectLocalHosts();
  const lanIps = hosts.ips.filter((ip) => ip !== "127.0.0.1" && ip.includes("."));
  const urls = [...lanIps.map((ip) => `https://${ip}:${actualPort}/chat`), `https://127.0.0.1:${actualPort}/chat`];
  for (const url of urls) log(`[https] 浏览器入口：${url}`);
  return { port: actualPort, urls, caCertPath: material.caCertPath, close };
}
