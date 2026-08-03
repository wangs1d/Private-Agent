/**
 * AgentTaskSafety 合并验证：原 RuntimeKernel.checkToolAction 的工具名规则已迁入
 */
import { AgentTaskSafety } from "../src/services/agent-task-safety.js";

async function main(): Promise<void> {
  const safety = new AgentTaskSafety({ log: () => {} } as never);

  const cases: Array<{ tool: string; args: Record<string, unknown>; expect: "allow" | "deny" | "require_approval"; label: string }> = [
    // 迁移自 RuntimeKernel.checkToolAction 的工具名规则
    { tool: "shopping.order.place", args: { item: "book" }, expect: "require_approval", label: "shopping.order.place 工具名命中" },
    { tool: "alipay.payment.send", args: { amount: 100 }, expect: "require_approval", label: "payment 子串命中" },
    { tool: "bank.transfer.execute", args: { to: "alice" }, expect: "require_approval", label: "transfer 子串命中" },
    { tool: "wallet.withdraw", args: { amount: 1000 }, expect: "require_approval", label: "wallet 子串命中" },
    // 原有规则不破坏
    { tool: "desktop.run_shell", args: { command: "rm -rf /", allowDestructive: true }, expect: "deny", label: "shell 黑名单" },
    { tool: "desktop.run_input", args: { action: "type", text: "转账 100 元" }, expect: "deny", label: "输入含转账" },
    { tool: "desktop.run_input", args: { action: "type", text: "身份证 110xxx" }, expect: "require_approval", label: "输入含身份证" },
    { tool: "desktop.open", args: { path: "C:\\支付宝.exe" }, expect: "require_approval", label: "打开支付宝" },
    { tool: "desktop.visual.run_task", args: {}, expect: "require_approval", label: "VLM 任务" },
    // 普通工具调用仍放行
    { tool: "search_web", args: { query: "天气" }, expect: "allow", label: "搜索放行" },
    { tool: "clock.now", args: {}, expect: "allow", label: "时钟放行" },
    { tool: "calendar.list_tasks", args: {}, expect: "allow", label: "日程放行" },
  ];

  let pass = 0;
  for (const c of cases) {
    const r = safety.checkToolCall(c.tool, c.args);
    const ok = r.action === c.expect;
    console.log(`  ${ok ? "✅" : "❌"} ${c.label.padEnd(30)} → action=${r.action}, rule=${r.matchedRule}`);
    if (ok) pass++;
  }
  console.log(`\n通过：${pass}/${cases.length}`);
  process.exit(pass === cases.length ? 0 : 1);
}

void main();
