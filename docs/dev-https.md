# 本地 HTTPS 双监听（消除浏览器"不安全"标志）

服务启动时会在原 HTTP 端口之外**追加**一个 HTTPS 监听（默认 `:3443`），用本地生成的根 CA 签发证书并装入 Windows 当前用户信任库。浏览器打开：

```
https://127.0.0.1:3443/chat          # 本机
https://<局域网IP>:3443/chat         # 手机/其他设备（启动日志会打印实际地址）
```

地址栏即为正常锁标，不再显示"不安全"。HTTP 原端口（3000）行为零变化——Flutter 客户端、设备桥、WS 客户端继续走 HTTP，无需任何改动；`/chat` 页面的 WebSocket 会按协议自动切到 `wss:`（同一监听、同一路由）。

## 工作方式

| 环节 | 说明 |
| --- | --- |
| 证书生成 | `server/src/utils/dev-tls.ts` 调用 openssl（PATH 或 Git 自带副本，可用 `OPENSSL_BIN` 指定）在 `server/certs/` 生成自签根 CA（10 年）+ 服务器证书（825 天） |
| SAN 覆盖 | localhost、`127.0.0.1`、`::1`、主机名、全部局域网 IPv4；**IP 变化（DHCP）后下次启动自动重签叶子证书**，CA 不变、信任不失效 |
| 信任安装 | 按证书指纹查 Windows 当前用户 Root 库；未信任时后台弹出系统安全确认框（不阻塞启动），**用户点一次「是」即永久生效** |
| wss | `server/src/utils/dev-https.ts` 起 HTTPS server 复用同一 Fastify 实例，upgrade 事件转发给 `@fastify/websocket`，`/ws` 等路由原样可用 |
| 关停 | HTTPS 监听随主进程 shutdown 一起关闭（`devHttpsHandle.close()`） |

首次启动控制台输出：

```
[https] 已生成本地根 CA：D:\...\server\certs\ca.crt（有效期 10 年，换 IP 只重签服务器证书）
[https] Windows 将弹出安全确认框（安装本地根 CA），请点「是」——仅此一次，点完刷新浏览器即可去掉"不安全"标志。
[https] 浏览器入口：https://192.168.10.13:3443/chat
[https] 浏览器入口：https://127.0.0.1:3443/chat
```

## 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `HTTPS_ENABLED` | `1` | 设 `0` 关闭 HTTPS 监听（只跑 HTTP） |
| `HTTPS_PORT` | `3443` | HTTPS 端口 |
| `TLS_CERT_DIR` | `server/certs/` | 证书与私钥目录（已 gitignore） |
| `TLS_AUTO_TRUST` | `1` | 设 `0` 跳过弹窗，改为手动双击 `ca.crt` 安装到「受信任的根证书颁发机构 → 当前用户」 |
| `OPENSSL_BIN` | 自动探测 | 指定 openssl 可执行文件路径 |

证书生成失败（无 openssl）或端口被占用时只降级提示、照常提供 HTTP，不影响启动。

## 手机等其他设备

Android Chrome / Windows Edge / Chrome 信任系统（或用户）证书库，点过确认框后直接访问即出锁标。iOS Safari 需额外在「设置 → 通用 → VPN与设备管理」安装描述文件并开启信任；可将 `server/certs/ca.crt` 拷到手机安装。

## 生产部署

生产走 `client/web` 的 nginx + `ssl.conf`（真域名证书），与本地开发这套自签链路互不相干。

> 注意：`RUNTIME_MODE=remote` 双进程拓扑（runtime-main + gateway-main）目前只在 embedded 单进程入口（`src/index.ts`）接了 HTTPS；remote 形态浏览器流量走 gateway，需要时在 gateway-main 上按同样方式加监听。

## 相关代码

- `server/src/utils/dev-tls.ts` — 证书生成 / SAN 收集 / 指纹查询 / 信任安装
- `server/src/utils/dev-https.ts` — HTTPS 监听、upgrade 转发、URL 打印、关停句柄
- `server/src/config/env.ts` — `getHttpsRuntimeConfig`
- `server/src/index.ts` — 接线与 shutdown
- `server/test/dev-https.test.ts` — 单测（证书链、SAN 重签、https/wss 回环）
