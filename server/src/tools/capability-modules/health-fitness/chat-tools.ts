import type { ChatCompletionTool } from "openai/resources/chat/completions";

/**
 * 健康 / 运动数据能力域 —— ChatCompletionTool schema。
 *
 * 共 7 个工具：
 *   - health.log_metric    记录单条指标
 *   - health.get_metrics   查询历史记录
 *   - health.get_summary   周期汇总（周 / 月 / 年）
 *   - health.query         确定性统计问答（「这周跑了几次步」类，Task 19）
 *   - health.set_goal      设置健康目标
 *   - health.get_goals     查询目标 + 完成进度
 *   - health.import_data   批量导入（Apple Health / 手环导出 JSON / CSV）
 *
 * 走 deferred（BM25 索引），不进 CORE_TOOL_LIBRARY：
 *   1. 用户不是每轮都会查健康数据
 *   2. 关键词触发（"体重" / "心率" / "睡眠" / "步数"）时由 tool_discover 拉出
 */
export const HEALTH_FITNESS_CHAT_TOOLS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "health.log_metric",
      description:
        "记录一条健康 / 运动指标。支持类型：weight（体重）/ heart_rate（心率）/ blood_pressure（血压，value 填收缩压，舒张压写 note 如 \"80\") / sleep_duration（睡眠时长，小时）/ steps（步数）/ exercise_duration（运动时长，分钟）/ blood_glucose（血糖）/ spo2（血氧）/ temperature（体温）等。\n" +
        "适用场景：用户说「我体重65kg」「今天走了12000步」「昨晚睡了7.5小时」「心率80」等。\n" +
        "返回记录 id 与时间戳。",
      parameters: {
        type: "object",
        properties: {
          type: {
            type: "string",
            description:
              "指标类型。常用：weight / heart_rate / blood_pressure / sleep_duration / steps / exercise_duration / blood_glucose / spo2 / temperature。也支持自定义（如 situps / pushups）。",
          },
          value: {
            type: "number",
            description:
              "指标数值。如 weight=65.2、heart_rate=78、blood_pressure=120（收缩压）、sleep_duration=7.5、steps=12000。",
          },
          unit: {
            type: "string",
            description:
              "单位。常用：kg / bpm / mmHg / h / steps / min / mmol/L / % / °C。也接受自定义。",
          },
          note: {
            type: "string",
            description:
              "备注（可选）。如血压舒张压 \"80\"、运动类型 \"跑步\"、测量场景 \"饭后\"。",
          },
          timestamp: {
            type: "string",
            description:
              "ISO 8601 时间戳（可选）。未传则用当前时间。补录历史数据时填写，如 \"2025-06-30T08:00:00+08:00\"。",
          },
        },
        required: ["type", "value", "unit"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "health.get_metrics",
      description:
        "查询历史健康指标。按类型 + 时间范围筛选，最新在前。\n" +
        "适用场景：用户问「我最近体重记录」「过去一周心率多少」「最近一个月睡眠时长」。",
      parameters: {
        type: "object",
        properties: {
          type: {
            type: "string",
            description: "指标类型（可选）。不传则返回所有类型。",
          },
          from: {
            type: "string",
            description: "起始时间 ISO 8601（含）。如 \"2025-06-01T00:00:00+08:00\"。",
          },
          to: {
            type: "string",
            description: "结束时间 ISO 8601（含）。未传则到当前时间。",
          },
          limit: {
            type: "integer",
            description: "返回条数上限，1-1000，默认 100。",
          },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "health.get_summary",
      description:
        "周期汇总。返回指定周期内某类型指标的均值 / 最大 / 最小 / 按天分组 / 趋势（rising / falling / stable）。\n" +
        "适用场景：用户问「这周平均步数」「最近一个月体重变化趋势」「今年心率统计」。",
      parameters: {
        type: "object",
        properties: {
          type: {
            type: "string",
            description: "指标类型，如 steps / weight / heart_rate / sleep_duration。",
          },
          period: {
            type: "string",
            enum: ["week", "month", "year"],
            description:
              "统计周期：week（最近7天）/ month（最近30天）/ year（最近365天）。",
          },
        },
        required: ["type", "period"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "health.query",
      description:
        "健康数据确定性统计问答（服务端聚合，返回数字，你只负责口语化转述）。\n" +
        "适用场景：「这周跑了几次步」（type=exercise_duration, note_keyword=跑步, aggregate=count）、\n" +
        "「这周总共运动了多少分钟」（aggregate=sum）、「有几天在锻炼」（aggregate=days）、\n" +
        "「日均步数」（type=steps, aggregate=mean_daily）。\n" +
        "与 health.get_summary 的区别：get_summary 返回全量统计对象（均值/极值/趋势/按天），\n" +
        "本工具直接回答「一个数字」的问题，且支持按备注关键词（如运动类型「跑步」）过滤。",
      parameters: {
        type: "object",
        properties: {
          type: {
            type: "string",
            description:
              "指标类型，与 log_metric 一致。如 exercise_duration（运动时长）/ steps（步数）/ sleep_duration（睡眠）。",
          },
          aggregate: {
            type: "string",
            enum: ["count", "days", "sum", "mean", "mean_daily"],
            description:
              "聚合口径：count 记录条数（跑了几次，默认）/ days 有记录天数（有几天在锻炼）/ sum 总和 / mean 单次均值 / mean_daily 日均值。",
          },
          period: {
            type: "string",
            enum: ["week", "month", "year", "custom"],
            description:
              "统计周期：week 最近7天（默认）/ month 最近30天 / year 最近365天 / custom 自定义（需传 from/to）。",
          },
          from: {
            type: "string",
            description: "起始时间 ISO 8601（仅 period=custom 时必填）。",
          },
          to: {
            type: "string",
            description: "结束时间 ISO 8601（仅 period=custom 时必填）。",
          },
          note_keyword: {
            type: "string",
            description:
              "备注关键词过滤（可选）。如只统计 note 含「跑步」的运动记录（区分跑步/游泳/撸铁等运动类型）。",
          },
        },
        required: ["type"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "health.set_goal",
      description:
        "设置健康目标。如每日步数10000、体重65kg、每周运动时长150分钟。\n" +
        "适用场景：用户说「我想每天走1万步」「目标体重65kg」「每周运动3小时」。",
      parameters: {
        type: "object",
        properties: {
          type: {
            type: "string",
            description: "指标类型，与 log_metric 一致。如 steps / weight / sleep_duration。",
          },
          target: {
            type: "number",
            description: "目标值。如 10000 步、65 kg、7.5 小时睡眠。",
          },
          period: {
            type: "string",
            enum: ["daily", "weekly", "monthly", "yearly", "total"],
            description:
              "周期。daily=每日目标（如步数）/ weekly=每周/ monthly=每月/ yearly=每年/ total=长期目标（如减重到65kg）。",
          },
          deadline: {
            type: "string",
            description: "截止时间 ISO 8601（可选）。如 \"2025-12-31T23:59:59+08:00\"。",
          },
        },
        required: ["type", "target", "period"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "health.get_goals",
      description:
        "查询当前所有健康目标 + 完成进度。\n" +
        "进度语义：累计型（steps/sleep/exercise等）按当前周期累计 / target；最新型（weight/blood_pressure/blood_glucose）按最新值与 target 的接近度判断。\n" +
        "适用场景：用户问「我的目标进度怎么样」「步数目标完成多少了」「体重目标还差多少」。",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "health.import_data",
      description:
        "从外部数据源批量导入健康指标（Apple Health 导出 / 小米手环 / 华为运动健康 等）。\n" +
        "支持两种格式：\n" +
        "  - json：JSON 数组字符串，每个元素 { type, value, unit, timestamp, note? }\n" +
        "  - csv：CSV 文本，首行表头 type,value,unit,timestamp,note（note 可空）\n" +
        "适用场景：用户粘贴一段导出数据，或上传文件后由前端转字符串提交。",
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
        },
        required: ["format", "data"],
        additionalProperties: false,
      },
    },
  },
];
