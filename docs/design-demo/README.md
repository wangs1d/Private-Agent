# 首次启动体验「唤醒仪式」· 演示视频

对应设计稿：[../onboarding-opening-animation-design.md](../onboarding-opening-animation-design.md)

## 文件

| 文件 | 说明 |
|---|---|
| `onboarding_demo.mp4` | 演示视频（1920×1080 / 30fps / 67.6s，含解说与产品语音） |
| `storyboard.html` | 交互式分镜播放器（单文件自包含，含音轨，可拖动进度条逐帧查看） |

## 视频分镜（与设计稿章节对应）

| 时间 | 分镜 | 对应设计稿 |
|---|---|---|
| 00:00–00:05 | 片头：唤醒仪式 | — |
| 00:05–00:13 | ① 声音选择 · 赋予 TA 一个声音（试听「你好，我在这。」） | §3 |
| 00:13–00:20 | ② 唤醒动画 · 白光绘制球体 + 点亮（含唤醒音） | §4 |
| 00:20–00:29 | ③ 第一声问候 ·「你好，我在这。以后，我就是你的私人管家」（峰值①） | §5 |
| 00:29–00:39 | ④ 双向命名 ·「小林 / 小安」名字交换 | §5 + §10.2 |
| 00:39–00:45 | ⑤ 能力点亮 · 白光流经侧栏 | §10.2 |
| 00:45–00:58 | ⑥ 觉醒卡 · 编号/声线/金句/保存分享/归档「我们的开始」 | §10.3–10.4 |
| 00:58–01:08 | 情绪曲线 · 六阶段 + 双峰值 + 全程 ≤ 1 分钟护栏 | §10.1 + §10.5 |

语音说明：解说为男声（CosyVoice2 alex），产品台词为女声（CosyVoice2 bella，
即演示所选路径），由 `server/src/services/voice-dialogue/adapters/siliconflow-tts-adapter.ts`
同一 TTS 服务合成。

## 再生成方式（如需改分镜/文案）

构建脚本在临时目录，核心输入为 `player_template.html`（canvas 确定性时间轴，
`window.__seek(t)` 可渲染任意时刻）。流程：

1. TTS 台词 → `audio/*.mp3`（硅基流动，密钥在 `server/.env`）
2. ffmpeg 按时间表 `adelay + amix` → `mix.m4a`（67.6s）
3. 音频 base64 注入模板 → `storyboard.html`
4. Playwright(Edge headless) 按 30fps 逐帧截图 → ffmpeg 合成 MP4
