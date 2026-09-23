# 客户端分发方案（最终版）

一句话：**测试期捆绑 runtime 随安装包分发（byok），manifest 接口做总控制面；收回期切
platform，客户端变薄，全程无需重发客户端。**

```
测试期（byok）                          收回期（platform）
┌─────────────────────────┐            ┌──────────────┐   ┌─────────────────────┐
│ 用户机器                 │            │ 用户机器      │   │ 你的 ECS             │
│ PrivateAgent.exe (前端)  │            │ PrivateAgent │   │ runtime + Python 旁路│
│ runtime\ (node+dist+nm)  │  ──收回──▶ │ (纯前端)      │◀──│ TTS/ASR/记忆/浏览器  │
│ %APPDATA%\PrivateAgent\  │            └──────────────┘   └─────────────────────┘
│  config.env(用户key)     │                 ▲   ▲
└─────────────────────────┘                 │   │ 启动时拉 manifest
        ▲ 启动时拉 manifest                  └───┘ channel=platform 直连 ECS
        │ (latest/minVersion/url/channel)
┌───────┴──────────┐
│ ECS: /api/client/manifest + OBS: setup.exe │
└────────────────────────────────────────────┘
```

## 一、安装包结构（测试期）

```
<LocalAppData>\Programs\PrivateAgent\     ← per-user 安装，免管理员
  PrivateAgent.exe                        ← Flutter 客户端（版本检查已内置）
  runtime\
    node.exe                              ← 捆绑 Node LTS（与开发机同大版本）
    dist\                                 ← server tsc 编译产物
    node_modules\                         ← npm ci --omit=dev（better-sqlite3/sharp 有
                                             Windows 预编译，装完直接拷）
  vc_redist / 或直接拷 MSVC DLL            ← Flutter exe 运行库
%APPDATA%\PrivateAgent\                   ← 用户数据区（卸载/覆盖安装都不动）
  config.env                              ← 用户模型 key（首启向导写入）
  data\ logs\
```

- **Inno Setup 固定 AppId**，一次生成永不变——覆盖安装/升级检测/卸载全靠它
- WebView2：Win10 20H2+/Win11 自带，安装器检测缺失才静默装 Evergreen Bootstrapper

## 二、运行生命周期（测试期）

1. 客户端启动 → 拉版本检查（已完成）→ 检测 `127.0.0.1:3000` health
2. runtime 未跑 → 客户端用**捆绑的** `runtime\node.exe` 拉起 `dist/index.js`
   （`windowsHide:true` 无黑窗；dotenv 不覆盖已有进程变量，启动器把
   `%APPDATA%\PrivateAgent\config.env` 的键值注入子进程环境即可，**server 零改动**）
3. 客户端退出 → 树杀 runtime（`taskkill /T`，防句柄残留——已知 Windows spawn 坑）
4. 首启检测 config.env 无 key → 极简对话框引导填模型 key → 写入 → 重启 runtime

不做常驻后台/tray：主动推送本就需要客户端在线收 WS，runtime 与客户端同生命周期在
测试期成立，省掉一整套服务化复杂度。常驻列为收回后再议。

## 三、这轮不打包的（降级策略）

| 依赖 | 处理 | 理由 |
|---|---|---|
| FunASR / MeloTTS / voice-orb-py | `FUNASR_AUTO_START=0`，语音相关入口隐藏 | Python+torch 太重；收回后由服务端统一提供 |
| playwright chromium | 不带，浏览器功能保留原有报错提示 | 功能级依赖缺了不崩；收回后服务端跑 |
| Qdrant/记忆 | 不带 | 无 embedding 端点时代码自动禁用（已验证优雅降级） |

## 四、交付物（开发任务）

1. `installer/private-agent.iss` — Inno 脚本：固定 AppId、per-user、捆绑 runtime 目录、
   vc_redist、WebView2 检测、卸载保留 %APPDATA%
2. `scripts/release/build-installer.ps1` — 一键流水线：flutter build（烤 -HttpBase）→
   server tsc → npm ci --omit=dev → 拼 staging 目录 → 下载 node.exe → ISCC 编译出
   `Private-Agent-Setup-x.y.z.exe`
3. `lib/core/services/local_runtime_manager.dart` — health 探测/捆绑 node 拉起/树杀/
   config.env 注入
4. 首启 key 引导对话框 + 设置页「模型服务」块（读写 config.env）
5. 端到端验收（见下）

## 五、发版流程（与 manifest 机制对接）

- `pubspec.yaml` version 改为 x.y.z → `build-installer.ps1` 出 setup.exe → 传 OBS →
  改 `server/config/client-manifest.json`（latest/url/notes）→ 全体用户下次启动收到更新
- 升级 = 覆盖安装整个应用目录；用户 key/数据在 %APPDATA% 不受影响
- 强制淘汰：抬 `minVersion`；收回 runtime：`channel` 改 `platform`（客户端切换逻辑
  到期实现，状态位已就位）

## 六、首次分发注意

- **当前 0.1.0 没有版本检查器，不在控制面内**——第一个带检查器的版本（建议 0.2.0）
  必须手动发给测试用户，这一波之后才进入全自动
- 未签名 exe 会触发 SmartScreen 告警：测试期口头告知「仍要运行」，商业分发前上代码
  签名证书
- 首次发版前把 ECS 的 `server/config/client-manifest.json` 配好真实 OBS url

## 七、验收清单（发版前过一遍）

- [ ] 干净 Win10/Win11 裸机（无 Node/Python）安装成功，桌面快捷方式可用
- [ ] 首启引导填 key → 对话正常 → 重启应用配置还在（%APPDATA% 生效）
- [ ] 客户端退出后 runtime 进程无残留（任务管理器核对 node.exe）
- [ ] manifest 改 latest → 客户端启动弹更新；改 minVersion → 旧版锁死
- [ ] 覆盖安装新版本 → 对话历史/用户 key/设置全部保留
- [ ] 卸载后 %APPDATA%\PrivateAgent 保留
