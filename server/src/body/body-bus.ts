// Agent Body Center — 身体内部消息总线（BodyBus）
//
// 与 brain/synapse-bus.ts 对称：身体内部 BodyModule 之间、Body→Brain 的信号通路。
// 纯内存实现，async/await，无 callback。
//
// 与 SynapseBus 的差异：
//  - SynapseBus 持有四个外部子系统（HookBus/MessageHub/AipService/WsRegistry），
//    跨进程/跨 Agent/到用户三路投递
//  - BodyBus 只关心进程内 BodyModule 之间的信号广播，不接外部通信
//  - 订阅 kind 支持通配符前缀匹配（如 "body.eye.*" 匹配 "body.eye.frame"）
//
// 信号历史窗口：最近 200 条（与 SynapseBus 的 100 条对齐，BodyModule 信号更密集）

import type { BodySignal } from "./types.js";

/**
 * 订阅者记录。
 * kind 为订阅模式（可能是精确 kind 或带 .* 后缀的通配符前缀）。
 */
interface BodySubscriber {
  kind: string;
  handler: (signal: BodySignal) => void | Promise<void>;
}

/**
 * BodyBus —— 身体内部消息总线。
 *
 * 设计原则（与 SynapseBus 一致）：
 *  - 纯内存：所有状态在进程内，重启即丢
 *  - async/await：handler 可以是同步或异步，publish 不等待 handler 完成
 *  - 无 callback：handler 通过 subscribe 返回的取消函数注销
 *  - 失败不阻塞：单个 handler 异常不影响其他订阅者
 *
 * 通配符规则：
 *  - kind = "*"：匹配所有信号
 *  - kind 以 ".*" 结尾（如 "body.eye.*"）：匹配所有以 "body.eye." 开头的信号
 *  - 其他：精确匹配
 */
export class BodyBus {
  // 信号历史窗口（环形缓冲，最近 maxRecent 条）
  private recentSignals: BodySignal[] = [];
  private readonly maxRecent = 200;

  // 订阅者列表（按注册顺序）
  private subscribers: BodySubscriber[] = [];

  private started = false;

  // ─── 生命周期 ────────────────────────────────────────────────

  async start(): Promise<void> {
    if (this.started) {
      console.log("[BodyBus] 已启动，跳过重复 start");
      return;
    }
    console.log("[BodyBus] 正在启动...");
    this.started = true;
    console.log("[BodyBus] 启动完成");
  }

  async stop(): Promise<void> {
    if (!this.started) {
      console.log("[BodyBus] 未启动，跳过 stop");
      return;
    }
    console.log("[BodyBus] 正在停止...");
    this.started = false;
    console.log("[BodyBus] 已停止");
  }

  // ─── 核心：发布/订阅 ─────────────────────────────────────────

  /**
   * 发布一个身体信号到总线。
   *
   * 同步遍历所有匹配的订阅者并调用 handler。handler 可以是 async 函数，
   * 但 publish 本身不等待 handler 完成（fire-and-forget），避免发布方被阻塞。
   * 单个 handler 异常被捕获并记日志，不影响其他订阅者。
   *
   * 信号同时被追加到历史窗口，供 getRecentSignals 查询。
   */
  publish(signal: BodySignal): void {
    this.pushRecent(signal);

    for (const sub of this.subscribers) {
      if (!this.matches(sub.kind, signal.kind)) {
        continue;
      }
      try {
        // 不 await：fire-and-forget，避免发布方阻塞
        void sub.handler(signal);
      } catch (err) {
        console.log(
          `[BodyBus] publish: 订阅者 handler 异常 kind=${sub.kind} signal=${signal.kind} err=${err}`,
        );
      }
    }
  }

  /**
   * 订阅指定 kind 的身体信号。
   *
   * @param kind 订阅模式：
   *             - "*" 匹配所有信号
   *             - "xxx.*" 匹配所有以 "xxx." 开头的信号
   *             - 其他字符串精确匹配
   * @param handler 信号处理器（同步或异步均可）
   * @returns 取消订阅函数；调用后移除该订阅者
   */
  subscribe(
    kind: string,
    handler: (signal: BodySignal) => void | Promise<void>,
  ): () => void {
    const sub: BodySubscriber = { kind, handler };
    this.subscribers.push(sub);
    return () => {
      const idx = this.subscribers.indexOf(sub);
      if (idx >= 0) {
        this.subscribers.splice(idx, 1);
      }
    };
  }

  // ─── 查询 ────────────────────────────────────────────────────

  /** 返回最近的 N 条身体信号（默认 20，最新在后） */
  getRecentSignals(limit = 20): BodySignal[] {
    return this.recentSignals.slice(-limit);
  }

  /** 返回当前订阅者总数 */
  getSubscriberCount(): number {
    return this.subscribers.length;
  }

  // ─── 桥接到 SynapseBus ─────────────────────────────────────

  /**
   * 桥接到 SynapseBus：订阅 BodyBus 的 body.* 主题（通配符），
   * 把每个 BodySignal 转发到 SynapseBus.fire(signal.kind, signal.payload, ...)。
   *
   * 让 brain 侧的皮层（通过 SynapseBus.subscribe）能收到身体侧的信号。
   * 返回取消订阅函数（调用后移除桥接订阅）。
   *
   * 设计原则：
   *  - 单向桥接：BodyBus → SynapseBus（身体侧信号上达大脑）
   *  - fire-and-forget：synapseBus.fire 异常被捕获记日志，不影响 BodyBus 其他订阅者
   *  - source="body"：让 SynapseBus 订阅者能识别信号来源
   */
  bridgeToSynapse(synapseBus: {
    fire(
      type: string,
      data: Record<string, unknown>,
      opts?: { actorId?: string; source?: string },
    ): unknown;
    subscribe?(
      type: string,
      handler: (msg: unknown) => void | Promise<void>,
    ): () => void;
  }): () => void {
    // 订阅所有 body.* 信号（BodyBus.matches 支持 "body.*" 通配符前缀匹配）
    const unsub = this.subscribe("body.*", (signal) => {
      try {
        synapseBus.fire(signal.kind, signal.payload, {
          actorId: signal.actorId,
          source: "body",
        });
      } catch (err) {
        console.log(
          `[BodyBus] bridgeToSynapse 转发异常 kind=${signal.kind} err=${err}`,
        );
      }
    });
    console.log("[BodyBus] 已桥接到 SynapseBus（body.* → synapse.fire）");
    return unsub;
  }

  // ─── 内部工具 ────────────────────────────────────────────────

  /**
   * 判断订阅 kind 是否匹配信号 kind。
   *
   *  - "*" 匹配所有
   *  - "prefix.*" 匹配所有以 "prefix." 开头的信号（含 "prefix.xxx"、"prefix.xxx.yyy"）
   *  - 其他：精确匹配
   */
  private matches(subscribeKind: string, signalKind: string): boolean {
    if (subscribeKind === "*") {
      return true;
    }
    if (subscribeKind.endsWith(".*")) {
      const prefix = subscribeKind.slice(0, -1); // 去掉末尾 "*"，保留 "prefix."
      return signalKind.startsWith(prefix);
    }
    return subscribeKind === signalKind;
  }

  /** 追加信号到历史窗口（超过 maxRecent 时批量裁剪，避免每次 shift 的 O(n)） */
  private pushRecent(signal: BodySignal): void {
    this.recentSignals.push(signal);
    if (this.recentSignals.length > this.maxRecent) {
      this.recentSignals.splice(0, this.recentSignals.length - this.maxRecent);
    }
  }
}
