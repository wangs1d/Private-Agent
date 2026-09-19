import type { ChatCompletionTool } from "openai/resources/chat/completions";

/**
 * 生理周期关怀能力域 —— ChatCompletionTool schema。
 *
 * 共 6 个工具：
 *   - period.log_start     记录经期开始（含流量/痛经/症状）
 *   - period.log_end       记录经期结束
 *   - period.log_daily     单日状态打卡（疼痛/情绪/症状）
 *   - period.status        当前周期状态 + 预测（下次开始日与区间）
 *   - period.history       近几次经期历史
 *   - period.set_reminder  提醒与周期偏好设置
 *
 * 走 deferred（BM25 索引）：关键词（月经/例假/痛经/生理期…）命中时由
 * tool_discover 拉出。语气要求写进 description：关怀不说教，预测必须带
 * 「估算、非医学结论」边界。
 */
export const PERIOD_CARE_CHAT_TOOLS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "period.log_start",
      description:
        "记录经期开始。适用场景：用户说「我来月经了/大姨妈来了/例假开始了/今天见红了」。\n" +
        "只要用户提到本次经期开始，必须先调用本工具记录，再给关怀建议——先记录后关心，" +
        "不要只安慰不记录（不记录则周期预测永远无法建立）。\n" +
        "可一并记录第一天流量、痛经程度与症状。返回当前周期状态与预测。\n" +
        "语气要求：自然平和，不追问细节、不评论用户的生活方式。",
      parameters: {
        type: "object",
        properties: {
          date: {
            type: "string",
            description: "开始日期（可选）。YYYY-MM-DD 或 ISO 8601；不传则为今天。补录历史时填写。",
          },
          flow: {
            type: "string",
            enum: ["light", "medium", "heavy"],
            description: "第一天流量：light 偏少 / medium 正常 / heavy 偏多。可选。",
          },
          pain: {
            type: "number",
            description: "痛经程度 0-10（用户自评）。可选。用户说「有点疼」≈3，「很疼」≈7，「疼到冒冷汗/影响活动」≥8。",
          },
          symptoms: {
            type: "array",
            items: { type: "string" },
            description: "症状标签（可选）：cramps 痛经 / headache 头痛 / bloating 腹胀 / fatigue 乏力 / mood_swings 情绪波动 / acne 长痘 / backache 腰酸 等。",
          },
          note: {
            type: "string",
            description: "备注（可选），原样保存。",
          },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "period.log_end",
      description:
        "记录经期结束。适用场景：用户说「月经结束了/走了/干净了」。\n" +
        "自动补到最近一次未结束的经期记录上。没有进行中的记录时返回错误。",
      parameters: {
        type: "object",
        properties: {
          date: {
            type: "string",
            description: "结束日期（可选）。YYYY-MM-DD 或 ISO 8601；不传则为今天。",
          },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "period.log_daily",
      description:
        "记录某天的生理状态打卡（疼痛/情绪/症状/备注），同日重复调用为补全。\n" +
        "适用场景：用户说「今天肚子有点不舒服」「这两天情绪不太好」「痛经，吃了布洛芬」等，\n" +
        "且不属于经期开始/结束的场景。",
      parameters: {
        type: "object",
        properties: {
          date: {
            type: "string",
            description: "日期（可选）。YYYY-MM-DD 或 ISO 8601；不传则为今天。",
          },
          pain: {
            type: "number",
            description: "不适/疼痛程度 0-10（可选）。",
          },
          mood: {
            type: "string",
            description: "情绪标签（可选）：如 平静 / 烦躁 / 低落 / 愉悦 / 焦虑。",
          },
          symptoms: {
            type: "array",
            items: { type: "string" },
            description: "症状标签（可选），同 period.log_start。",
          },
          note: {
            type: "string",
            description: "备注（可选）。",
          },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "period.status",
      description:
        "查询当前周期状态与预测：是否在经期、周期第几天、预测下次开始日与区间、置信度。\n" +
        "适用场景：「我大姨妈什么时候来」「现在是安全期吗」（只答周期日，不答避孕建议）、\n" +
        "「这个月会不会在出差的时候来」。\n" +
        "转述时必须带上「估算、非医学结论」属性，不要说「一定会」。",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "period.history",
      description:
        "查询近几次经期记录（开始/结束日、流量、痛经、症状）。\n" +
        "适用场景：「我最近几次月经是什么时候」「上个月痛经严不严重」。",
      parameters: {
        type: "object",
        properties: {
          limit: {
            type: "integer",
            description: "返回条数上限，1-60，默认 12。",
          },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "period.set_reminder",
      description:
        "设置经期临近提醒与周期偏好。适用场景：「月经来之前提前两天提醒我」「我的周期一般是32天」\n" +
        "「早上十点提醒」「别提醒了」。只传需要修改的字段。",
      parameters: {
        type: "object",
        properties: {
          enabled: {
            type: "boolean",
            description: "是否开启经期临近提醒。",
          },
          days_before: {
            type: "number",
            description: "提前几天提醒（0-7）。0=当天早上提醒。",
          },
          hour: {
            type: "number",
            description: "提醒时刻（0-23 点）。",
          },
          cycle_length: {
            type: "number",
            description: "自报平均周期天数（15-90）。设置后覆盖统计预测。",
          },
          period_length: {
            type: "number",
            description: "自报经期持续天数（1-14）。",
          },
        },
        additionalProperties: false,
      },
    },
  },
];
