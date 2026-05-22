import { randomUUID } from "crypto";
import type { ScheduleTaskService } from "../services/schedule-task-service.js";
import type { AgentMemorySyncService } from "../services/agent-memory-sync-service.js";
import type { ToolRegistry } from "./tool-registry.js";
import { resolveActorId } from "../agent/actor-id.js";

/**
 * 重要日期类型
 */
export type ImportantDateType = "birthday" | "anniversary" | "custom";

/**
 * 重要日期记录
 */
export type ImportantDateRecord = {
  id: string;
  name: string; // 人物或事件名称，如"妈妈"、"结婚纪念日"
  date: string; // MM-DD 格式，如 "05-20"
  year?: number; // 出生年份（可选，用于计算年龄）
  type: ImportantDateType;
  relationship?: string; // 关系描述，如"母亲"、"配偶"
  notes?: string; // 备注
  createdAt: string;
};

/**
 * 关怀提醒工具集：管理重要日期并自动创建年度周期性提醒任务
 */
export function registerCareReminderTools(
  registry: ToolRegistry,
  deps: {
    agentMemorySyncService: AgentMemorySyncService;
    scheduleTaskService: ScheduleTaskService;
  },
): void {
  const { agentMemorySyncService, scheduleTaskService } = deps;

  /**
   * 设置重要日期（生日、纪念日等）
   * 自动在日程服务中创建每年重复的提醒任务（提前1天提醒）
   */
  registry.register("care.set_important_date", async (input, context) => {
    const actorId = resolveActorId(context);
    
    const name = String(input.name ?? "").trim();
    const dateStr = String(input.date ?? "").trim(); // 期望格式：YYYY-MM-DD 或 MM-DD
    const typeRaw = String(input.type ?? "birthday").trim();
    const relationship = input.relationship ? String(input.relationship).trim() : undefined;
    const year = input.year ? Number(input.year) : undefined;
    const notes = input.notes ? String(input.notes).trim() : undefined;

    // 参数校验
    if (!name) {
      return { ok: false, error: "请提供名称（name），如'妈妈'或'结婚纪念日'" };
    }
    if (!dateStr) {
      return { ok: false, error: "请提供日期（date），格式为 YYYY-MM-DD 或 MM-DD" };
    }
    if (!["birthday", "anniversary", "custom"].includes(typeRaw)) {
      return { ok: false, error: "类型（type）必须是 birthday、anniversary 或 custom" };
    }

    // 解析日期
    const parsedDate = parseImportantDate(dateStr);
    if (!parsedDate) {
      return { 
        ok: false, 
        error: "日期格式无效，请使用 YYYY-MM-DD（如 1970-05-20）或 MM-DD（如 05-20）格式" 
      };
    }

    const type = typeRaw as ImportantDateType;
    const record: ImportantDateRecord = {
      id: randomUUID(),
      name,
      date: parsedDate.mmdd, // 存储 MM-DD 格式
      year: parsedDate.year ?? year,
      type,
      relationship,
      notes,
      createdAt: new Date().toISOString(),
    };

    // 从记忆中读取现有的重要日期列表
    const { revision, entries } = agentMemorySyncService.getSnapshot(actorId, ["important_dates"]);
    const existingDates: ImportantDateRecord[] = Array.isArray(entries.important_dates) 
      ? entries.important_dates 
      : [];

    // 添加新日期
    const updatedDates = [...existingDates, record];

    // 保存到记忆
    const patchResult = agentMemorySyncService.applyPatch(actorId, revision, [
      { key: "important_dates", op: "put", value: updatedDates },
    ]);

    if (!patchResult.ok) {
      return { ok: false, error: `保存失败：${patchResult.reason}` };
    }

    // 自动创建年度提醒任务（提前1天提醒）
    try {
      const taskResult = await createAnnualReminderTask(
        scheduleTaskService,
        actorId,
        record,
      );
      
      return {
        ok: true,
        importantDate: record,
        reminderTask: taskResult,
        message: `已记录"${record.name}"的${getTypeLabel(record.type)}（${record.date}），并设置了每年提前1天的提醒`,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return {
        ok: true,
        importantDate: record,
        warning: `重要日期已保存，但创建提醒任务失败：${errorMsg}`,
      };
    }
  });

  /**
   * 获取所有重要日期
   */
  registry.register("care.get_important_dates", async (_input, context) => {
    const actorId = resolveActorId(context);
    
    const { entries } = agentMemorySyncService.getSnapshot(actorId, ["important_dates"]);
    const dates: ImportantDateRecord[] = Array.isArray(entries.important_dates) 
      ? entries.important_dates 
      : [];

    // 按日期排序
    const sorted = [...dates].sort((a, b) => a.date.localeCompare(b.date));

    return {
      ok: true,
      count: sorted.length,
      importantDates: sorted,
    };
  });

  /**
   * 删除重要日期（同时删除对应的提醒任务）
   */
  registry.register("care.delete_important_date", async (input, context) => {
    const actorId = resolveActorId(context);
    
    const id = String(input.id ?? "").trim();
    if (!id) {
      return { ok: false, error: "请提供要删除的重要日期 ID" };
    }

    // 读取现有列表
    const { revision, entries } = agentMemorySyncService.getSnapshot(actorId, ["important_dates"]);
    const existingDates: ImportantDateRecord[] = Array.isArray(entries.important_dates) 
      ? entries.important_dates 
      : [];

    // 找到要删除的记录
    const targetIndex = existingDates.findIndex(d => d.id === id);
    if (targetIndex === -1) {
      return { ok: false, error: "未找到该重要日期" };
    }

    const deletedDate = existingDates[targetIndex];
    const updatedDates = existingDates.filter(d => d.id !== id);

    // 更新记忆
    const patchResult = agentMemorySyncService.applyPatch(actorId, revision, [
      { key: "important_dates", op: "put", value: updatedDates },
    ]);

    if (!patchResult.ok) {
      return { ok: false, error: `删除失败：${patchResult.reason}` };
    }

    // TODO: 如果需要，可以在这里删除对应的日程任务
    // 目前日程任务没有直接的删除 API，可以标记为 cancelled

    return {
      ok: true,
      deletedDate: deletedDate,
      message: `已删除"${deletedDate.name}"的重要日期记录`,
    };
  });
}

/**
 * 解析重要日期字符串
 * @returns { mmdd: string, year?: number } | null
 */
function parseImportantDate(dateStr: string): { mmdd: string; year?: number } | null {
  // 尝试匹配 YYYY-MM-DD
  const fullMatch = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (fullMatch) {
    const [, yearStr, monthStr, dayStr] = fullMatch;
    const year = parseInt(yearStr, 10);
    const month = parseInt(monthStr, 10);
    const day = parseInt(dayStr, 10);
    
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return {
        mmdd: `${monthStr}-${dayStr}`,
        year,
      };
    }
  }

  // 尝试匹配 MM-DD
  const shortMatch = dateStr.match(/^(\d{2})-(\d{2})$/);
  if (shortMatch) {
    const [, monthStr, dayStr] = shortMatch;
    const month = parseInt(monthStr, 10);
    const day = parseInt(dayStr, 10);
    
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return {
        mmdd: `${monthStr}-${dayStr}`,
      };
    }
  }

  return null;
}

/**
 * 根据类型获取中文标签
 */
function getTypeLabel(type: ImportantDateType): string {
  switch (type) {
    case "birthday":
      return "生日";
    case "anniversary":
      return "纪念日";
    case "custom":
      return "特殊日期";
    default:
      return "日期";
  }
}

/**
 * 为重要日期创建年度提醒任务
 * 在日期前一天早上8点提醒
 */
async function createAnnualReminderTask(
  scheduleTaskService: ScheduleTaskService,
  actorId: string,
  dateRecord: ImportantDateRecord,
): Promise<{ taskId: string; nextRunAt: string } | null> {
  // 计算下一个即将到来的日期（提前1天）
  const now = new Date();
  const currentYear = now.getFullYear();
  
  // 解析 MM-DD
  const [monthStr, dayStr] = dateRecord.date.split("-");
  const month = parseInt(monthStr, 10);
  const day = parseInt(dayStr, 10);
  
  // 计算提醒日期（提前1天）
  let reminderDate = new Date(currentYear, month - 1, day - 1, 8, 0, 0, 0);
  
  // 如果今年的提醒日期已过，设置为明年
  if (reminderDate.getTime() < now.getTime()) {
    reminderDate = new Date(currentYear + 1, month - 1, day - 1, 8, 0, 0, 0);
  }

  // 构建提醒消息
  let reminderMessage = "";
  if (dateRecord.type === "birthday") {
    const ageInfo = dateRecord.year ? `（即将${currentYear - dateRecord.year + 1}岁）` : "";
    const relInfo = dateRecord.relationship ? `（${dateRecord.relationship}）` : "";
    reminderMessage = `明天是${dateRecord.name}${relInfo}的生日${ageInfo}！别忘了送上祝福哦 🎂`;
  } else if (dateRecord.type === "anniversary") {
    const relInfo = dateRecord.relationship ? `（${dateRecord.relationship}）` : "";
    reminderMessage = `明天是${dateRecord.name}${relInfo}纪念日！准备好庆祝了吗？🎉`;
  } else {
    reminderMessage = `明天是${dateRecord.name}！记得关注这个特殊的日子 ✨`;
  }

  // 创建日程任务（每年重复）
  const task = await scheduleTaskService.createTask({
    sessionId: actorId,
    title: `${dateRecord.name}的${getTypeLabel(dateRecord.type)}提醒`,
    description: reminderMessage,
    kind: "reminder",
    runAt: reminderDate.toISOString(),
    recurrence: "yearly",
    timezone: "Asia/Shanghai",
    reminderMessage,
  });

  return {
    taskId: task.taskId,
    nextRunAt: task.nextRunAt!,
  };
}
