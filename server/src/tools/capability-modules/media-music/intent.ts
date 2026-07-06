/**
 * media.* 工具意图元数据 —— 用于 tool-search BM25 排序调权。
 *
 * 与 `intent-metadata.ts` 中 `DEFAULT_TOOL_INTENT_RULES` 同结构；
 * 通过 {@link setExtraIntentRules} 在启动时合并到全局规则表。
 *
 * 覆盖中英关键词（音乐 / 播放 / 暂停 / 歌曲 / music / play / pause / stop / resume /
 * now playing / media 等），让用户口语化指令能命中本模块工具。
 */
import type { ToolIntentRule } from "../../tool-search/intent-metadata.js";

export const MEDIA_MUSIC_INTENT_RULES: ToolIntentRule[] = [
  {
    prefix: "media.",
    metadata: {
      aliases: [
        "music", "song", "track", "album", "artist", "playlist",
        "play music", "pause music", "resume music", "stop music",
        "now playing", "media control", "media playback",
        "音乐", "歌曲", "歌", "专辑", "歌手", "播放", "放歌", "放一首歌",
        "来首歌", "暂停", "继续放", "别放了", "关掉音乐", "现在放的什么",
        "搜歌", "找首歌", "停一下",
      ],
      negativeAliases: [
        "phone call", "calendar reminder", "wallet transfer",
        "draw image", "generate image", "take screenshot",
        "smart home light",
      ],
      examples: [
        "放一首周杰伦的歌",
        "play some taylor swift",
        "搜一下晴天",
        "暂停一下",
        "now playing",
        "别放了",
      ],
      negativeExamples: [
        "画一只猫",
        "给我打个电话",
        "查一下天气",
        "把灯关了",
      ],
    },
  },
  {
    exact: "media.search",
    metadata: {
      aliases: [
        "search music", "find song", "find track", "search song",
        "搜歌", "找首歌", "查歌", "搜索歌曲",
      ],
      examples: ["搜一下晴天", "find a song by coldplay"],
      negativeExamples: ["search the web", "搜一下新闻"],
    },
  },
  {
    exact: "media.play",
    metadata: {
      aliases: [
        "play song", "play track", "play music", "start music",
        "放歌", "放一首", "来首歌", "播放音乐",
      ],
      examples: ["放一首周华健的朋友", "play despacito"],
      negativeExamples: ["play a phone call", "画一只猫"],
    },
  },
  {
    exact: "media.pause",
    metadata: {
      aliases: [
        "pause music", "halt music", "pause song",
        "暂停", "停一下", "暂停播放", "暂停音乐",
      ],
      examples: ["暂停一下", "pause the music"],
      negativeExamples: ["stop completely"],
    },
  },
  {
    exact: "media.resume",
    metadata: {
      aliases: [
        "resume music", "continue playing", "resume song",
        "继续放", "继续播放", "接着放", "恢复播放",
      ],
      examples: ["继续放", "resume playing"],
      negativeExamples: ["start a new song"],
    },
  },
  {
    exact: "media.stop",
    metadata: {
      aliases: [
        "stop music", "halt", "stop playing", "stop song",
        "别放了", "关掉音乐", "停止播放", "停止音乐",
      ],
      examples: ["别放了", "stop the music"],
      negativeExamples: ["pause only"],
    },
  },
  {
    exact: "media.now_playing",
    metadata: {
      aliases: [
        "now playing", "current song", "what's playing", "what song is this",
        "现在放的什么", "这首歌叫什么", "正在放什么",
      ],
      examples: ["现在放的什么歌", "what song is this"],
      negativeExamples: ["play a new song"],
    },
  },
];
