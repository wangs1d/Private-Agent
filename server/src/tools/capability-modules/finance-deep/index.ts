/**
 * 能力模块统一接口约定（finance-deep，与 image-gen / health-fitness 同结构）：
 *
 * 导出 3 项：
 *   - `FINANCE_DEEP_CHAT_TOOLS: ChatCompletionTool[]`   LLM 工具 schema
 *   - `registerFinanceDeepTools(registry, deps): void`   注册到 ToolRegistry
 *   - `FINANCE_DEEP_INTENT_RULES: ToolIntentRule[]`     意图元数据（接 BM25 调权）
 *
 * 由 `capability-modules/index.ts` 在 `buildCapabilityModules(deps)` 中合并；
 * 主线程统一注入 `CapabilityModuleDeps.financeDeepService`。
 *
 * ⚠️ 本模块文件不做 capability-modules/index.ts 合并、也不改 create-app-services.ts /
 *    agent-capabilities.ts；最终由主线程统一合并。
 */
import type { ToolRegistry } from "../../tool-registry.js";
import type { FinanceDeepService } from "../../../services/finance-deep-service.js";
import type { SubscriptionAuditService } from "../../../services/subscription-audit-service.js";
import type { BillManagementService } from "../../../services/bill-management-service.js";

import { FINANCE_DEEP_CHAT_TOOLS } from "./chat-tools.js";
import {
  createFinanceImportTransactionsHandler,
  createFinanceAnalyzeSpendingHandler,
  createFinanceSetBudgetHandler,
  createFinanceGetBudgetStatusHandler,
  createFinanceReconcileHandler,
  createFinanceCategorizeHandler,
  createFinanceExportReportHandler,
  createFinanceListSubscriptionsHandler,
  createFinanceConfirmSubscriptionHandler,
  createFinanceUpdateSubscriptionHandler,
  createFinanceCancelSubscriptionHandler,
  createFinanceSavingsSummaryHandler,
  createFinanceAddBillHandler,
  createFinanceListBillsHandler,
  createFinanceUpdateBillHandler,
  createFinancePayBillHandler,
} from "./handlers.js";

export { FINANCE_DEEP_CHAT_TOOLS } from "./chat-tools.js";
export { FINANCE_DEEP_INTENT_RULES } from "./intent.js";

/**
 * 注册 finance-deep 工具到 ToolRegistry。
 *
 * 调用方：`create-app-services.ts` 启动阶段（经 `registerAllCapabilityModules`）。
 */
export function registerFinanceDeepTools(
  registry: ToolRegistry,
  deps: {
    financeDeepService: FinanceDeepService;
    subscriptionAuditService?: SubscriptionAuditService;
    billManagementService?: BillManagementService;
  },
): void {
  const service = deps.financeDeepService;
  registry.register("finance.import_transactions", createFinanceImportTransactionsHandler(service));
  registry.register("finance.analyze_spending", createFinanceAnalyzeSpendingHandler(service));
  registry.register("finance.set_budget", createFinanceSetBudgetHandler(service));
  registry.register("finance.get_budget_status", createFinanceGetBudgetStatusHandler(service));
  registry.register("finance.reconcile", createFinanceReconcileHandler(service));
  registry.register("finance.categorize", createFinanceCategorizeHandler(service));
  registry.register("finance.export_report", createFinanceExportReportHandler(service));
  // 订阅盘点 + 自动取消（未装配 SubscriptionAuditService 时不注册，避免 handler 空引用）
  const audit = deps.subscriptionAuditService;
  if (audit) {
    registry.register("finance.list_subscriptions", createFinanceListSubscriptionsHandler(audit));
    registry.register("finance.confirm_subscription", createFinanceConfirmSubscriptionHandler(audit));
    registry.register("finance.update_subscription", createFinanceUpdateSubscriptionHandler(audit));
    registry.register("finance.cancel_subscription", createFinanceCancelSubscriptionHandler(audit));
    registry.register("finance.savings_summary", createFinanceSavingsSummaryHandler(audit));
  }
  // 账单管理（追踪/提醒/预算联动；未装配 BillManagementService 时不注册）
  const bills = deps.billManagementService;
  if (bills) {
    registry.register("finance.add_bill", createFinanceAddBillHandler(bills));
    registry.register("finance.list_bills", createFinanceListBillsHandler(bills));
    registry.register("finance.update_bill", createFinanceUpdateBillHandler(bills));
    registry.register("finance.pay_bill", createFinancePayBillHandler(bills));
  }
}
