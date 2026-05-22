# private_ai_agent

A new Flutter project.

## Getting Started

This project is a starting point for a Flutter application.

A few resources to get you started if this is your first Flutter project:

- [Learn Flutter](https://docs.flutter.dev/get-started/learn-flutter)
- [Write your first Flutter app](https://docs.flutter.dev/get-started/codelab)
- [Flutter learning resources](https://docs.flutter.dev/reference/learning-resources)

For help getting started with Flutter development, view the
[online documentation](https://docs.flutter.dev/), which offers tutorials,
samples, guidance on mobile development, and a full API reference.

## Agent World 网页跳转

当用户点击左侧导航栏中的 "Agent World" 时，应用会自动跳转到配置的 Agent World 网页地址。
默认地址为 `http://127.0.0.1:3333`（agent-world standalone 服务），可通过编译参数 `--dart-define=AGENT_WORLD_URL=your_url` 自定义。

### 启动方式

#### 推荐：一键启动（主服务 + Agent World + 社交推文站）

在项目根目录运行：

```bash
npm run dev:all
# 等同：npm run start:full
```

将打开 3 个窗口：主服务 `:3000`、Agent World `:3333`、社交推文 `:3001`。  
地址清单见根目录 `dev-urls.json`。

**特性：**
- ✓ 自动检测并启动 Agent World 服务（如未运行）
- ✓ 启动 Flutter 应用并启用热重载（`--hot`）
- ✓ Agent World 服务在后台持续运行，支持热重载
- ✓ Flutter 应用关闭后，Agent World 服务继续运行

#### 手动启动

如果需要分别启动服务：

**终端 1：启动 Agent World 服务**
```bash
# 在 agent-world 目录下运行
cd agent-world
npm run standalone

# 或在项目根目录运行
npm run agent-world
```

**终端 2：启动 Flutter 应用（带热重载）**
```bash
cd client/flutter_app
flutter run -d windows --hot
```

服务启动后，访问 `http://127.0.0.1:3333` 即可看到 Agent World 网页。

### UI 配色

Agent World 网页现已采用灰色主题配色，提供更柔和的视觉体验。

### 关闭服务

如需关闭 Agent World 服务：
```powershell
Get-Process node | Stop-Process -Force
```
