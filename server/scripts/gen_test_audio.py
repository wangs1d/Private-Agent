"""
用 Windows SAPI5 生成中文测试 wav（修复 SpFileStream 用法）。
"""
import os
import sys
import time
from pathlib import Path

try:
    import win32com.client
except ImportError:
    print("[ERR] 需要 pywin32：pip install pywin32")
    sys.exit(1)


def synth_wav(text: str, out_path: Path) -> int:
    """用 SAPI5 SpVoice + SpFileStream 写 WAV，返回文件大小 bytes。"""
    speaker = win32com.client.Dispatch("SAPI.SpVoice")

    # 列出可用 voices
    voices = speaker.GetVoices()
    zh_voice = None
    for i in range(voices.Count):
        v = voices.Item(i)
        desc = v.GetDescription()
        if "Chinese" in desc or "zh" in desc.lower() or "中文" in desc:
            zh_voice = v
            break
    if zh_voice:
        speaker.Voice = zh_voice
        print(f"  使用 voice: {zh_voice.GetDescription()}")
    else:
        print(f"  [WARN] 未找到中文 voice，使用默认 {voices.Item(0).GetDescription()}")

    # 创建 file stream
    stream = win32com.client.Dispatch("SAPI.SpFileStream")
    fmt = win32com.client.Dispatch("SAPI.SpAudioFormat")
    fmt.Type = 22  # SAFT22kHz16BitMono
    stream.Format = fmt
    # SSFMCreateForWrite = 3
    stream.Open(str(out_path), 3, False)
    speaker.AudioOutputStream = stream
    # SVSFDefault = 0, SVSFPurgeBeforeSpeak = 2，同步写
    speaker.Speak(text, 0)
    stream.Close()
    return out_path.stat().st_size


def main():
    cases = [
        ("你好，今天天气怎么样", "case_0.wav", "短句-日常问候"),
        ("我要预约明天下午三点的会议室", "case_1.wav", "中句-日程预约"),
        ("帮我搜索一下北京到上海的高铁票，明天早上的车次", "case_2.wav", "长句-复杂查询"),
        ("1加2等于3，10乘以20等于200", "case_3.wav", "数字识别"),
        ("I love programming in TypeScript and Python", "case_4.wav", "中英混合"),
    ]

    out_dir = Path("data/funasr_test_audio")
    out_dir.mkdir(parents=True, exist_ok=True)

    for text, fname, label in cases:
        out_path = out_dir / fname
        print(f"[{label}] 合成：{text}")
        try:
            size = synth_wav(text, out_path)
            print(f"  → {out_path} ({size} bytes)")
            if size < 100:
                print(f"  [WARN] 文件过小，可能合成失败")
        except Exception as e:
            print(f"  [ERR] {e}")

    print("\nDone.")


if __name__ == "__main__":
    main()
