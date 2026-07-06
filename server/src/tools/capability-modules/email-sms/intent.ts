/**
 * email-sms 工具意图元数据 —— 用于 tool-search BM25 排序调权。
 *
 * 与 `intent-metadata.ts` 中 `DEFAULT_TOOL_INTENT_RULES` 同结构；
 * 通过 {@link registerCapabilityModuleIntentRules} 在启动时合并到全局规则表。
 *
 * 覆盖中英关键词：邮件 / 发邮件 / 写信 / mail / email / smtp、
 *                 短信 / 发短信 / sms / text message 等。
 *
 * 与 phone.call_user 区分：phone.* 是语音触达（电话振铃），
 *                          email.send / sms.send 是异步文本触达（无振铃）。
 */
import type { ToolIntentRule } from "../../tool-search/intent-metadata.js";

export const EMAIL_SMS_INTENT_RULES: ToolIntentRule[] = [
  // 域级前缀规则：覆盖整个 email.* / sms.* 命名空间
  {
    prefix: "email.",
    metadata: {
      aliases: [
        "email", "mail", "send email", "compose email", "write email",
        "smtp", "outbound email",
        "邮件", "发邮件", "写邮件", "写信", "发封信", "邮箱", "发到邮箱",
      ],
      negativeAliases: [
        "phone call", "voice call", "text message", "sms",
        "calendar reminder", "wallet transfer",
        "打电话", "发短信", "语音", "电话",
      ],
      examples: [
        "发邮件给 zhangsan 告诉他会议改时间",
        "把这封信发到 a@b.com",
        "send an email to john about the report",
        "mail him the summary",
      ],
      negativeExamples: [
        "给我打个电话",
        "给他发条短信",
        "把灯关了",
      ],
    },
  },
  {
    prefix: "sms.",
    metadata: {
      aliases: [
        "sms", "text message", "text him", "text her", "send sms",
        "short message", "send a text",
        "短信", "发短信", "发短消息", "短消息", "发条短信",
      ],
      negativeAliases: [
        "phone call", "voice call", "email", "mail",
        "calendar reminder", "wallet transfer",
        "打电话", "发邮件", "语音", "邮件",
      ],
      examples: [
        "发短信给 13800138000 告诉他我晚到 10 分钟",
        "给他发条短消息",
        "text him that I'm running late",
        "send an SMS to confirm the appointment",
      ],
      negativeExamples: [
        "发邮件给 zhangsan",
        "给我打个电话",
        "把灯关了",
      ],
    },
  },
  // 工具级精确规则
  {
    exact: "email.send",
    metadata: {
      aliases: [
        "send email", "compose email", "write email", "send mail", "email to",
        "发邮件", "写邮件", "写信", "发封信", "发到邮箱", "寄邮件",
      ],
      examples: [
        "发邮件给 a@b.com 主题是周报",
        "把这份总结发到他的邮箱",
        "send an email to john with this summary",
      ],
      negativeExamples: [
        "给他发条短信",
        "给我打个电话",
      ],
    },
  },
  {
    exact: "sms.send",
    metadata: {
      aliases: [
        "send sms", "send text", "text message", "send a text",
        "发短信", "发短消息", "发条短信", "短信发送",
      ],
      examples: [
        "发短信提醒他开会",
        "给他发条短消息说我会晚到",
        "send a text message to 13800138000",
      ],
      negativeExamples: [
        "发邮件给他",
        "给他打个电话",
      ],
    },
  },
];
