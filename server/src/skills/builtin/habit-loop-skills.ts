import { resolveActorId } from "../../agent/actor-id.js";
import type { HabitLoopService } from "../../services/habit-loop/habit-loop-service.js";
import type { HabitAction, HabitAuthorization, HabitTrigger } from "../../services/habit-loop/habit-types.js";
import type { SkillDefinition } from "../types.js";

/**
 * 内置 Skill：习惯学习 → 自动执行闭环。
 *
 *   habit.list-rules   查看习惯规则与执行统计
 *   habit.create-rule  显式建规则（用户说「以后每天 X 就 Y」时用）
 *   habit.mine         挖掘候选习惯（可一键落库，默认每次确认）
 *   habit.update-rule  开关 / 授权升级降级 / 改名
 *   habit.delete-rule  删除
 *   habit.run-now      手动立即执行一次
 *   habit.confirm-run  确认提案执行（带 token）
 */

type Deps = {
  habitLoop: HabitLoopService;
};

function parseTrigger(input: Record<string, unknown>): { ok: true; trigger: HabitTrigger } | { ok: false; error: string } {
  const kind = typeof input.triggerKind === "string" ? input.triggerKind.trim() : "";
  const time = typeof input.time === "string" ? input.time.trim() : "";
  switch (kind) {
    case "daily":
      if (!/^\d{2}:\d{2}$/.test(time)) return { ok: false, error: "daily 触发需要 time（HH:mm，本地时区）" };
      return { ok: true, trigger: { kind: "daily", time } };
    case "weekly": {
      if (!/^\d{2}:\d{2}$/.test(time)) return { ok: false, error: "weekly 触发需要 time（HH:mm）" };
      const weekdays = Array.isArray(input.weekdays)
        ? input.weekdays.map((v) => Number(v)).filter((v) => Number.isInteger(v) && v >= 0 && v <= 6)
        : [];
      if (weekdays.length === 0) return { ok: false, error: "weekly 触发需要 weekdays（0=周日…6=周六，可多个）" };
      return { ok: true, trigger: { kind: "weekly", time, weekdays } };
    }
    case "once": {
      const atIso = typeof input.atIso === "string" ? input.atIso.trim() : "";
      if (!Number.isFinite(Date.parse(atIso))) return { ok: false, error: "once 触发需要合法 atIso（ISO 时间）" };
      return { ok: true, trigger: { kind: "once", atIso } };
    }
    case "location_enter": {
      const placeLabel = typeof input.placeLabel === "string" ? input.placeLabel.trim() : "";
      const latitude = Number(input.latitude);
      const longitude = Number(input.longitude);
      if (!placeLabel && !(Number.isFinite(latitude) && Number.isFinite(longitude))) {
        return { ok: false, error: "location_enter 需要 placeLabel 或 latitude+longitude" };
      }
      return {
        ok: true,
        trigger: {
          kind: "location_enter",
          placeLabel,
          latitude: Number.isFinite(latitude) ? latitude : undefined,
          longitude: Number.isFinite(longitude) ? longitude : undefined,
          radiusMeters: Number.isFinite(Number(input.radiusMeters)) ? Number(input.radiusMeters) : undefined,
        },
      };
    }
    case "tool_pattern": {
      const toolName = typeof input.toolName === "string" ? input.toolName.trim() : "";
      if (!toolName) return { ok: false, error: "tool_pattern 需要 toolName" };
      return {
        ok: true,
        trigger: {
          kind: "tool_pattern",
          toolName,
          hour: Number.isFinite(Number(input.hour)) ? Number(input.hour) : undefined,
          weekday: Number.isFinite(Number(input.weekday)) ? Number(input.weekday) : undefined,
          windowDays: Number.isFinite(Number(input.windowDays)) ? Number(input.windowDays) : undefined,
          minCount: Number.isFinite(Number(input.minCount)) ? Number(input.minCount) : undefined,
        },
      };
    }
    default:
      return { ok: false, error: "triggerKind 必须是 daily / weekly / once / location_enter / tool_pattern" };
  }
}

function parseAction(input: Record<string, unknown>): { ok: true; action: HabitAction } | { ok: false; error: string } {
  const kind = typeof input.actionKind === "string" ? input.actionKind.trim() : "message";
  if (kind === "tool") {
    const tool = typeof input.tool === "string" ? input.tool.trim() : "";
    if (!tool) return { ok: false, error: "tool 动作需要 tool（工具名）" };
    let parsedInput: Record<string, unknown> = {};
    if (typeof input.inputJson === "string" && input.inputJson.trim()) {
      try {
        const parsed: unknown = JSON.parse(input.inputJson);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) parsedInput = parsed as Record<string, unknown>;
        else return { ok: false, error: "inputJson 必须是 JSON 对象" };
      } catch {
        return { ok: false, error: "inputJson 不是合法 JSON" };
      }
    }
    return { ok: true, action: { kind: "tool", tool, input: parsedInput } };
  }
  if (kind === "agent_task") {
    const instruction = typeof input.instruction === "string" ? input.instruction.trim() : "";
    if (!instruction) return { ok: false, error: "agent_task 动作需要 instruction" };
    return { ok: true, action: { kind: "agent_task", instruction } };
  }
  const text = typeof input.text === "string" ? input.text.trim() : "";
  if (!text) return { ok: false, error: "message 动作需要 text" };
  return { ok: true, action: { kind: "message", text } };
}

function summarizeRule(rule: Awaited<ReturnType<HabitLoopService["getRule"]>>): Record<string, unknown> | null {
  if (!rule) return null;
  return {
    id: rule.id,
    name: rule.name,
    description: rule.description,
    source: rule.source,
    trigger: rule.trigger,
    action: rule.action,
    authorization: rule.authorization,
    confidence: Number(rule.confidence.toFixed(2)),
    enabled: rule.enabled,
    cooldownMinutes: rule.cooldownMinutes,
    stats: rule.stats,
  };
}

export function createHabitLoopBuiltinSkills(deps: Deps): SkillDefinition[] {
  const { habitLoop } = deps;

  const list_rules: SkillDefinition = {
    metadata: {
      name: "habit.list-rules",
      version: "1.0.0",
      displayName: "查看习惯规则",
      description: "列出当前用户的习惯自动化规则（触发条件/动作/授权级别/置信度/执行统计）。用户问「我有哪些自动化」时调用。",
      kind: "builtin",
      tags: ["habit", "automation", "习惯", "自动化", "规则"],
      icon: "🔁",
      parameters: [],
      outputSchema: { ok: "boolean", rules: "规则列表（含统计）" },
      permissions: ["storage:read"],
      timeoutMs: 10_000,
    },
    handler: async (_input, context) => {
      const actorId = resolveActorId(context);
      const rules = await habitLoop.listRules(actorId);
      return {
        ok: true,
        actorId,
        rules: rules.map(summarizeRule),
        summary: rules.length === 0 ? "还没有习惯规则。可以说「帮我挖掘一下我的习惯」或「以后每天 X 就 Y」来创建" : `共 ${rules.length} 条习惯规则`,
      };
    },
  };

  const create_rule: SkillDefinition = {
    metadata: {
      name: "habit.create-rule",
      version: "1.0.0",
      displayName: "创建习惯规则",
      description:
        "把「以后每天/每周 X 点就 Y」「到 xx 地点就 Y」这类重复意愿固化为自动化规则。触发：daily/weekly/once/location_enter/tool_pattern；" +
        "动作：tool（自动调工具）/ agent_task（后台任务指令）/ message（发消息提醒）。默认 confirm_each（每次先确认），" +
        "用户明确说「直接自动执行/不用问我」时才设 auto。触发时间精确到分钟，tick 每分钟命中一次。",
      kind: "builtin",
      tags: ["habit", "automation", "习惯", "创建", "自动化"],
      icon: "➕",
      parameters: [
        { name: "name", type: "string", required: true, description: "习惯名（如「早上喝水」「到公司报平安」）" },
        { name: "triggerKind", type: "string", required: true, description: "daily / weekly / once / location_enter / tool_pattern" },
        { name: "time", type: "string", required: false, description: "HH:mm（daily/weekly）" },
        { name: "weekdays", type: "array", required: false, description: "weekly 的星期（0=周日…6=周六）" },
        { name: "atIso", type: "string", required: false, description: "once 的 ISO 时间" },
        { name: "placeLabel", type: "string", required: false, description: "location_enter 的地点名（与常去地点 label 匹配）" },
        { name: "latitude", type: "number", required: false, description: "location_enter 纬度" },
        { name: "longitude", type: "number", required: false, description: "location_enter 经度" },
        { name: "radiusMeters", type: "number", required: false, description: "location_enter 半径（默认 150 米）" },
        { name: "toolName", type: "string", required: false, description: "tool_pattern 的工具名" },
        { name: "actionKind", type: "string", required: false, description: "tool / agent_task / message（默认 message）" },
        { name: "tool", type: "string", required: false, description: "tool 动作的工具名" },
        { name: "inputJson", type: "string", required: false, description: "tool 动作的入参（JSON 对象串）" },
        { name: "instruction", type: "string", required: false, description: "agent_task 动作的指令" },
        { name: "text", type: "string", required: false, description: "message 动作的消息文本" },
        { name: "authorization", type: "string", required: false, description: "confirm_each（默认）/ auto（需用户明确要求）" },
      ],
      outputSchema: { ok: "boolean", rule: "新规则", summary: "说明" },
      permissions: ["storage:write"],
      timeoutMs: 10_000,
    },
    handler: async (input, context) => {
      const actorId = resolveActorId(context);
      const name = typeof input.name === "string" ? input.name.trim() : "";
      if (!name) return { ok: false, error: "缺少 name", actorId };
      const trigger = parseTrigger(input);
      if (!trigger.ok) return { ok: false, error: trigger.error, actorId };
      const action = parseAction(input);
      if (!action.ok) return { ok: false, error: action.error, actorId };
      const authorization: HabitAuthorization = input.authorization === "auto" ? "auto" : "confirm_each";
      const rule = await habitLoop.createRule({
        actorId,
        name,
        trigger: trigger.trigger,
        action: action.action,
        authorization,
        description: typeof input.description === "string" ? input.description : undefined,
      });
      return {
        ok: true,
        actorId,
        rule: summarizeRule(rule),
        summary: `习惯「${rule.name}」已创建（${rule.authorization === "auto" ? "自动执行" : "每次先确认"}）。触发：${JSON.stringify(rule.trigger)}`,
      };
    },
  };

  const mine: SkillDefinition = {
    metadata: {
      name: "habit.mine",
      version: "1.0.0",
      displayName: "挖掘候选习惯",
      description:
        "从位置历史与工具使用记录里挖掘重复行为模式，产出候选习惯；create=true 时直接以「每次先确认」授权落库。" +
        "用户说「帮我看看我有什么习惯」「学学我的规律」时调用。",
      kind: "builtin",
      tags: ["habit", "mine", "习惯", "挖掘", "规律"],
      icon: "⛏️",
      parameters: [
        { name: "create", type: "boolean", required: false, description: "true = 把候选直接建为规则（默认只列出）" },
      ],
      outputSchema: { ok: "boolean", candidates: "候选列表", created: "新建规则" },
      permissions: ["location:read", "storage:write"],
      timeoutMs: 20_000,
    },
    handler: async (input, context) => {
      const actorId = resolveActorId(context);
      const create = input.create === true;
      const result = await habitLoop.mine(actorId, create);
      return {
        ok: true,
        actorId,
        candidates: result.candidates,
        created: result.created.map(summarizeRule),
        summary:
          result.candidates.length === 0
            ? "近三周还没有形成明显的重复模式；用得越多挖得越准"
            : `挖到 ${result.candidates.length} 个候选习惯${create ? `，已落库 ${result.created.length} 条（每次先确认，你确认几次后我会建议转自动）` : ""}`,
      };
    },
  };

  const update_rule: SkillDefinition = {
    metadata: {
      name: "habit.update-rule",
      version: "1.0.0",
      displayName: "更新习惯规则",
      description:
        "开关规则 / 调整授权（authorization=auto|confirm_each）/ 改名。授权升级建议在用户明确同意后进行；连续自动失败会自动降回 confirm_each。",
      kind: "builtin",
      tags: ["habit", "update", "习惯", "授权", "开关"],
      icon: "⚙️",
      parameters: [
        { name: "ruleId", type: "string", required: true, description: "规则 id（hl_*）" },
        { name: "enabled", type: "boolean", required: false, description: "开/关" },
        { name: "authorization", type: "string", required: false, description: "auto / confirm_each" },
        { name: "name", type: "string", required: false, description: "新名字" },
      ],
      outputSchema: { ok: "boolean", rule: "更新后的规则" },
      permissions: ["storage:write"],
      timeoutMs: 10_000,
    },
    handler: async (input, context) => {
      const actorId = resolveActorId(context);
      const ruleId = typeof input.ruleId === "string" ? input.ruleId.trim() : "";
      if (!ruleId) return { ok: false, error: "缺少 ruleId", actorId };
      const patch: { enabled?: boolean; authorization?: HabitAuthorization; name?: string } = {};
      if ("enabled" in input) patch.enabled = input.enabled === true;
      if (input.authorization === "auto" || input.authorization === "confirm_each") patch.authorization = input.authorization;
      if (typeof input.name === "string" && input.name.trim()) patch.name = input.name;
      const rule = await habitLoop.updateRule(actorId, ruleId, patch);
      if (!rule) return { ok: false, error: `规则 ${ruleId} 不存在`, actorId };
      return {
        ok: true,
        actorId,
        rule: summarizeRule(rule),
        summary: `习惯「${rule.name}」已更新（enabled=${rule.enabled}，authorization=${rule.authorization}）`,
      };
    },
  };

  const delete_rule: SkillDefinition = {
    metadata: {
      name: "habit.delete-rule",
      version: "1.0.0",
      displayName: "删除习惯规则",
      description: "删除一条习惯自动化规则（不可恢复）。",
      kind: "builtin",
      tags: ["habit", "delete", "习惯", "删除"],
      icon: "🗑️",
      parameters: [{ name: "ruleId", type: "string", required: true, description: "规则 id（hl_*）" }],
      outputSchema: { ok: "boolean", summary: "说明" },
      permissions: ["storage:write"],
      timeoutMs: 10_000,
    },
    handler: async (input, context) => {
      const actorId = resolveActorId(context);
      const ruleId = typeof input.ruleId === "string" ? input.ruleId.trim() : "";
      const deleted = ruleId ? await habitLoop.deleteRule(actorId, ruleId) : false;
      return { ok: deleted, actorId, summary: deleted ? "规则已删除" : `规则 ${ruleId} 不存在` };
    },
  };

  const run_now: SkillDefinition = {
    metadata: {
      name: "habit.run-now",
      version: "1.0.0",
      displayName: "立即执行习惯",
      description: "手动触发某条习惯规则立即执行一次（不等触发条件）。金融类工具仍受两阶段确认等安全层约束。",
      kind: "builtin",
      tags: ["habit", "run", "习惯", "执行"],
      icon: "▶️",
      parameters: [{ name: "ruleId", type: "string", required: true, description: "规则 id（hl_*）" }],
      outputSchema: { ok: "boolean", summary: "执行结果" },
      permissions: ["storage:write"],
      timeoutMs: 60_000,
    },
    handler: async (input, context) => {
      const actorId = resolveActorId(context);
      const ruleId = typeof input.ruleId === "string" ? input.ruleId.trim() : "";
      if (!ruleId) return { ok: false, error: "缺少 ruleId", actorId };
      const result = await habitLoop.runNow(actorId, ruleId);
      return { ok: result.ok, actorId, summary: result.summary };
    },
  };

  const confirm_run: SkillDefinition = {
    metadata: {
      name: "habit.confirm-run",
      version: "1.0.0",
      displayName: "确认执行习惯提案",
      description: "习惯提案（主动消息里带 habitRuleId）用户确认后调用，token 一次性。确认成功会累积置信度，连续 3 次后 agent 会建议升级自动。",
      kind: "builtin",
      tags: ["habit", "confirm", "习惯", "确认"],
      icon: "✅",
      parameters: [
        { name: "ruleId", type: "string", required: true, description: "规则 id（hl_*）" },
        { name: "token", type: "string", required: true, description: "提案里的确认 token" },
      ],
      outputSchema: { ok: "boolean", summary: "执行结果" },
      permissions: ["storage:write"],
      timeoutMs: 60_000,
    },
    handler: async (input, context) => {
      const actorId = resolveActorId(context);
      const ruleId = typeof input.ruleId === "string" ? input.ruleId.trim() : "";
      const token = typeof input.token === "string" ? input.token.trim() : "";
      if (!ruleId || !token) return { ok: false, error: "缺少 ruleId 或 token", actorId };
      const result = await habitLoop.confirmRun(actorId, ruleId, token);
      return { ok: result.ok, actorId, summary: result.summary };
    },
  };

  return [list_rules, create_rule, mine, update_rule, delete_rule, run_now, confirm_run];
}

export function registerHabitLoopBuiltinSkills(
  register: (skill: SkillDefinition) => void,
  deps: Deps,
): void {
  for (const s of createHabitLoopBuiltinSkills(deps)) {
    register(s);
  }
}
