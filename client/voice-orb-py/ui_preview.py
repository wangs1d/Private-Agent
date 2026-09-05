"""语音模式 UI 预览：复用 voice_orb.app 的真实控件，在桌面自动循环演示全部状态。

仅用于本地走查/演示：不连 WS、不动麦克风；聆听响度用合成信号模拟。
运行：py -3 ui_preview.py
交互：悬停/拖动悬浮件是真实交互；右键「打开主界面」= 退出预览。
"""

import math
import random
import sys

from PySide6.QtCore import QPointF, Qt, QTimer
from PySide6.QtGui import (
    QBrush,
    QColor,
    QLinearGradient,
    QPainter,
    QPainterPath,
    QPixmap,
)

from voice_orb.app import (
    CardStack,
    CenterStage,
    OrbState,
    VerticalWaveOrb,
)


def _fake_photo(width: int, height: int, c1: str, c2: str) -> QPixmap:
    """生成一张渐变+圆点的假缩略图，代替需要 server 的真实图片。"""
    pm = QPixmap(width, height)
    pm.fill(Qt.GlobalColor.transparent)
    p = QPainter(pm)
    p.setRenderHint(QPainter.RenderHint.Antialiasing)
    grad = QLinearGradient(0, 0, width, height)
    grad.setColorAt(0.0, QColor(c1))
    grad.setColorAt(1.0, QColor(c2))
    p.setBrush(QBrush(grad))
    p.setPen(Qt.PenStyle.NoPen)
    p.drawEllipse(QPointF(width * 0.5, height * 0.55), width * 0.42, height * 0.46)
    for _ in range(4):
        p.setBrush(QBrush(QColor(255, 255, 255, random.randint(28, 70))))
        r = random.uniform(4, 12)
        p.drawEllipse(
            QPointF(random.uniform(8, width - 8), random.uniform(8, height - 8)),
            r, r,
        )
    p.end()
    return pm


def main() -> int:
    from PySide6.QtWidgets import QApplication

    app = QApplication(sys.argv)
    app.setQuitOnLastWindowClosed(False)

    orb = VerticalWaveOrb()
    stack = CardStack(orb)
    stage = CenterStage()
    orb.open_page_requested.connect(app.quit)  # 右键「打开主界面」退出预览
    orb.show_state(OrbState.IDLE)
    orb._position()
    orb.show()

    # 聆听态的合成响度：让波纹"看得见在听"
    vol_timer = QTimer()
    vol_timer.timeout.connect(
        lambda: orb.set_volume(
            max(0.05, 0.35 + 0.30 * math.sin(orb._t * 3.1) + random.uniform(-0.08, 0.08))
        )
    )

    sample_items = [
        {"title": "晨会 · 周会同步", "startAt": "2026-09-05T09:30:00+08:00", "completed": True},
        {"title": "评审语音模式 UI", "startAt": "2026-09-05T11:00:00+08:00", "notes": "重点看待机可见性和卡片避让"},
        {"title": "写 P1 优化方案", "startAt": "2026-09-05T14:00:00+08:00"},
        {"title": "跑步 5km", "startAt": "2026-09-05T19:30:00+08:00"},
    ]

    sample_media = [
        {"type": "image", "thumbnailUrl": "", "mediaUrl": ""},
        {"type": "image", "thumbnailUrl": "", "mediaUrl": ""},
        {"type": "video", "thumbnailUrl": "", "mediaUrl": "", "pageUrl": ""},
        {"type": "image", "thumbnailUrl": "", "mediaUrl": ""},
    ]

    def show_intro():
        stack.show_text(
            "语音模式 UI 预览",
            "自动演示一轮：待机 → 聆听 → 思考 → 播报+日程卡 → 中央媒体展示页 → 提示态。\n"
            "照片/视频在屏幕中央大图呈现，不会自动消失：点 ✕ 关闭"
            "（真实语音模式里还可对话说「把图片收了」让 agent 移除）。\n"
            "期间可悬停/拖动悬浮件；右键「打开主界面」退出。",
        )

    def start_listening():
        vol_timer.start(50)

    def stop_listening():
        vol_timer.stop()
        orb.set_volume(0.0)

    def show_schedule_card():
        stack.show_schedule(sample_items)

    def show_media_card():
        stage.show_media(sample_media, "http://127.0.0.1:3000")
        # 中央展示页的卡不在 CardStack 里，直接用 stage 持有的卡贴假缩略图
        if stage._card is not None:
            media_card = stage._card
            palettes = [("#5B8DEF", "#2B4C8C"), ("#E8896B", "#8C3B2B"),
                        ("#57B884", "#1F5C3D"), ("#9A7BD1", "#46307A")]
            for tile, (c1, c2) in zip(media_card._tiles, palettes):
                tile.set_pixmap(_fake_photo(448, 296, c1, c2))

    def show_note():
        orb.show_state(OrbState.NOTE, "没听清，请再说一遍")

    phases = [
        (6.0, lambda: orb.show_state(OrbState.IDLE)),
        (7.0, start_listening),
        (5.0, lambda: orb.show_state(OrbState.THINKING)),
        (7.0, lambda: (stop_listening(), orb.show_state(OrbState.SPEAKING), show_schedule_card())),
        (9.0, lambda: (orb.show_state(OrbState.IDLE), show_media_card())),
        (5.0, show_note),
    ]
    phase_idx = 0

    def run_phase():
        nonlocal phase_idx
        seconds, fn = phases[phase_idx]
        fn()
        QTimer.singleShot(int(seconds * 1000), advance)

    def advance():
        nonlocal phase_idx
        phase_idx += 1
        if phase_idx < len(phases):
            run_phase()
        # 演示完一轮即停在待机；中央媒体页保持展示，等用户 ✕ 关闭

    QTimer.singleShot(1200, show_intro)
    QTimer.singleShot(2500, run_phase)
    return app.exec()


if __name__ == "__main__":
    sys.exit(main())
