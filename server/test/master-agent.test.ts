/**
 * 主 Agent 协调器集成测试
 * 
 * 执行方式：
 * npm run test:master-agent
 */

import { MasterAgentCoordinator } from "../src/services/master-agent-coordinator.js";
import { ToolRegistry } from "../src/tools/tool-registry.js";

// 模拟外部聊天提供商
class MockExternalProvider {
  readonly id = "mock-provider";
  readonly displayLabel = "Mock Provider";
  
  isEnabled(): boolean {
    return true;
  }
  
  async streamCompletion(
    sessionId: string,
    userTurn: any,
    onDelta: (delta: string) => void,
    tools?: any,
    streamOpts?: any,
  ): Promise<string> {
    // 模拟 LLM 响应
    const text = userTurn.text;
    
    if (text.includes("任务分解专家")) {
      // 模拟任务分解响应
      const response = JSON.stringify({
        needsDecomposition: true,
        executionStrategy: "parallel",
        subTasks: [
          {
            description: "查询明天北京天气",
            assignedAgent: "weather",
            priority: 8,
            dependencies: [],
            estimatedComplexity: "low",
          },
          {
            description: "创建下午3点会议提醒",
            assignedAgent: "calendar",
            priority: 9,
            dependencies: [],
            estimatedComplexity: "medium",
          },
        ],
      });
      
      for (let i = 0; i < response.length; i += 10) {
        const chunk = response.slice(i, i + 10);
        onDelta(chunk);
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      
      return response;
    } else if (text.includes("结果汇总专家")) {
      // 模拟结果汇总
      const response = "任务已完成：\n1. 明天北京天气晴朗，温度20-25度\n2. 已创建下午3点的会议提醒";
      
      for (let i = 0; i < response.length; i += 10) {
        const chunk = response.slice(i, i + 10);
        onDelta(chunk);
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      
      return response;
    } else {
      // 模拟子任务执行
      const response = `任务完成：${text.substring(0, 50)}...`;
      onDelta(response);
      return response;
    }
  }
  
  clearSession(sessionId: string): void {
    console.log(`[Mock] 清理会话: ${sessionId}`);
  }
}

async function testMasterAgent() {
  console.log("🧪 启动主 Agent 协调器测试...\n");
  
  // 创建工具注册表
  const toolRegistry = new ToolRegistry();
  
  // 注册测试工具
  toolRegistry.register("calendar.create_task", async () => ({ ok: true }));
  toolRegistry.register("weather.get_forecast", async () => ({ ok: true }));
  toolRegistry.register("desktop.screenshot", async () => ({ ok: true }));
  
  // 创建主 Agent 协调器
  const mockProvider = new MockExternalProvider() as any;
  const coordinator = new MasterAgentCoordinator(
    mockProvider,
    toolRegistry,
    null,
    null,
    {
      enableSubAgents: true,
      maxParallelTasks: 3,
      taskTimeoutMs: 30000,
      allowFallback: true,
    },
  );
  
  console.log("✅ 主 Agent 协调器初始化完成\n");
  
  // 测试用例 1: 简单任务
  console.log("📝 测试场景 1: 简单交互");
  console.log("用户输入: 你好");
  
  const progress1: string[] = [];
  const result1 = await coordinator.orchestrateTask(
    "user-session-1",
    "你好",
    (msg) => {
      progress1.push(msg);
      console.log(`  进度: ${msg}`);
    },
  );
  
  console.log(`响应: ${result1.substring(0, 100)}...\n`);
  
  // 测试用例 2: 复杂任务（需要分解）
  console.log("📝 测试场景 2: 复合任务");
  console.log("用户输入: 帮我查一下明天北京的天气，然后设置一个下午3点的会议提醒");
  
  const progress2: string[] = [];
  const result2 = await coordinator.orchestrateTask(
    "user-session-2",
    "帮我查一下明天北京的天气，然后设置一个下午3点的会议提醒",
    (msg) => {
      progress2.push(msg);
      console.log(`  进度: ${msg}`);
    },
  );
  
  console.log(`\n最终结果:\n${result2}\n`);
  
  // 测试用例 3: 多领域任务
  console.log("📝 测试场景 3: 跨领域任务");
  console.log("用户输入: 先截图保存当前桌面，然后查天气，最后给朋友发消息");
  
  const progress3: string[] = [];
  const result3 = await coordinator.orchestrateTask(
    "user-session-3",
    "先截图保存当前桌面，然后查天气，最后给朋友发消息",
    (msg) => {
      progress3.push(msg);
      console.log(`  进度: ${msg}`);
    },
  );
  
  console.log(`\n最终结果:\n${result3}\n`);
  
  console.log("✅ 全部测试执行完毕！");
  console.log("\n📊 测试统计:");
  console.log(`  - 测试场景数: 3`);
  console.log(`  - 总进度消息数: ${progress1.length + progress2.length + progress3.length}`);
  console.log(`  - 平均响应长度: ${Math.round((result1.length + result2.length + result3.length) / 3)} 字符`);
}

// 运行测试
testMasterAgent().catch((error) => {
  console.error("❌ 测试失败:", error);
  process.exit(1);
});
