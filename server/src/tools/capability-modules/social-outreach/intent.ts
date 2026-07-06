/**
 * social-outreach 工具意图元数据 —— 用于 tool-search BM25 排序调权。
 *
 * 与 `intent-metadata.ts` 中 `DEFAULT_TOOL_INTENT_RULES` 同结构；
 * 通过 {@link registerCapabilityModuleIntentRules} 在启动时合并到全局规则表。
 *
 * 覆盖中英关键词：社交 / 发帖 / 评论 / 转发 / 点赞 / 微博 / Twitter / 小红书 / 朋友圈、
 *                 social / post / tweet / retweet / like / comment / timeline / feed 等。
 *
 * 与 `world.social.*`（Agent 内部世界社交）严格区分：
 *   - world.social.*     = 内部社交网页（游戏化世界，与 world.* / wallet.* 同域）
 *   - social.*（本模块） = 外部真实社交平台（Twitter / 微博 / 小红书 / 朋友圈）
 * 用 negativeAliases / negativeExamples 把 world.social 的命中场景剥离，
 * 避免意图混淆。
 */
import type { ToolIntentRule } from "../../tool-search/intent-metadata.js";

export const SOCIAL_OUTREACH_INTENT_RULES: ToolIntentRule[] = [
  // 域级前缀规则：覆盖整个 social.* 命名空间
  {
    prefix: "social.",
    metadata: {
      aliases: [
        "social", "social media", "social outreach", "outreach",
        "post", "tweet", "retweet", "quote tweet", "reply",
        "like", "favorite", "fav",
        "timeline", "feed", "home timeline",
        "twitter", "x.com", "weibo", "xiaohongshu", "rednote", "wechat moments",
        "社交媒体", "社交平台", "发帖", "发推", "发条推", "发推特",
        "发微博", "发条微博", "发动态", "评论", "回个评论", "回复帖子",
        "转发", "转推", "引用转发", "点赞", "赞一下", "收藏",
        "小红书", "发笔记", "朋友圈", "发朋友圈",
      ],
      negativeAliases: [
        "world social", "agent world", "world credits",
        "skill purchase", "free market", "agent world social",
        "email", "mail", "sms", "phone call",
        "smart home", "light control",
        "世界社交", "世界点数", "技能商店", "技能购买",
        "发邮件", "打电话", "关灯",
      ],
      examples: [
        "发条推特说今天天气不错",
        "把这段发到微博",
        "转发这条微博",
        "给这条推特点个赞",
        "评论这条微博说赞同",
        "看看我 Twitter 时间线有什么新动态",
        "在微博搜一下 AI 这个话题",
        "post this to twitter",
        "retweet that tweet",
        "like the weibo post",
      ],
      negativeExamples: [
        "在世界社交平台发帖（用 world.social.post）",
        "购买世界技能（用 world.free_market.purchase）",
        "发邮件给 zhangsan",
        "把灯关了",
      ],
    },
  },
  // 工具级精确规则
  {
    exact: "social.post",
    metadata: {
      aliases: [
        "post to social", "post tweet", "send tweet", "publish tweet", "compose tweet",
        "post to twitter", "send to weibo", "weibo status",
        "发推", "发推特", "发条推", "发微博", "发条微博",
        "发动态", "发朋友圈", "发小红书", "发笔记",
      ],
      examples: [
        "在 Twitter 发一条「Hello World」",
        "发条微博说今天心情不错",
        "把这段话发到朋友圈",
        "post this to my twitter",
      ],
      negativeExamples: [
        "评论这条推文",
        "转发这条微博",
        "给这条推特点个赞",
      ],
    },
  },
  {
    exact: "social.comment",
    metadata: {
      aliases: [
        "comment on post", "reply to tweet", "reply to post", "comment on weibo",
        "评论", "回评论", "回复帖子", "回个评论", "在微博评论",
      ],
      examples: [
        "评论这条微博说「赞同」",
        "在这条推文下面回复一下",
        "reply to that tweet with thanks",
      ],
      negativeExamples: [
        "发条新推",
        "转发这条微博",
        "给这条点赞",
      ],
    },
  },
  {
    exact: "social.repost",
    metadata: {
      aliases: [
        "retweet", "repost", "quote tweet", "share post", "share tweet",
        "weibo repost", "weibo repost status",
        "转发", "转推", "转微博", "引用转发", "引用推文", "分享推文",
      ],
      examples: [
        "转发这条微博",
        "retweet this tweet",
        "引用转发那条推文并附评论",
      ],
      negativeExamples: [
        "新发一条推文",
        "评论这条微博",
        "点赞这条",
      ],
    },
  },
  {
    exact: "social.like",
    metadata: {
      aliases: [
        "like post", "like tweet", "favorite tweet", "fav tweet",
        "weibo favorite", "weibo fav",
        "点赞", "赞一下", "赞", "收藏微博", "收藏帖子",
      ],
      examples: [
        "给这条推特点个赞",
        "点赞这条微博",
        "like that tweet",
      ],
      negativeExamples: [
        "评论这条",
        "转发这条",
        "新发一条",
      ],
    },
  },
  {
    exact: "social.get_feed",
    metadata: {
      aliases: [
        "get feed", "get timeline", "home timeline", "twitter feed", "weibo feed",
        "my timeline", "scroll timeline", "browse feed",
        "时间线", "拉取时间线", "看看时间线", "微博首页", "首页动态", "刷推特", "刷微博",
      ],
      examples: [
        "看看我 Twitter 时间线有什么新动态",
        "微博首页有什么新帖",
        "show my twitter feed",
      ],
      negativeExamples: [
        "搜索关于 AI 的推文",
        "发一条新推",
      ],
    },
  },
  {
    exact: "social.search_posts",
    metadata: {
      aliases: [
        "search posts", "search tweets", "search weibo", "search topic",
        "find tweets", "find posts about", "topic search",
        "搜索帖子", "搜索推文", "搜推文", "微博搜索", "搜话题", "搜关键词",
      ],
      examples: [
        "在 Twitter 搜索一下 OpenAI 这个话题",
        "在微博搜 AI 关键词",
        "search tweets about openai",
      ],
      negativeExamples: [
        "看看我自己的时间线",
        "发一条新推",
      ],
    },
  },
];
