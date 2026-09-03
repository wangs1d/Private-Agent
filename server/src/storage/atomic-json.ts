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
import { copyFile, mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const RENAME_RETRIES = 5;
const RENAME_RETRY_DELAYS_MS = [10, 25, 50, 100, 200];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function writeJsonAtomic(filePath: string, data: unknown): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  // pid + 时间戳 + 随机数：同进程多实例并发写同一目标时也不能撞名，
  // 否则一方 rename 会"偷走"另一方刚写的 tmp，导致对方 ENOENT。
  // 极端情况下 tmp 会在 rename 前被外部（杀毒扫描/清理进程）删掉——
  // ENOENT 时整体重写一次再试。
  for (let rewrite = 0; ; rewrite++) {
    const tmp = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
    await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
    // pre-image 留档：rename 前把当前目标文件复制为 .bak。若 rename 后发现新写入
    // 内容有误（而非文件损坏），仍有一份上一版完整数据可回滚。首次写入（目标不
    // 存在）无 pre-image，跳过即可。备份失败不阻断主写入。
    try {
      await copyFile(filePath, `${filePath}.bak`);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        console.warn(`[atomic-json] pre-image backup failed for ${filePath}:`, err);
      }
    }
    // Windows 的 rename 要求目标文件当前无其他句柄（EPERM）；杀毒扫描/并发进程
    // 都可能短暂占用目标文件——用退避重试吸收这种瞬态冲突。
    try {
      await rename(tmp, filePath);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (rewrite < 1 && code === "ENOENT") continue;
      if (code !== "EPERM" || rewrite >= RENAME_RETRIES) {
        throw err;
      }
      await sleep(RENAME_RETRY_DELAYS_MS[Math.min(rewrite, RENAME_RETRY_DELAYS_MS.length - 1)]);
    }
  }
}
