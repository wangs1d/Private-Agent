/**
 * health.* 工具意图元数据 —— 用于 tool-search BM25 排序调权。
 *
 * 与 `intent-metadata.ts` 中 `DEFAULT_TOOL_INTENT_RULES` 同结构；
 * 通过 {@link registerCapabilityModuleIntentRules} 在启动时合并到全局规则表。
 */
import type { ToolIntentRule } from "../../tool-search/intent-metadata.js";

export const HEALTH_FITNESS_INTENT_RULES: ToolIntentRule[] = [
  {
    prefix: "health.",
    metadata: {
      aliases: [
        // 通用
        "health", "fitness", "wellness", "metric", "biometric", "vital",
        "goal", "target", "track", "log", "record",
        // 中文通用
        "健康", "运动数据", "身体数据", "生理指标", "目标", "记录", "打卡",
        // 体重 / 体脂
        "weight", "body weight", "bmi", "body fat",
        "体重", "称重", "体脂", "BMI",
        // 心率 / 血压
        "heart rate", "pulse", "hr", "bpm", "blood pressure", "bp", "systolic", "diastolic",
        "心率", "脉搏", "血压", "收缩压", "舒张压",
        // 睡眠
        "sleep", "sleep duration", "sleep quality",
        "睡眠", "睡眠时长", "睡眠质量",
        // 步数 / 运动
        "steps", "step count", "walk", "walking", "running", "run", "exercise", "workout",
        "calories", "calorie", "energy",
        "步数", "走路", "跑步", "运动", "锻炼", "健身", "卡路里", "消耗",
        // 血糖 / 血氧 / 体温
        "blood glucose", "glucose", "blood sugar", "spo2", "oxygen", "temperature", "fever",
        "血糖", "血氧", "体温", "发烧",
        // 导入
        "apple health", "health export", "fitbit", "mi band", "garmin", "huawei health",
        "手环", "Apple Health", "运动健康",
      ],
      negativeAliases: [
        "phone call", "calendar reminder", "wallet transfer",
        "desktop screenshot", "smart home light", "image generation",
        "shopping recommendation", "weather lookup",
      ],
      examples: [
        "我今天体重65kg",
        "记录心率78",
        "昨晚睡了7.5小时",
        "今天走了12000步",
        "这周平均步数多少",
        "最近一个月体重变化趋势",
        "设置每日步数目标10000",
        "我的目标进度怎么样",
        "导入Apple Health数据",
        "log my weight 65.2kg",
        "what's my average heart rate this week",
        "set a daily step goal of 10000",
      ],
      negativeExamples: [
        "画一张猫的图片",
        "明天10点提醒我开会",
        "把客厅灯关了",
        "查一下今天北京天气",
      ],
    },
  },
];
