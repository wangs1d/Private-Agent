/**
 * finance.* 工具意图元数据 —— 用于 tool-search BM25 排序调权。
 *
 * 与 `intent-metadata.ts` 中 `DEFAULT_TOOL_INTENT_RULES` 同结构；
 * 通过 {@link setExtraIntentRules} 在启动时合并到全局规则表。
 *
 * 覆盖中英关键词：财务 / 账单 / 预算 / 对账 / 消费分析 / 月度报告 /
 *                 finance / budget / spending / reconcile / report 等。
 *
 * 与 wallet.* 区分：wallet.* 是单条即时操作（余额 / 转账 / 单笔购买），
 *                  finance.* 是完整账本 + 预算执行 + 对账 + 报告。
 */
import type { ToolIntentRule } from "../../tool-search/intent-metadata.js";

export const FINANCE_DEEP_INTENT_RULES: ToolIntentRule[] = [
  // 域级前缀规则：覆盖整个 finance.* 命名空间
  {
    prefix: "finance.",
    metadata: {
      aliases: [
        // 通用
        "finance", "financial", "fiscal", "spending", "expense", "expense tracking",
        "personal finance", "money management", "ledger", "bookkeeping",
        "财务", "账本", "记账", "账单", "流水", "对账", "盘点",
        // 消费分析
        "spending analysis", "expense analysis", "spending breakdown",
        "where did my money go", "monthly summary", "expense summary",
        "消费分析", "支出分析", "消费统计", "花了多少", "花在哪", "月度汇总",
        // 预算
        "budget", "budget tracking", "budget status", "budget limit",
        "spending limit", "over budget", "budget warning",
        "预算", "预算执行", "预算进度", "超支", "预算警告", "预算还剩",
        // 对账
        "reconcile", "reconciliation", "match transactions", "audit",
        "对账", "对账单", "核对账单", "账单核对",
        // 分类
        "categorize", "category", "classify transaction",
        "分类", "归类", "算什么类",
        // 报告
        "report", "monthly report", "yearly report", "finance report",
        "export report", "financial statement",
        "月度报告", "年度报告", "财务报告", "财务报表", "导出报告", "导出账单",
        // 导入
        "import transactions", "import csv", "import json", "batch import",
        "导入账单", "批量导入", "导入流水",
      ],
      negativeAliases: [
        // 与 wallet.* 区分：单条转账 / 余额查询走 wallet
        "wallet transfer", "wallet balance", "wallet recharge",
        "single purchase", "wallet purchase",
        "转账", "余额查询", "充值",
        // 与 budget.calculate 区分：一次性粗略估算
        "budget estimate", "粗略估算",
        // 与图像 / 健康等无关域
        "image generation", "draw picture", "health metric", "heart rate",
        "画图", "心率", "步数",
        // 与日程 / 提醒无关
        "calendar reminder", "schedule task",
      ],
      examples: [
        "导入这段支付宝账单",
        "这个月消费分析",
        "最近30天花在哪最多",
        "设餐饮预算2000每月",
        "预算还剩多少",
        "帮我跟银行流水对账",
        "麦当劳算什么类别",
        "导出7月财务报告",
        "import these transactions as csv",
        "analyze my spending this month",
        "set a monthly dining budget of 2000",
        "reconcile my bank statement",
        "export july finance report as markdown",
      ],
      negativeExamples: [
        "查一下钱包余额",
        "转账给小明100块",
        "估算下我下个月预算",
        "画一张猫的图片",
        "记录我的心率78",
        "明天10点提醒我开会",
      ],
    },
  },
];
