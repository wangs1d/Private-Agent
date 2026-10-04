import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";

/**
 * 客户端 messageId（clientMessageId）↔ 线程消息的绑定与落盘字段。
 *
 * 为什么单独一个模块：这份绑定要同时被「线程 store」（按 id 定位消息做删除/编辑）和
 * 「持久化层」（把 id 随线程一起落盘）使用。若由 store 导出给持久化层，就形成
 * store ↔ persist 的循环依赖；把共享状态放在这里，两边都单向依赖本模块。
 *
 * 背景（2026-10-04 修复）：反向索引原本只是进程内 `WeakMap`，进程重启或从磁盘
 * 恢复线程后旧消息再也定位不到 →「删除这一轮 / 编辑重发」返回 message_not_found，
 * 用户侧表现是「点了删除，但服务端上下文里那一轮还在」。现在把 id 随消息落盘，
 * 恢复线程时回灌（{@link absorbPersistedClientIds}），跨重启也能命中。
 */

/**
 * 落盘用的 clientMessageId 字段名（线程内部元数据）。
 *
 * 该字段**绝不能进 LLM 上下文**：它只是本地定位用，既是协议噪音，又会因 in-context
 * 出现而被模型当成格式模仿。两道保险：恢复线程时就地剥掉；发往 LLM 的视图
 * （`buildTimestampFreeLlmView`）再兜底剥一次。
 */
export const PERSISTED_CLIENT_ID_FIELD = "__clientMessageId";

/**
 * 客户端生成的 messageId → 所属 thread 消息对象的反向索引。
 * 用 WeakMap 而非 Map：消息从 thread 中移除（删除/trim/重建）后随 GC 自动释放，不会泄漏。
 */
const userMessageClientIdMap = new WeakMap<ChatCompletionMessageParam, string>();

/** 读取一条消息上挂的落盘 clientMessageId（无则 undefined）。 */
export function readPersistedClientIdField(
  msg: ChatCompletionMessageParam,
): string | undefined {
  const raw = (msg as unknown as Record<string, unknown>)[PERSISTED_CLIENT_ID_FIELD];
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed ? trimmed : undefined;
}

/** 给消息对象打上 clientMessageId 标记（按对象身份索引）。 */
export function tagUserMessageClientId(
  msg: ChatCompletionMessageParam,
  clientMessageId: string | undefined,
): void {
  if (clientMessageId) userMessageClientIdMap.set(msg, clientMessageId);
}

/**
 * 读取消息的 clientMessageId：先查进程内反向索引，未命中再读落盘字段。
 * 后者是「恢复线程途中被克隆」时的兜底——spread 克隆会带上字段，但不带 WeakMap 索引，
 * 这样「落盘 → 恢复 → 按 id 定位」这条链不会断。
 */
export function readUserMessageClientId(
  msg: ChatCompletionMessageParam,
): string | undefined {
  return userMessageClientIdMap.get(msg) ?? readPersistedClientIdField(msg);
}

/** 把已建立的绑定透传给克隆对象（视图/落盘克隆时用）。 */
export function copyUserMessageClientId(
  from: ChatCompletionMessageParam,
  to: ChatCompletionMessageParam,
): void {
  const id = readUserMessageClientId(from);
  if (id) userMessageClientIdMap.set(to, id);
}

/**
 * 落盘前把 clientMessageId 写进 user 消息对象——**克隆**一份，绝不改线程里正在用的
 * 对象（线程对象同时是 LLM 上下文的源头，就地加字段会把它带进请求体）。
 * 供持久化层在 scheduleSave 的快照上调用。
 */
export function attachPersistedClientIds(
  msgs: ChatCompletionMessageParam[],
): ChatCompletionMessageParam[] {
  return msgs.map((msg) => {
    if (!msg || msg.role !== "user") return msg;
    const id = readUserMessageClientId(msg);
    if (!id) return msg;
    return { ...msg, [PERSISTED_CLIENT_ID_FIELD]: id } as ChatCompletionMessageParam;
  });
}

/**
 * 从磁盘恢复线程后「吸收」落盘字段：重新灌进反向索引，再就地删掉字段。
 *
 * 必须在**最终**线程对象上调用（含恢复途中的各处克隆）：反向索引按对象身份索引，
 * 灌到中间产物上等于没灌。删字段是为了让内存里的线程对象保持干净——发往 LLM 的视图
 * 只做兜底剥离，不该是唯一防线。
 */
export function absorbPersistedClientIds(
  msgs: ChatCompletionMessageParam[],
): void {
  for (const msg of msgs) {
    if (!msg || msg.role !== "user") continue;
    const id = readPersistedClientIdField(msg);
    if (!id) continue;
    tagUserMessageClientId(msg, id);
    delete (msg as unknown as Record<string, unknown>)[PERSISTED_CLIENT_ID_FIELD];
  }
}
