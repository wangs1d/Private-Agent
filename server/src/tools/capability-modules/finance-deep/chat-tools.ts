import type { ChatCompletionTool } from "openai/resources/chat/completions";

/**
 * 深度财务分析能力域 —— ChatCompletionTool schema。
 *
 * 共 7 个工具：
 *   - finance.import_transactions  批量导入交易记录（CSV/JSON）
 *   - finance.analyze_spending    消费分析（按类别 / 时间段聚合）
 *   - finance.set_budget          设置预算（按月 / 按类别）
 *   - finance.get_budget_status   查询预算执行进度
 *   - finance.reconcile           自动对账：找出账单 vs 已记录差异
 *   - finance.categorize          自动分类一笔交易
 *   - finance.export_report       导出财务报告（markdown / csv / json）
 *
 * 走 deferred（BM25 索引），不进 CORE_TOOL_LIBRARY：
 *   1. 用户不是每轮都会查账本 / 预算
 *   2. 关键词触发（"账单" / "预算" / "对账" / "月度报告"）时由 tool_discover 拉出
 *
 * 与 wallet.* / budget.calculate 区分：
 *   - wallet.* 是单条即时操作（转账 / 充值 / 单笔购买）
 *   - budget.calculate 是一次性粗略估算（输入 income/rent/food/transport 出 remain）
 *   - finance.* 维护完整账本 + 预算执行 + 对账 + 报告
 */
export const FINANCE_DEEP_CHAT_TOOLS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "finance.import_transactions",
      description:
        "批量导入交易记录到用户账本，落盘到 data/finance/{actorId}/transactions.json。\n" +
        "支持两种格式：\n" +
        "  - json：JSON 数组字符串，每个元素 { date, amount, type, category?, merchant?, description?, source? }\n" +
        "  - csv：CSV 文本，首行表头 date,amount,type,category,merchant,description（后三个可空）\n" +
        "未分类（category 为空或非法）会自动按 description 关键词分类。\n" +
        "适用场景：用户粘贴一段账单 / 银行流水 / 支付宝微信导出。",
      parameters: {
        type: "object",
        properties: {
          format: {
            type: "string",
            enum: ["json", "csv"],
            description: "数据格式：json 或 csv。",
          },
          data: {
            type: "string",
            description:
              "数据内容字符串。json 时为 JSON 数组文本；csv 时为带表头的 CSV 文本。",
          },
          source: {
            type: "string",
            description:
              "数据来源标记（可选）。如 alipay / wechat / bank / manual。会写入每条记录的 source 字段。",
          },
        },
        required: ["format", "data"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "finance.analyze_spending",
      description:
        "消费分析：按类别 / 时间段聚合，返回 top 类别 / 趋势 / 异常。\n" +
        "返回字段：totalExpense / totalIncome / net / count / byCategory / byMonth / topCategories / anomalies / trend。\n" +
        "适用场景：用户问「这个月花了多少」「最近30天消费分析」「哪个类别花得最多」「消费趋势怎么样」。",
      parameters: {
        type: "object",
        properties: {
          from: {
            type: "string",
            description: "起始时间 ISO 8601（含）。未传则默认近 30 天。如 \"2025-07-01T00:00:00+08:00\"。",
          },
          to: {
            type: "string",
            description: "结束时间 ISO 8601（含）。未传则到当前时间。",
          },
          groupBy: {
            type: "string",
            enum: ["category", "month"],
            description:
              "聚合维度。category=按类别（默认）/ month=按月。两者都返回 byCategory，month 额外返回 byMonth。",
          },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "finance.set_budget",
      description:
        "设置预算（按月 / 按类别，如餐饮 2000/月）。\n" +
        "同类别同周期的预算会覆盖旧预算（不叠加）。\n" +
        "适用场景：用户说「设餐饮预算2000」「每月交通不超过500」「今年购物预算2万」。",
      parameters: {
        type: "object",
        properties: {
          category: {
            type: "string",
            enum: ["餐饮", "交通", "购物", "娱乐", "医疗", "教育", "居住", "工资", "其他"],
            description: "预算类别。如 餐饮 / 交通 / 购物 / 娱乐 / 医疗 / 教育 / 居住。",
          },
          amount: {
            type: "number",
            description: "预算金额（正数）。如 2000 表示 2000 元。",
          },
          period: {
            type: "string",
            enum: ["monthly", "yearly"],
            description: "周期：monthly 月度 / yearly 年度。",
          },
          startDate: {
            type: "string",
            description: "起始日期 ISO 8601（可选）。未传则用当前日期。如 \"2025-07-01\"。",
          },
          endDate: {
            type: "string",
            description: "结束日期 ISO 8601（可选）。不传则永久有效。",
          },
        },
        required: ["category", "amount", "period"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "finance.get_budget_status",
      description:
        "查询预算执行进度：已花 / 剩余 / 警告级别。\n" +
        "警告级别：ok（<80%）/ warning（80%~100%）/ exceeded（≥100%）。\n" +
        "适用场景：用户问「预算还剩多少」「这个月餐饮花了多少」「预算超支了吗」。",
      parameters: {
        type: "object",
        properties: {
          month: {
            type: "string",
            description:
              "查询月份 YYYY-MM（可选）。未传则用当前月。如 \"2025-07\"。年度预算会按当年聚合。",
          },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "finance.reconcile",
      description:
        "自动对账：用户给的账单（expectedItems）vs 已记录交易，找出差异。\n" +
        "返回：onlyInRecords（已记录但账单没有）/ onlyInExpected（账单有但未记录）/ amountMismatch（金额不一致）/ matched。\n" +
        "匹配规则：同日期同商户（日期容差 ±2 天）。\n" +
        "适用场景：用户说「帮我对账」「银行流水和我的账本对不上」「这月账单核对一下」。",
      parameters: {
        type: "object",
        properties: {
          expectedItems: {
            type: "array",
            description: "用户提供的账单（期望交易列表）。",
            items: {
              type: "object",
              properties: {
                date: { type: "string", description: "ISO 8601 日期。" },
                amount: { type: "number", description: "金额（正数）。" },
                type: {
                  type: "string",
                  enum: ["income", "expense"],
                  description: "类型：income 收入 / expense 支出。",
                },
                merchant: { type: "string", description: "商户（可选）。" },
                description: { type: "string", description: "描述（可选）。" },
              },
              required: ["date", "amount", "type"],
              additionalProperties: false,
            },
          },
        },
        required: ["expectedItems"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "finance.categorize",
      description:
        "自动分类一笔交易（基于描述关键词规则）。\n" +
        "支持分类：餐饮 / 交通 / 购物 / 娱乐 / 医疗 / 教育 / 居住 / 工资 / 其他。\n" +
        "适用场景：用户问「这笔麦当劳算什么类」「星巴克算餐饮吗」「工资算哪类」。",
      parameters: {
        type: "object",
        properties: {
          description: {
            type: "string",
            description: "交易描述。如 \"美团外卖\" / \"星巴克国贸店\" / \"7月工资\"。",
          },
          amount: {
            type: "number",
            description:
              "金额（可选）。工资类需要金额校验（>1000 才会归为工资，避免小额误判）。",
          },
        },
        required: ["description"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "finance.export_report",
      description:
        "导出财务报告（月度 / 年度 / 自定义范围），落盘返回 fileUrl。\n" +
        "支持格式：markdown / csv / json。\n" +
        "报告含：总览 / 按类别汇总 / Top 3 类别 / 预算执行 / 异常交易 / 明细（最新 50 条）。\n" +
        "适用场景：用户说「导出月度报告」「生成2025年7月财务报表」「我要一份 CSV 账单」。",
      parameters: {
        type: "object",
        properties: {
          from: {
            type: "string",
            description: "起始时间 ISO 8601（含）。如 \"2025-07-01T00:00:00+08:00\"。",
          },
          to: {
            type: "string",
            description: "结束时间 ISO 8601（含）。如 \"2025-07-31T23:59:59+08:00\"。",
          },
          format: {
            type: "string",
            enum: ["markdown", "csv", "json"],
            description: "导出格式：markdown / csv / json。默认 markdown。",
          },
        },
        required: ["from", "to"],
        additionalProperties: false,
      },
    },
  },
];
