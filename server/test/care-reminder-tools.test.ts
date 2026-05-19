import { describe, it } from "node:test";
import assert from "node:assert";
import { AgentMemorySyncService } from "../src/services/agent-memory-sync-service.js";
import { ScheduleTaskService } from "../src/services/schedule-task-service.js";
import { ToolRegistry } from "../src/tools/tool-registry.js";
import { registerCareReminderTools } from "../src/tools/care-reminder-tools.js";

describe("Care Reminder Tools", () => {
  it("应该能设置生日并自动创建提醒任务", async () => {
    const toolRegistry = new ToolRegistry();
    const memoryService = new AgentMemorySyncService();
    const scheduleService = new ScheduleTaskService();
    
    await memoryService.load();
    await scheduleService.load();
    
    registerCareReminderTools(toolRegistry, {
      agentMemorySyncService: memoryService,
      scheduleTaskService: scheduleService,
    });

    const context = { sessionId: "test-user-001" };
    
    const result = await toolRegistry.execute("care.set_important_date", {
      name: "妈妈",
      date: "1970-05-20",
      type: "birthday",
      relationship: "母亲",
    }, context);

    assert.strictEqual(result.ok, true);
    if (result.ok) {
      const data = result.result as any;
      assert.strictEqual(data.importantDate.name, "妈妈");
      assert.strictEqual(data.importantDate.date, "05-20");
      assert.strictEqual(data.importantDate.year, 1970);
      assert.ok(data.reminderTask);
      assert.ok(data.message.includes("已记录"));
      assert.ok(data.message.includes("生日"));
    }
  });

  it("应该能设置纪念日", async () => {
    const toolRegistry = new ToolRegistry();
    const memoryService = new AgentMemorySyncService();
    const scheduleService = new ScheduleTaskService();
    
    await memoryService.load();
    await scheduleService.load();
    
    registerCareReminderTools(toolRegistry, {
      agentMemorySyncService: memoryService,
      scheduleTaskService: scheduleService,
    });

    const context = { sessionId: "test-user-002" };
    
    const result = await toolRegistry.execute("care.set_important_date", {
      name: "结婚纪念日",
      date: "06-15",
      type: "anniversary",
      relationship: "配偶",
    }, context);

    assert.strictEqual(result.ok, true);
    if (result.ok) {
      const data = result.result as any;
      assert.strictEqual(data.importantDate.type, "anniversary");
      assert.ok(data.message.includes("纪念日"));
    }
  });

  it("应该能获取所有重要日期", async () => {
    const toolRegistry = new ToolRegistry();
    const memoryService = new AgentMemorySyncService();
    const scheduleService = new ScheduleTaskService();
    
    await memoryService.load();
    await scheduleService.load();
    
    registerCareReminderTools(toolRegistry, {
      agentMemorySyncService: memoryService,
      scheduleTaskService: scheduleService,
    });

    // 使用唯一的 sessionId 避免与其他测试冲突
    const context = { sessionId: "test-user-get-dates-" + Date.now() };
    
    await toolRegistry.execute("care.set_important_date", {
      name: "爸爸",
      date: "1968-08-15",
      type: "birthday",
    }, context);
    
    await toolRegistry.execute("care.set_important_date", {
      name: "好朋友生日",
      date: "12-25",
      type: "birthday",
    }, context);

    const result = await toolRegistry.execute("care.get_important_dates", {}, context);
    
    assert.strictEqual(result.ok, true);
    if (result.ok) {
      const data = result.result as any;
      assert.strictEqual(data.count, 2, `应该有2个日期，但实际有${data.count}个`);
      assert.strictEqual(data.importantDates.length, 2);
      assert.strictEqual(data.importantDates[0].date, "08-15");
      assert.strictEqual(data.importantDates[1].date, "12-25");
    }
  });

  it("应该拒绝无效的日期格式", async () => {
    const toolRegistry = new ToolRegistry();
    const memoryService = new AgentMemorySyncService();
    const scheduleService = new ScheduleTaskService();
    
    await memoryService.load();
    await scheduleService.load();
    
    registerCareReminderTools(toolRegistry, {
      agentMemorySyncService: memoryService,
      scheduleTaskService: scheduleService,
    });

    const context = { sessionId: "test-user-004" };
    
    const result = await toolRegistry.execute("care.set_important_date", {
      name: "测试",
      date: "invalid-date",
      type: "birthday",
    }, context);

    // ToolRegistry.execute 总是返回 { ok: true, result: {...} }
    // 实际的错误在 result.result 中
    assert.strictEqual(result.ok, true, "ToolRegistry 应该成功执行");
    const actualResult = result.result as any;
    assert.strictEqual(actualResult.ok, false, "无效日期应该在工具结果中返回 ok: false");
    assert.ok(actualResult.error.includes("日期格式无效"), "错误消息应包含'日期格式无效'");
  });

  it("创建的提醒任务应该在日程服务中", async () => {
    const toolRegistry = new ToolRegistry();
    const memoryService = new AgentMemorySyncService();
    const scheduleService = new ScheduleTaskService();
    
    await memoryService.load();
    await scheduleService.load();
    
    registerCareReminderTools(toolRegistry, {
      agentMemorySyncService: memoryService,
      scheduleTaskService: scheduleService,
    });

    const context = { sessionId: "test-user-005" };
    
    await toolRegistry.execute("care.set_important_date", {
      name: "测试生日",
      date: "03-15",
      type: "birthday",
    }, context);

    const tasks = scheduleService.listTasksBySession(context.sessionId);
    assert.ok(tasks.length > 0);
    
    const task = tasks[0];
    assert.ok(task.title.includes("测试生日"));
    assert.strictEqual(task.kind, "reminder");
    assert.ok(task.reminderMessage?.includes("生日"));
  });
});
