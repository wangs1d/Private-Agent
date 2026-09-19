import type { ChatCompletionTool } from "openai/resources/chat/completions";

/**
 * 安全守护能力域 —— ChatCompletionTool schema。
 *
 * 共 5 个工具：
 *   - safety.set_contact     新增/更新紧急联系人
 *   - safety.get_contacts    查询紧急联系人（手机号脱敏）
 *   - safety.remove_contact  移除紧急联系人
 *   - safety.sos             触发紧急求助（定位 + 联系人短信 + 全设备告警）
 *   - safety.fake_call       借口来电（真实外呼用户手机，走电话代办确认门）
 *
 * SOS 是唯一「零确认门」的工具：用户说出求助信号时每一步延迟都是代价，
 * 误触防护由客户端触发层（倒计时撤销）负责。安全设置（本人手机号/SOS 备注）
 * 复用 safety.set_contact 的 settings 字段承载，不单开工具。
 */
export const SAFETY_GUARD_CHAT_TOOLS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "safety.set_contact",
      description:
        "新增或更新紧急联系人（最多 5 位；首位自动设为主联系人）。同手机号自动合并为更新。\n" +
        "适用场景：「把妈妈设为紧急联系人，13812345678」「再加一个闺蜜」「备注她是室友」。\n" +
        "也可以用本工具设置安全偏好：把 contact 字段留空、只传 settings。",
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "联系人称呼（必填，设置偏好时留空）。",
          },
          phone: {
            type: "string",
            description: "手机号（新增联系人时必填）。",
          },
          relationship: {
            type: "string",
            description: "关系（可选）：家人 / 闺蜜 / 室友 / 同事 等。",
          },
          is_primary: {
            type: "boolean",
            description: "设为主联系人（SOS 时第一个通知）。可选。",
          },
          settings: {
            type: "object",
            description: "安全偏好设置（可选，与联系人互不冲突可同时传）：",
            properties: {
              my_mobile_number: {
                type: "string",
                description: "用户本人手机号（借口来电拨往这个号码）。",
              },
              sos_note: {
                type: "string",
                description: "SOS 短信附加信息：过敏史 / 血型 / 慢病等，供联系人转告急救。谨慎录入，仅存本地加密文件。",
              },
              fake_call_script: {
                type: "string",
                description: "借口来电默认话术要点。",
              },
            },
            additionalProperties: false,
          },
        },
        required: [],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "safety.get_contacts",
      description:
        "查询紧急联系人与安全设置（手机号脱敏展示）。适用场景：「我的紧急联系人有谁」。",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "safety.remove_contact",
      description: "移除紧急联系人。适用场景：「把室友从紧急联系人里删掉」。",
      parameters: {
        type: "object",
        properties: {
          contact_id: {
            type: "string",
            description: "联系人 id（来自 safety.get_contacts；不要凭记忆编 id）。",
          },
        },
        required: ["contact_id"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "safety.sos",
      description:
        "【紧急 · 无需确认】触发紧急求助：立即获取一次实时定位，向全部紧急联系人发求助短信" +
        "（含位置链接），并向用户所有设备推送告警。用户表达求助信号时必须直接调用本工具，" +
        "禁止用 search_web 搜索如何求助来替代——求助场景每一秒都宝贵。触发话术包括但限于：" +
        "「救命/SOS/帮我通知紧急联系人/帮我给我妈发个消息说我有危险/深夜打车有点害怕/我觉得被跟踪」。\n" +
        "未配置联系人时返回 needsSetup——此时第一句话应该是「请立即拨打 110」。\n" +
        "本工具不替代报警：转述结果时永远同时提醒用户可直接拨打 110/120。",
      parameters: {
        type: "object",
        properties: {
          reason: {
            type: "string",
            description: "情况简述（可选，会写进求助短信）：如「深夜打车，司机偏离路线」。",
          },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "safety.fake_call",
      description:
        "借口来电：向用户本人手机拨一通真实电话（显示为「小助手」来电），制造自然离开/" +
        "脱身的理由。用户说「给我打个电话/打个电话给我/来个电话/找个借口离开/帮我脱身」时" +
        "必须直接调用本工具，不要用 search_web 搜索或只给话术建议来替代——本服务端就有真实" +
        "拨号通道。走电话代办确认门：用户聊天确认 + 手机全屏二次确认后才拨出。未配置本人" +
        "手机号时返回 needsSetup。",
      parameters: {
        type: "object",
        properties: {
          goal: {
            type: "string",
            description: "来电事由的一句话描述（展示在确认弹窗）。",
          },
          script: {
            type: "string",
            description: "自定义话术要点（可选；不传用用户预设）。",
          },
        },
        additionalProperties: false,
      },
    },
  },
];
