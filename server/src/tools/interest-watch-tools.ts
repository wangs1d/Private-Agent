// 工具：interest.manage —— 用户兴趣关注列表管理（LLM 在对话中自主调用）
//
// 对标扣子「Database 关注列表」：模型听到用户表达长期兴趣
// （「我喜欢刘浩存」「我是王者荣耀玩家」「我一直在关注某股票」）时，
// 主动调本工具把兴趣写进池；后台 InterestWatcher 定时盯这些兴趣的热搜动态。
//
// 安全性：本工具只写内存态关注列表，无任何外部副作用（不读文件、不触网、
// 不调第三方），add/remove/list 全部回滚安全。
import type { InterestType, InterestWatcher } from "../proactivity/interest-watcher.js";
import { resolveActorId } from "../agent/actor-id.js";
import type { ToolRegistry } from "./tool-registry.js";
import type { ChatCompletionTool } from "openai/resources/chat/completions";

/** 规范化工具入参里的兴趣类型（中文/英文容错），非法值回退 other */
function parseType(raw: unknown): InterestType {
  const v = String(raw ?? "").trim();
  if (!v) return "other";
  return v as InterestType;
}

/**
 * interest.manage 的 LLM 工具声明（并入 getBuiltinAgentChatTools）。
 * 让模型在对话中看到完整的描述与参数；执行体在 registerInterestWatchTools。
 */
export const INTEREST_WATCH_CHAT_TOOLS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "interest.manage",
      description: [
        "用户兴趣关注列表管理（兴趣话题追踪）。",
        "当用户明确表达对某人/事/物的长期兴趣时（如「我喜欢刘浩存」「我是XX的粉丝」「最近一直在关注某股票/游戏/品牌」）",
        "调本工具 action=add 把兴趣名写入关注列表；后续对话再次提到时用 action=touch 续命；",
        "用户明确表示不再关注/不喜欢时用 action=remove 移除；action=list 查看当前列表。",
        "后台会自动关注这些兴趣的热搜动态并及时告知用户。",
      ].join(" "),
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["add", "touch", "remove", "list"],
            description: "操作类型：add 新增、touch 提及续命、remove 移除、list 查看",
          },
          name: {
            type: "string",
            description: "兴趣名（如「刘浩存」「王者荣耀」）；action=add/touch/remove 必填",
          },
          type: {
            type: "string",
            enum: ["person", "brand", "work", "stock", "game", "other"],
            description:
              "兴趣类型：person 人物 / brand 品牌 / work 作品（影视剧书）/ stock 股票基金 / game 游戏 / other 其他",
          },
        },
        required: ["action"],
        additionalProperties: false,
      },
    },
  },
];

/**
 * 注册兴趣管理工具。
 * @param toolRegistry 统一工具注册中心
 * @param watcher InterestWatcher 实例（装配层注入）
 */
export function registerInterestWatchTools(
  toolRegistry: ToolRegistry,
  watcher: InterestWatcher,
): void {
  toolRegistry.register(
    "interest.manage",
    async (input, context) => {
      const action = String(input?.action ?? "").trim().toLowerCase();
      const actorId = resolveActorId(context);
      const name = input?.name;
      const type = parseType(input?.type);

      try {
        switch (action) {
          case "add": {
            if (!name) return { ok: false, error: "action=add 需要提供 name（兴趣名）" };
            const list = await watcher.addInterest(actorId, name, type);
            return okWithList(list, `已把「${String(name)}」加入关注列表，后台会留意它的热点动态。`);
          }
          case "touch": {
            if (!name) return { ok: false, error: "action=touch 需要提供 name（兴趣名）" };
            const list = await watcher.touchInterest(actorId, name);
            return okWithList(list, `已更新「${String(name)}」的关注活跃度。`);
          }
          case "remove": {
            if (!name) return { ok: false, error: "action=remove 需要提供 name（要移除的兴趣名）" };
            const list = await watcher.removeInterest(actorId, name);
            return okWithList(list, `已把「${String(name)}」从关注列表移除。`);
          }
          case "list": {
            const list = watcher.listInterests(actorId);
            return okWithList(list, "当前关注列表：");
          }
          default:
            return {
              ok: false,
              error:
                `未知 action「${action || "(空)"}」。` +
                `可选：add（新增关注）/ touch（提及续命）/ remove（移除）/ list（查看）。`,
            };
        }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
    {
      category: "life",
      sideEffect: "none",
      riskLevel: "low",
    },
  );

  function okWithList(
    list: ReturnType<InterestWatcher["listInterests"]>,
    message: string,
  ): Record<string, unknown> {
    const label: Record<string, string> = {
      person: "人物",
      brand: "品牌",
      work: "作品",
      stock: "股票基金",
      game: "游戏",
      other: "其他",
    };
    return {
      ok: true,
      message,
      count: list.length,
      interests: list.map((i) => ({
        name: i.name,
        type: i.type,
        typeLabel: label[i.type],
        mentionCount: i.mentionCount,
        enabled: i.enabled,
      })),
    };
  }
}