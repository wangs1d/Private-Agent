# Private-Agent 项目长期约定

## UI / 产品规则
- **卡片下方不展示来源链接**：任何卡片、消息气泡下方都不得附「来源/出处」链接 chip（如域名 chip）。跳转只能由卡片自身承载（点击卡片/条目）。2026-10-02 已据此下线 `chat_page.dart` 的底部来源链接组件。

## 环境注意
- 本机 `flutter analyze` / `dart analyze` 常因 Windows 管道资源耗尽（ProcessException 231）崩溃，非代码问题；必要时改人工核对或稍后重试。
