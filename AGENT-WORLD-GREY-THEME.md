# Agent World 灰色主题更新说明

## 更新内容

### 1. UI 配色改为灰色主题

Agent World 网页的 UI 配色已从原来的蓝色主题更新为灰色主题，提供更柔和、专业的视觉体验。

**主要变更：**
- 背景色：从深蓝黑色 (#0f1419) 改为深灰色 (#1a1a1a)
- 强调色：从蓝色 (#5eb8ff) 改为灰色 (#888888)
- 所有相关颜色均已调整为灰色系
- 保持了良好的对比度和可读性

**修改文件：**
- `agent-world/web/assets/styles.css`

### 2. 一键启动脚本

创建了 PowerShell 启动脚本，可以同时启动 Agent World 服务和 Flutter 应用。

**功能特性：**
- ✓ 自动检测 Agent World 服务是否已在运行
- ✓ 智能启动服务并等待就绪
- ✓ 自动启动 Flutter 应用
- ✓ 退出时可选择关闭服务
- ✓ 友好的命令行界面和状态提示

**使用方式：**

```powershell
# 方式一：通过 npm 脚本
npm run start:full

# 方式二：直接运行 PowerShell 脚本
powershell -ExecutionPolicy Bypass -File ./start-with-agent-world.ps1
```

**新增文件：**
- `start-with-agent-world.ps1` - 一键启动脚本
- `package.json` - 添加了 `start:full` 脚本

### 3. 文档更新

更新了 Flutter 应用的 README 文件，添加了：
- 一键启动脚本的使用说明
- 灰色主题的说明
- 更清晰的启动流程指引

**修改文件：**
- `client/flutter_app/README.md`

## 使用方法

### 快速启动（推荐）

在项目根目录运行：

```bash
npm run start:full
```

这将：
1. 检查并启动 Agent World 服务（如果未运行）
2. 等待服务就绪
3. 启动 Flutter 应用
4. 退出时询问是否关闭服务

### 手动启动

如果需要分别启动服务：

```bash
# 终端 1：启动 Agent World 服务
npm run agent-world

# 终端 2：启动 Flutter 应用
cd client/flutter_app
flutter run -d windows
```

## 技术细节

### 灰色主题配色方案

```css
--bg: #1a1a1a;          /* 主背景 */
--bg-elev: #242424;     /*  elevated 背景 */
--border: #3a3a3a;      /* 边框 */
--text: #e0e0e0;        /* 主文字 */
--muted: #999999;       /* 次要文字 */
--accent: #888888;      /* 强调色 */
--accent-dim: #666666;  /* 淡化强调色 */
```

### 启动脚本工作流程

1. **环境检查**：验证当前目录是否正确
2. **端口检测**：检查 3333 端口是否已被占用
3. **服务启动**：如未运行则启动 Agent World 服务
4. **健康检查**：轮询健康接口确认服务就绪
5. **应用启动**：启动 Flutter 应用
6. **清理提示**：退出时提供关闭服务的选项

## 注意事项

1. **首次运行**：可能需要允许 PowerShell 执行脚本
   ```powershell
   Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
   ```

2. **端口冲突**：如果 3333 端口被占用，脚本会自动检测到并使用现有服务

3. **进程管理**：脚本会尝试精确定位 agent-world 进程，如失败会提示手动关闭

4. **浏览器访问**：也可以直接在浏览器中访问 http://127.0.0.1:3333 查看 Agent World 网页

## 故障排除

### 服务无法启动

检查是否有其他程序占用 3333 端口：
```powershell
netstat -ano | findstr :3333
```

### Flutter 应用无法连接

确保 Agent World 服务正在运行：
```powershell
Invoke-WebRequest -Uri http://127.0.0.1:3333/health
```

### 脚本执行权限问题

以管理员身份运行 PowerShell，然后：
```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
```

## 更新日志

**2026-05-13**
- ✓ UI 配色改为灰色主题
- ✓ 创建一键启动脚本
- ✓ 更新文档说明
- ✓ 添加健康检查和智能启动逻辑
