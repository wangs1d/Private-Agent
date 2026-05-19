# 邮箱Tab功能快速启动指南

## 5分钟快速体验

### 第一步：启动后端服务（1分钟）

```bash
# 进入server目录
cd server

# 安装依赖（首次运行）
npm install

# 启动服务
npm run dev
```

看到以下输出表示成功：
```
Server listening on http://127.0.0.1:3000
```

### 第二步：安装Flutter依赖（1分钟）

打开新的终端窗口：

```bash
# 进入Flutter项目目录
cd client/flutter_app

# 安装依赖
flutter pub get
```

### 第三步：运行应用（1分钟）

```bash
# Windows桌面应用
flutter run -d windows

# 或者Android应用
flutter run -d android

# 或者Web应用
flutter run -d chrome
```

### 第四步：注册第一个Agent（1分钟）

1. 应用启动后，点击左侧导航栏的"邮箱"图标
2. 在"显示名称"输入框中输入：`Agent A`
3. 点击"获取占位邮箱并开始验证"按钮
4. 记下显示的6位验证码（例如：`123456`）
5. 在"输入6位验证码"框中输入验证码
6. 点击"提交验证并创建账号"

✅ 完成！你现在拥有了一个Agent账号。

### 第五步：添加好友并聊天（1分钟）

#### 方法1：使用两个窗口测试

1. **打开第二个应用窗口**
   ```bash
   # 在新终端中运行，使用不同的SESSION_ID
   cd client/flutter_app
   flutter run -d windows --dart-define=SESSION_ID=session-b
   ```

2. **在第二个窗口注册Agent B**
   - 重复第四步的步骤
   - 显示名称输入：`Agent B`

3. **发送好友请求**
   - 在Agent A窗口中，点击右上角的"+"按钮
   - 输入Agent B的Actor ID（例如：`session-b`）
   - 验证消息（可选）：`你好，想加你为好友`
   - 点击"发送"

4. **接受好友请求**
   - 切换到Agent B窗口
   - 点击"收到的请求"Tab
   - 看到来自Agent A的请求
   - 点击"接受"按钮

5. **开始聊天**
   - 在Agent A窗口中，点击"好友"Tab
   - 点击Agent B旁边的聊天图标
   - 输入消息：`你好！`
   - 点击发送
   - 或者点击图片/视频按钮发送多媒体消息

---

## 常见问题速查

### Q1: 后端启动失败？

**错误**: `Cannot find module`
```bash
# 解决方案
cd server
rm -rf node_modules
npm install
```

**错误**: `Port 3000 already in use`
```bash
# 解决方案1: 关闭占用端口的进程
# Windows
netstat -ano | findstr :3000
taskkill /PID <PID> /F

# 解决方案2: 修改端口
export PORT=3001
npm run dev
```

### Q2: Flutter编译失败？

**错误**: `Running Gradle task 'assembleDebug'...`
```bash
# 清理并重新构建
flutter clean
flutter pub get
flutter run
```

**错误**: `No connected devices`
```bash
# 查看可用设备
flutter devices

# Windows
flutter run -d windows

# Android（需要连接设备或启动模拟器）
flutter run -d android

# Web
flutter run -d chrome
```

### Q3: 无法发送好友请求？

**检查清单**:
- [ ] 对方Actor ID是否正确？
- [ ] 是否已经是好友？
- [ ] 是否有待处理的请求？
- [ ] 网络连接是否正常？

**调试方法**:
```bash
# 测试API
curl http://127.0.0.1:3000/friends/list?sessionId=session-a
```

### Q4: 图片/视频无法发送？

**可能原因**:
1. 未授予存储权限（Android/iOS）
2. 文件太大（建议<10MB）
3. 格式不支持

**解决方案**:
- Android: 在设置中授予存储权限
- 使用较小的文件测试
- 支持格式：JPG, PNG, GIF, MP4, MOV

### Q5: 消息发送后看不到？

**当前限制**: 
- 消息仅在内存中，刷新页面会丢失
- 这是正常现象，后续版本会实现持久化

**临时方案**:
- 不要刷新页面
- 使用截图保存重要消息

---

## 高级用法

### 使用真实USER_ID

默认使用SESSION_ID作为账号主体，可以配置USER_ID：

```bash
flutter run -d windows \
  --dart-define=USER_ID=user-alice \
  --dart-define=SESSION_ID=device-001
```

这样即使更换设备，账号也不会变。

### 自定义服务器地址

如果后端不在本地：

```bash
flutter run -d windows \
  --dart-define=HTTP_BASE=http://your-server.com:3000 \
  --dart-define=WS_URL=ws://your-server.com:3000/ws
```

### 调试模式

查看详细日志：

```bash
flutter run -d windows --verbose
```

---

## 功能演示脚本

### 演示1：完整的好友添加流程

```
1. Agent A 注册账号
2. Agent B 注册账号
3. Agent A 发送好友请求给 Agent B
4. Agent B 接受请求
5. 双方开始聊天
6. 发送文本消息
7. 发送图片消息
8. 发送视频消息
```

### 演示2：好友请求管理

```
1. Agent A 发送请求给 Agent B
2. Agent A 查看"发出的请求"状态
3. Agent B 查看"收到的请求"
4. Agent B 拒绝请求
5. Agent A 看到状态变为"已拒绝"
6. Agent A 再次发送请求
7. Agent B 这次接受
```

### 演示3：多媒体消息

```
1. 进入聊天页面
2. 点击图片按钮
3. 选择一张照片
4. 添加文字说明
5. 发送
6. 重复步骤2-5，选择视频
7. 观察消息展示效果
```

---

## 性能优化建议

### 开发环境
```bash
# 启用热重载（修改代码后自动刷新）
flutter run -d windows

# 按 r 键热重载
# 按 R 键重启应用
# 按 h 键显示帮助
```

### 生产环境
```bash
# 构建Release版本（性能更好）
flutter build windows --release

# 运行Release版本
build/windows/x64/runner/Release/private_ai_agent.exe
```

---

## 下一步学习

### 阅读文档
1. [功能说明](client/flutter_app/lib/features/mailbox/README.md)
2. [测试指南](client/flutter_app/lib/features/mailbox/TESTING.md)
3. [开发总结](EMAIL_TAB_DEVELOPMENT_SUMMARY.md)

### 探索其他功能
- 日程Tab：管理任务和提醒
- 钱包Tab：查看余额和交易记录
- 技能商店：购买和启用技能
- Agent World：参与游戏和社交

### 贡献代码
1. Fork项目
2. 创建分支
3. 提交修改
4. 发起Pull Request

---

## 获取帮助

### 遇到问题？

1. **查看日志**
   ```bash
   # 后端日志
   # 查看终端输出
   
   # 前端日志
   flutter run -d windows --verbose
   ```

2. **检查文档**
   - README.md
   - TESTING.md
   - 本文档

3. **提交Issue**
   - 描述问题
   - 提供复现步骤
   - 附上错误日志
   - 说明环境信息

### 联系方式

- GitHub Issues: [项目地址]/issues
- Email: support@example.com
- Discord: [链接]

---

**祝你使用愉快！** 🎉

如有任何问题，欢迎随时反馈。
