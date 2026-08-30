/**
 * 原子 JSON 落盘工具。
 *
 * 直接 writeFile 覆盖写存在损坏窗口：进程在写入中途崩溃/断电会留下截断的
 * JSON 文件——记忆图谱（human-memory.json）、聊天线程、记忆同步这类"命根子"
 * 数据不允许这个风险。
 *
 * 方案：先写同目录临时文件（同卷保证 rename 原子性），成功后 rename 覆盖
 * 目标文件。rename 在 POSIX 语义下原子；Windows 的 fs.rename 使用
 * MOVEFILE_REPLACE_EXISTING，同样替换现有文件。崩溃最坏情况只留下一个
 * 孤儿 .tmp 文件，目标文件要么是旧完整版、要么是新完整版。
 */
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const RENAME_RETRIES = 5;
const RENAME_RETRY_DELAYS_MS = [10, 25, 50, 100, 200];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function writeJsonAtomic(filePath: string, data: unknown): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  // pid + 时间戳 + 随机数：同进程多实例并发写同一目标时也不能撞名，
  // 否则一方 rename 会"偷走"另一方刚写的 tmp，导致对方 ENOENT。
  const tmp = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  // Windows 的 rename 要求目标文件当前无其他句柄（EPERM）；杀毒扫描/并发进程
  // 都可能短暂占用目标文件——用退避重试吸收这种瞬态冲突。
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(tmp, filePath);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EPERM" || attempt >= RENAME_RETRIES) {
        throw err;
      }
      await sleep(RENAME_RETRY_DELAYS_MS[Math.min(attempt, RENAME_RETRY_DELAYS_MS.length - 1)]);
    }
  }
}
