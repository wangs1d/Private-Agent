# 客户端版本清单与升级机制

一个接口管三件事：**版本推送、强制升级、后期收回 runtime**。服务器只返回几 KB 的
JSON，安装包下载流量全走 OBS，不占 ECS 带宽。

## 接口

`GET /api/client/manifest`（[server/src/routes/http/client-manifest.ts](../server/src/routes/http/client-manifest.ts)）

```json
{
  "ok": true,
  "latest": "0.2.0",
  "minVersion": "0.1.5",
  "url": "https://<OBS域名>/Private-Agent-Setup-0.2.0.exe",
  "notes": "修复 XX，新增 XX",
  "channel": "byok"
}
```

数据源：`server/config/client-manifest.json`（**每次请求实时读取，改完即生效，无需
重启/重新构建**）。环境变量 `CLIENT_MANIFEST_LATEST / _MIN_VERSION / _URL / _NOTES /
_CHANNEL` 可逐字段覆盖文件值（临时调整用）。文件缺失时回退内置默认，接口始终可用。

> ECS 部署时 `server/config/` 目录必须随 `dist/` 一起带上去（gitignore 只忽略
> `server/data/`，config 不在其中）。

## 客户端行为（启动时请求一次，仅 Windows）

- 本地版本 ≥ `minVersion` 且 ≥ `latest`：无感，正常使用
- `minVersion` ≤ 本地 < `latest`：软弹窗「发现新版本」（含 notes），可暂不更新
- 本地 < `minVersion`：硬锁弹窗，不可关闭，唯一出口是下载新版本覆盖安装
  （Inno Setup 同 AppId，配置与数据保留）
- **接口失败/超时/JSON 异常：一律放行（fail-open）**，服务器不可达不会锁死用户；
  强锁仅在明确拿到清单且下载地址可用时触发

本地版本号来自 exe 版本资源，由 pubspec.yaml `version:` 经 CMake 自动注入
（`windows/runner/Runner.rc` 的 `FLUTTER_VERSION*` 宏），**pubspec 是唯一版本源**，
发版改它就行。channel 值会被客户端持久化到本地偏好 `client.channel`，为切换留状态位。

## 发版流程（每次新版本）

1. `client/flutter_app/pubspec.yaml` 改 `version: x.y.z+N`
2. 构建：`.\build_windows_release.ps1 -HttpBase https://<服务器域名>`
   （不传 HttpBase 时默认连 127.0.0.1，只适合本机联调）
3. 打包 setup.exe（Inno Setup，固定 AppId），上传 OBS
4. 改 `server/config/client-manifest.json`：`latest` = 新版本号、`url` = OBS 下载
   地址、`notes` = 更新说明
5. 完成。所有已分发客户端下次启动自动收到新版本提示

## 强制升级 / 淘汰旧版

把 `minVersion` 抬到目标版本，低于它的客户端下次启动即锁死。仅此而已，无需发新包。

## 收回 runtime（切统一 API 服务）

把 `channel` 从 `byok` 改成 `platform`，客户端下次启动读到即切换形态（本地
runtime → 统一 API 服务）；必要时同步抬 `minVersion` 强制淘汰切不过去的旧版。
版本推送、强制升级、业务形态切换，全在这一个 JSON 文件里远程完成。
