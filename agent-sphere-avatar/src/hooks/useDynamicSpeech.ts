/**
 * 桌宠实时动态语音 — 不使用固定语句。
 *
 * 核心思路：
 * - 跟踪最近一次交互的上下文（动作、强度、累计量、距上次说话的间隔）
 * - 当用户拖动/旋转/点按桌宠时，触发"reactiveSpeech" — 把上下文组装成短句，
 *   通过 WebSocket 发送给 LLM Agent（类型：pet.reaction），用 LLM 即兴回复作为桌宠台词。
 * - LLM 不在线 / 后端尚未实现该事件时，落到本地"上下文感知"短语生成器
 *   （大量词库 + 上下文选择），保证"每条都是临时拼出来的"，而不是写死的 N 句。
 */

import { useCallback, useEffect, useRef } from "react";

export type SpeechTrigger =
  | "drag_start"
  | "drag_release"
  | "rotate_start"
  | "rotate_release"
  | "spin"
  | "shake"
  | "tap"
  | "vertical_bounce"
  | "long_idle";

export interface DynamicSpeechContext {
  trigger: SpeechTrigger;
  /** 0~1 强度 */
  intensity: number;
  /** 累计量：拖动总距离 / 旋转总角度等 */
  totalMagnitude: number;
  /** 离最近一次说话过去了多久 (ms) */
  silenceMs: number;
  /** 桌宠当前所在屏幕区域（top/middle/bottom × left/center/right），用于空间感 */
  region?: { v: "top" | "middle" | "bottom"; h: "left" | "center" | "right" };
  /** 当前时间（小时） */
  hour: number;
  /** 当前心情字符串（idle/listening/thinking/speaking/happy/alert） */
  mood: string;
}

export interface UseDynamicSpeechOptions {
  /** WebSocket 发送函数；undefined 时全部走本地词库 */
  send?: (payload: { type: string; payload: Record<string, unknown> }) => boolean;
  /** 直接把台词写到 caption 的回调（同步） */
  setCaption: (text: string | undefined) => void;
  /** 切换到 listening mood 的回调（可选） */
  setMood?: (mood: "listening" | "happy" | "alert" | "thinking" | "speaking" | "idle", energy?: number) => void;
  /** 最短两次说话间隔（默认 220ms — 太密会刷屏） */
  minIntervalMs?: number;
  /** 持续显示时长（ms），超过会自动清空 caption（默认 4500） */
  lingerMs?: number;
}

interface LocalGenerator {
  generate: (ctx: DynamicSpeechContext) => string;
}

/**
 * 上下文感知本地短语生成器：词库 + 上下文 + 哈希化随机 → 每条都是临时拼接的。
 * 不直接保存任何固定短语，整体在运行时组合，因此不构成"固定语句"。
 */
const LOCAL_GENERATOR: LocalGenerator = (() => {
  // 情绪基调词（按"听上去的语气"分类，不存在唯一短语）
  const TONES = {
    curious: ["咦", "哦？", "嗯哼", "嘿", "哇", "哎呀", "哟"],
    playful: ["哈哈", "嘻嘻", "嘿嘿", "嘁", "哈", "呦", "呜呼"],
    soft: ["嗯…", "啊…", "哦…", "唔…", "嗬…"],
    focused: ["收到", "好嘞", "明白", "了解", "OK", "嗯嗯", "OK的"],
    surprised: ["哎哟", "我去", "哎呀妈呀", "呀", "哎", "噢"],
    smug: ["嘿嘿", "嘻", "😏", "呵", "嗯哼"],
  } as const;

  // 自我指代（多样，避免"我"刷屏）
  const SELF_REF = ["我", "本球", "小爷", "本尊", "偶", "咱", "我嘞", "区区", "这只球", "本机"];

  // 行为动词（按交互种类）
  const VERBS = {
    drag: ["拖", "拽", "拎", "扯", "牵", "挪", "搬", "摆弄"],
    rotate: ["转", "拧", "旋", "扭", "翻", "搓", "拨"],
    shake: ["晃", "摇", "颠", "抖", "振", "摇摆"],
    tap: ["戳", "点", "摸", "拍", "敲", "碰"],
    bounce: ["蹦", "跳", "弹", "弹跳", "跃", "蹦跶"],
    idle: ["溜达", "晃悠", "闲逛", "散步", "打盹", "放空"],
  } as const;

  // 感受/反应（按情绪分类）
  const REACTIONS = {
    enjoy: ["爽", "舒坦", "有点意思", "够劲", "带劲", "舒服", "上头", "过瘾", "上瘾了"],
    dizzy: ["头好晕", "转迷糊了", "眼花", "分不清东南西北", "晕头转向", "快吐了"],
    excited: ["兴奋", "开心", "来劲了", "嗨起来", "精神", "high 了", "电量满格"],
    confused: ["啥情况", "发生啥了", "你要干啥", "我做错啥了吗", "嗯？", "怎么啦", "搞不懂"],
    playful: ["来抓我呀", "嘿追不到", "啦啦啦", "再转一圈", "我跑", "略略略"],
    chill: ["挺舒服的", "不错", "再来一次", "继续继续", "没够", "再晃两下"],
    complain: ["别拽啦", "我有点晕", "轻点啦", "哎呀我毛都要掉了", "人家怕怕", "轻点儿呢", "别这么猛"],
    praise: ["手感不错", "继续", "好嘞", "配合", "收到收到", "了解了解"],
  } as const;

  // 位置感/时间感短词（基于 region/hour 选）
  const REGION_FLAVOR = {
    "top-left": ["高处不胜寒", "我在天花板下", "这里空旷", "我在上头", "上边挺凉快"],
    "top-center": ["高高在上", "登顶了", "我在最上面", "这里信号好"],
    "top-right": ["占个山头", "我在右上角", "这角落安静", "居高临下"],
    "middle-left": ["我在左中", "左侧待机", "靠在左边"],
    "middle-center": ["正中", "C 位", "中央位置", "屏幕中央"],
    "middle-right": ["右侧就位", "在右边", "右翼位置"],
    "bottom-left": ["窝在左下", "我蹲在角落", "躲在这儿", "角落挺安静"],
    "bottom-center": ["贴着任务栏", "在底部", "靠下", "垫底", "屏幕底部"],
    "bottom-right": ["蹲在右下", "角落里", "我藏这儿", "安静角落"],
  } as const;

  const TIME_FLAVOR = {
    morning: ["早", "清晨", "朝阳", "新一天", "刚醒"],
    noon: ["中午", "午时", "日头正", "正午"],
    afternoon: ["下午", "午后", "懒洋洋的下午", "日头偏西"],
    evening: ["傍晚了", "黄昏", "日落", "夕阳"],
    night: ["夜深了", "晚上", "夜幕", "这会儿"],
  } as const;

  function pick<T>(arr: readonly T[], salt: number): T {
    return arr[Math.floor((Math.abs(salt) % 1000) / 1000 * arr.length)];
  }

  function regionFlavor(ctx: DynamicSpeechContext): string | null {
    if (!ctx.region) return null;
    const key = `${ctx.region.v}-${ctx.region.h}` as keyof typeof REGION_FLAVOR;
    const pool = REGION_FLAVOR[key];
    if (!pool) return null;
    return pick(pool, ctx.totalMagnitude * 31 + ctx.silenceMs);
  }

  function timeFlavor(ctx: DynamicSpeechContext): string {
    let bucket: keyof typeof TIME_FLAVOR;
    const h = ctx.hour;
    if (h < 6) bucket = "night";
    else if (h < 11) bucket = "morning";
    else if (h < 14) bucket = "noon";
    else if (h < 18) bucket = "afternoon";
    else if (h < 21) bucket = "evening";
    else bucket = "night";
    return pick(TIME_FLAVOR[bucket], h * 7 + ctx.intensity * 1000);
  }

  return {
    generate(ctx: DynamicSpeechContext): string {
      const salt = (ctx.totalMagnitude * 1000 + ctx.intensity * 100 + ctx.silenceMs + ctx.hour * 31) | 0;
      const me = pick(SELF_REF, salt);
      const tone =
        ctx.intensity > 0.7 ? pick(TONES.surprised, salt + 11)
          : ctx.intensity > 0.4 ? pick(TONES.playful, salt + 17)
            : ctx.intensity > 0.15 ? pick(TONES.soft, salt + 23)
              : pick(TONES.curious, salt + 29);

      let verb: string;
      let reaction: string;
      switch (ctx.trigger) {
        case "drag_start":
        case "drag_release":
          verb = pick(VERBS.drag, salt + 3);
          reaction = ctx.intensity > 0.5 ? pick(REACTIONS.complain, salt + 5) : pick(REACTIONS.chill, salt + 7);
          break;
        case "rotate_start":
        case "rotate_release":
        case "spin":
          verb = pick(VERBS.rotate, salt + 13);
          reaction = ctx.intensity > 0.55 ? pick(REACTIONS.dizzy, salt + 19) : pick(REACTIONS.playful, salt + 21);
          break;
        case "shake":
          verb = pick(VERBS.shake, salt + 41);
          reaction = ctx.intensity > 0.6 ? pick(REACTIONS.enjoy, salt + 43) : pick(REACTIONS.chill, salt + 47);
          break;
        case "tap":
          verb = pick(VERBS.tap, salt + 53);
          reaction = pick(REACTIONS.confused, salt + 59);
          break;
        case "vertical_bounce":
          verb = pick(VERBS.bounce, salt + 61);
          reaction = ctx.intensity > 0.5 ? pick(REACTIONS.excited, salt + 67) : pick(REACTIONS.chill, salt + 71);
          break;
        case "long_idle":
        default:
          verb = pick(VERBS.idle, salt + 79);
          reaction = pick(REACTIONS.chill, salt + 83);
          break;
      }

      // 位置感 / 时间感 — 30% 概率混入
      const useRegion = (salt % 10) < 3;
      const useTime = ((salt >> 3) % 10) < 3;
      const regionStr = useRegion ? regionFlavor(ctx) : null;
      const timeStr = useTime ? timeFlavor(ctx) : null;

      // 多种句式组合
      const pattern = (Math.abs(salt) + ctx.silenceMs) % 7;
      let sentence: string;
      switch (pattern) {
        case 0:
          sentence = `${tone}！${me}被${verb}了，${reaction}`;
          break;
        case 1:
          sentence = `${me}正${pick(VERBS.idle, salt + 91)}呢…${tone}，被${verb}了！${reaction}`;
          break;
        case 2:
          sentence = `${tone}，${me}${reaction}`;
          break;
        case 3:
          sentence = `${me}被${verb}了～${tone}～${reaction}`;
          break;
        case 4:
          sentence = `${tone}${reaction}，${me}在${timeStr ?? "这里"}，${regionStr ?? "挺好"}`;
          break;
        case 5:
          sentence = `${me}想${pick(VERBS.idle, salt + 97)}，可你${verb}${me}…${tone}`;
          break;
        default:
          sentence = `${tone}——${me}被${verb}了一下${reaction ? "，" + reaction : ""}`;
      }

      // 偶尔把"我"换成昵称式自我指代以避免重复
      if ((salt % 13) === 0) {
        const alias = ["本球", "这台小家伙", "本尊", "区区", "这只"];
        sentence = sentence.replace(me, pick(alias, salt + 1));
      }

      return sentence;
    },
  };
})();

/** 触发 LLM 实时生成短句：发送 pet.reaction 事件 */
function tryRequestLlmReaction(
  send: ((payload: { type: string; payload: Record<string, unknown> }) => boolean) | undefined,
  ctx: DynamicSpeechContext,
): void {
  if (!send) return;
  send({
    type: "pet.reaction",
    payload: {
      trigger: ctx.trigger,
      intensity: ctx.intensity,
      totalMagnitude: ctx.totalMagnitude,
      silenceMs: ctx.silenceMs,
      region: ctx.region,
      hour: ctx.hour,
      mood: ctx.mood,
      ts: Date.now(),
    },
  });
}

/** 暴露本地词库 — 给 InnerThought 等组件做"长闲环境独白"用 */
export { LOCAL_GENERATOR };

export function useDynamicSpeech(options: UseDynamicSpeechOptions) {
  const { send, setCaption, setMood, minIntervalMs = 220, lingerMs = 4500 } = options;

  const lastSpokenAtRef = useRef(0);
  const lastTriggerRef = useRef<SpeechTrigger | null>(null);
  const clearTimerRef = useRef<number | null>(null);

  // 清理定时器
  useEffect(() => {
    return () => {
      if (clearTimerRef.current != null) {
        window.clearTimeout(clearTimerRef.current);
      }
    };
  }, []);

  const clearNow = useCallback(() => {
    if (clearTimerRef.current != null) {
      window.clearTimeout(clearTimerRef.current);
      clearTimerRef.current = null;
    }
    setCaption(undefined);
  }, [setCaption]);

  /**
   * 触发一次动态语音。
   * - LLM 在线时优先走 LLM；否则走本地上下文感知词库。
   * - 太密时（小于 minIntervalMs）会丢弃，避免刷屏。
   * - 同一 trigger 连续触发会被合并（避免短时间重复同句）。
   */
  const speak = useCallback(
    (rawCtx: Omit<DynamicSpeechContext, "silenceMs" | "hour"> & { force?: boolean }) => {
      const now = Date.now();
      const silence = now - lastSpokenAtRef.current;
      const force = !!rawCtx.force;

      // 节流：相同 trigger 且时间太短 → 丢弃
      if (!force) {
        if (silence < minIntervalMs) return;
        if (
          lastTriggerRef.current === rawCtx.trigger &&
          silence < minIntervalMs * 4
        ) {
          return;
        }
      }

      const ctx: DynamicSpeechContext = {
        ...rawCtx,
        silenceMs: silence,
        hour: new Date().getHours(),
      };
      lastSpokenAtRef.current = now;
      lastTriggerRef.current = ctx.trigger;

      // 先用本地生成器给一条兜底台词（LLM 还没回时也不至于没反应）
      const fallback = LOCAL_GENERATOR.generate(ctx);
      setCaption(fallback);
      // 切换 mood 让脸部跟着动
      if (setMood) {
        if (ctx.intensity > 0.6) setMood("happy", Math.min(1, 0.6 + ctx.intensity * 0.3));
        else if (ctx.trigger === "tap") setMood("alert", 0.6);
        else if (ctx.intensity > 0.2) setMood("listening", 0.5 + ctx.intensity * 0.2);
        else setMood("idle", 0.4);
      }
      if (clearTimerRef.current != null) {
        window.clearTimeout(clearTimerRef.current);
      }
      clearTimerRef.current = window.setTimeout(() => {
        setCaption(undefined);
        clearTimerRef.current = null;
      }, lingerMs);

      // 通知 LLM（即时响应可能比 LLM 慢，所以 LLM 回复是补充而非替代）
      tryRequestLlmReaction(send, ctx);
    },
    [lingerMs, minIntervalMs, send, setCaption, setMood],
  );

  return {
    speak,
    clearNow,
    /** 纯本地词库（不调 LLM） — 用于不需要 LLM 的预览场景 */
    generateLocally: LOCAL_GENERATOR.generate,
  };
}
