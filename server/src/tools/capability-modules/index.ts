/**
 * 能力模块总聚合入口。
 *
 * 每新增一个能力域：
 *   1. 在 `capability-modules/<name>/` 下加 chat-tools.ts / handlers.ts / intent.ts / index.ts
 *   2. 在下方 import + 加到 `buildCapabilityModules` 数组
 *   3. 在 `create-app-services.ts` 的 `capabilityModuleDeps` 里传入依赖
 *
 * 不需要改动：
 *   - `getBuiltinAgentChatTools`（自动合并）
 *   - `tool-search/intent-metadata.ts`（自动合并）
 *   - `tool-search/core-tool-library.ts`（默认 deferred，需要进核心时在此处声明）
 *   - `openai-compatible-tool-loop.ts` 的 `TOOL_CATEGORY_MAPPINGS`（在此处声明 category）
 */
import type { ChatCompletionTool } from "openai/resources/chat/completions";

import type { ToolRegistry } from "../tool-registry.js";
import type { ToolIntentRule } from "../tool-search/intent-metadata.js";
import type { ImageGenerationService } from "../../services/image-generation-service.js";
import type { FileProcessingService } from "../../services/file-processing-service.js";
import type { EmailSmsService } from "../../services/email-sms-service.js";
import type { MediaMusicService } from "../../services/media-music-service.js";
import type { HealthFitnessService } from "../../services/health-fitness-service.js";
import type { FinanceDeepService } from "../../services/finance-deep-service.js";
import type { SocialOutreachService } from "../../services/social-outreach-service.js";
import type { CodeSandboxService } from "../../services/code-sandbox-service.js";
import type { ShoppingOrderService } from "../../services/shopping-order-service.js";
import type { AgentBrowserService } from "../../services/agent-browser-service.js";
import type { WsConnectionRegistry } from "../../services/ws-connection-registry.js";

import {
  IMAGE_GEN_CHAT_TOOLS,
  IMAGE_GEN_INTENT_RULES,
  registerImageGenTools,
} from "./image-gen/index.js";
import {
  FILE_DOC_CHAT_TOOLS,
  FILE_DOC_INTENT_RULES,
  registerFileDocTools,
} from "./file-doc/index.js";
import {
  EMAIL_SMS_CHAT_TOOLS,
  EMAIL_SMS_INTENT_RULES,
  registerEmailSmsTools,
} from "./email-sms/index.js";
import {
  MEDIA_MUSIC_CHAT_TOOLS,
  MEDIA_MUSIC_INTENT_RULES,
  registerMediaMusicTools,
} from "./media-music/index.js";
import {
  HEALTH_FITNESS_CHAT_TOOLS,
  HEALTH_FITNESS_INTENT_RULES,
  registerHealthFitnessTools,
} from "./health-fitness/index.js";
import {
  FINANCE_DEEP_CHAT_TOOLS,
  FINANCE_DEEP_INTENT_RULES,
  registerFinanceDeepTools,
} from "./finance-deep/index.js";
import {
  SOCIAL_OUTREACH_CHAT_TOOLS,
  SOCIAL_OUTREACH_INTENT_RULES,
  registerSocialOutreachTools,
} from "./social-outreach/index.js";
import {
  CODE_SANDBOX_CHAT_TOOLS,
  CODE_SANDBOX_INTENT_RULES,
  CODE_SANDBOX_CATEGORY_MAPPING,
  registerCodeSandboxTools,
} from "./code-sandbox/index.js";
import {
  SHOPPING_ORDER_CHAT_TOOLS,
  SHOPPING_ORDER_INTENT_RULES,
  SHOPPING_ORDER_CATEGORY_MAPPING,
  registerShoppingOrderTools,
} from "./shopping-order/index.js";
import {
  AGENT_BROWSER_CHAT_TOOLS,
  AGENT_BROWSER_INTENT_RULES,
  AGENT_BROWSER_CATEGORY_MAPPING,
  registerAgentBrowserTools,
} from "./agent-browser/index.js";

/**
 * 能力模块描述符：把一个能力域的所有挂载点打包成单一对象，
 * 由 `getCapabilityModuleChatTools` / `getAllCapabilityModuleIntentRules` / `registerAllCapabilityModules`
 * 统一消费。
 */
export interface CapabilityModule {
  /** 域名，与 `agent-capabilities.ts` 的 `CapabilityDomain` 对齐 */
  domain: string;
  /** 模块标签（用于日志 / 调试） */
  label: string;
  /** LLM 工具 schema */
  chatTools: ChatCompletionTool[];
  /** 意图元数据规则，合并到 BM25 调权 */
  intentRules: ToolIntentRule[];
  /** 注册到 ToolRegistry */
  register: (registry: ToolRegistry) => void;
  /**
   * 关键词分类映射（用于 `TOOL_CATEGORY_MAPPINGS`）。
   * 命中关键词时把该模块的全部工具名注入到对应分类。
   */
  category?: {
    name: string;
    keywords: string[];
  };
}

/**
 * 能力模块依赖：所有模块需要的 service 在此声明。
 *
 * 启动时由 `create-app-services.ts` 构造后传入 `registerAllCapabilityModules`。
 */
export interface CapabilityModuleDeps {
  imageGenerationService: ImageGenerationService;
  fileProcessingService: FileProcessingService;
  emailSmsService: EmailSmsService;
  mediaMusicService: MediaMusicService;
  /** media-music 模块需要 ws 推送播放控制事件给客户端 */
  wsConnectionRegistry: WsConnectionRegistry;
  healthFitnessService: HealthFitnessService;
  financeDeepService: FinanceDeepService;
  socialOutreachService: SocialOutreachService;
  codeSandboxService: CodeSandboxService;
  shoppingOrderService: ShoppingOrderService;
  agentBrowserService: AgentBrowserService;
}

/**
 * 全部能力模块。
 *
 * ⚠️ 新增能力域时只改这里，不动其他文件。
 */
export function buildCapabilityModules(deps: CapabilityModuleDeps): CapabilityModule[] {
  return [
    {
      domain: "image_gen",
      label: "图像生成（text-to-image）",
      chatTools: IMAGE_GEN_CHAT_TOOLS,
      intentRules: IMAGE_GEN_INTENT_RULES,
      register: (registry) => registerImageGenTools(registry, { imageGenerationService: deps.imageGenerationService }),
      category: {
        name: "image",
        keywords: [
          "image", "picture", "photo", "draw", "paint", "generate",
          "txt2img", "diffusion", "kolors", "flux",
          "画", "画图", "画一张", "画个", "做图", "做张图",
          "生成图", "图片", "配图", "插图", "头像", "logo", "icon",
        ],
      },
    },
    {
      domain: "file_doc",
      label: "文件/文档处理（read/write/parse/export）",
      chatTools: FILE_DOC_CHAT_TOOLS,
      intentRules: FILE_DOC_INTENT_RULES,
      register: (registry) => registerFileDocTools(registry, { fileProcessingService: deps.fileProcessingService }),
      category: {
        name: "file_doc",
        keywords: [
          "file", "document", "doc", "pdf", "word", "excel", "spreadsheet",
          "parse", "export", "read file", "write file",
          "文件", "文档", "读取", "写入", "解析", "导出", "转换格式",
          "pdf", "word", "excel", "csv", "json", "markdown",
        ],
      },
    },
    {
      domain: "email_sms",
      label: "邮件/短信主动发送",
      chatTools: EMAIL_SMS_CHAT_TOOLS,
      intentRules: EMAIL_SMS_INTENT_RULES,
      register: (registry) => registerEmailSmsTools(registry, { emailSmsService: deps.emailSmsService }),
      category: {
        name: "email_sms",
        keywords: [
          "email", "mail", "smtp", "sms", "text message", "send email", "send sms",
          "邮件", "邮箱", "发邮件", "短信", "发短信", "验证码",
          "通知", "联系", "写信",
        ],
      },
    },
    {
      domain: "media_music",
      label: "媒体音乐播放控制",
      chatTools: MEDIA_MUSIC_CHAT_TOOLS,
      intentRules: MEDIA_MUSIC_INTENT_RULES,
      register: (registry) => registerMediaMusicTools(registry, {
        mediaMusicService: deps.mediaMusicService,
        wsConnectionRegistry: deps.wsConnectionRegistry,
      }),
      category: {
        name: "media_music",
        keywords: [
          "music", "song", "play", "pause", "resume", "stop", "now playing",
          "playlist", "track", "audio", "media", "player",
          "音乐", "歌曲", "播放", "暂停", "继续", "停止", "现在放",
          "歌单", "曲目", "音频", "媒体", "播放器", "听歌",
        ],
      },
    },
    {
      domain: "health_fitness",
      label: "健康/运动数据接入",
      chatTools: HEALTH_FITNESS_CHAT_TOOLS,
      intentRules: HEALTH_FITNESS_INTENT_RULES,
      register: (registry) => registerHealthFitnessTools(registry, { healthFitnessService: deps.healthFitnessService }),
      category: {
        name: "health_fitness",
        keywords: [
          "health", "fitness", "exercise", "workout", "step", "heart rate",
          "sleep", "calorie", "weight", "metric", "goal",
          "健康", "运动", "锻炼", "健身", "步数", "心率",
          "睡眠", "卡路里", "体重", "指标", "目标",
        ],
      },
    },
    {
      domain: "finance_deep",
      label: "财务深度能力",
      chatTools: FINANCE_DEEP_CHAT_TOOLS,
      intentRules: FINANCE_DEEP_INTENT_RULES,
      register: (registry) => registerFinanceDeepTools(registry, { financeDeepService: deps.financeDeepService }),
      category: {
        name: "finance_deep",
        keywords: [
          "finance", "transaction", "budget", "spending", "reconcile",
          "categorize", "report", "import", "money", "expense",
          "财务", "交易", "预算", "支出", "对账",
          "分类", "报告", "导入", "钱", "花费", "账单",
        ],
      },
    },
    {
      domain: "social_outreach",
      label: "社交主动出击（外部平台）",
      chatTools: SOCIAL_OUTREACH_CHAT_TOOLS,
      intentRules: SOCIAL_OUTREACH_INTENT_RULES,
      register: (registry) => registerSocialOutreachTools(registry, { socialOutreachService: deps.socialOutreachService }),
      category: {
        name: "social_outreach",
        keywords: [
          "twitter", "weibo", "xiaohongshu", "xhs", "moments", "朋友圈",
          "post", "tweet", "comment", "repost", "like", "feed",
          "发帖", "推文", "评论", "转发", "点赞", "动态",
          "社交", "平台", "发布",
        ],
      },
    },
    {
      domain: "code_sandbox",
      label: "代码执行沙盒（python / node）",
      chatTools: CODE_SANDBOX_CHAT_TOOLS,
      intentRules: CODE_SANDBOX_INTENT_RULES,
      register: (registry) => registerCodeSandboxTools(registry, { codeSandboxService: deps.codeSandboxService }),
      category: CODE_SANDBOX_CATEGORY_MAPPING,
    },
    {
      domain: "shopping_order",
      label: "购物/下单（后台无头浏览器代用户下单）",
      chatTools: SHOPPING_ORDER_CHAT_TOOLS,
      intentRules: SHOPPING_ORDER_INTENT_RULES,
      register: (registry) => registerShoppingOrderTools(registry, { shoppingOrderService: deps.shoppingOrderService }),
      category: SHOPPING_ORDER_CATEGORY_MAPPING,
    },
    {
      domain: "agent_browser",
      label: "Agent 虚拟浏览器（通用网页多步操作）",
      chatTools: AGENT_BROWSER_CHAT_TOOLS,
      intentRules: AGENT_BROWSER_INTENT_RULES,
      register: (registry) => registerAgentBrowserTools(registry, { agentBrowserService: deps.agentBrowserService }),
      category: AGENT_BROWSER_CATEGORY_MAPPING,
    },
  ];
}

/** 合并所有能力模块的 ChatCompletionTool schema。 */
export function getCapabilityModuleChatTools(deps: CapabilityModuleDeps): ChatCompletionTool[] {
  const modules = buildCapabilityModules(deps);
  const all: ChatCompletionTool[] = [];
  for (const m of modules) all.push(...m.chatTools);
  return all;
}

/** 合并所有能力模块的意图元数据规则。 */
export function getAllCapabilityModuleIntentRules(deps: CapabilityModuleDeps): ToolIntentRule[] {
  const modules = buildCapabilityModules(deps);
  const all: ToolIntentRule[] = [];
  for (const m of modules) all.push(...m.intentRules);
  return all;
}

/** 把所有能力模块的 handler 注册到 ToolRegistry。 */
export function registerAllCapabilityModules(
  registry: ToolRegistry,
  deps: CapabilityModuleDeps,
): void {
  const modules = buildCapabilityModules(deps);
  for (const m of modules) m.register(registry);
}

/**
 * 暴露给 `openai-compatible-tool-loop.ts` 的 `TOOL_CATEGORY_MAPPINGS` 合并入口。
 *
 * 调用方在 `selectRelevantTools` 阶段把这些映射合并进去，
 * 让关键词命中时把对应模块的工具名加入候选。
 */
export function getCapabilityModuleCategoryMappings(
  deps: CapabilityModuleDeps,
): Array<{ category: string; keywords: string[]; toolNames: string[] }> {
  const modules = buildCapabilityModules(deps);
  return modules.flatMap((m) => {
    if (!m.category) return [];
    const toolNames = m.chatTools
      .map((t) => (t.type === "function" && t.function?.name ? t.function.name : null))
      .filter((n): n is string => Boolean(n));
    return [{
      category: m.category.name,
      keywords: m.category.keywords,
      toolNames,
    }];
  });
}
