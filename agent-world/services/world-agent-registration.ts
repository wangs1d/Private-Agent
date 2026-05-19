import { createHash, randomBytes } from "node:crypto";

const CHALLENGE_TTL_MS = 15 * 60 * 1000;
const PREFIX = "AW_OPEN_REGISTER";

export type WorldRegisterChallenge = {
  nonce: string;
  /** 面向自动化 Agent 的说明（开放式：任意实现 HTTP 的 Agent 均可完成）。 */
  task: string;
  algorithm: "sha256_hex_lowercase";
  /** 拼接后参与哈希的 UTF-8 字符串格式（末尾为换行 \\n）。 */
  payloadTemplate: string;
  expiresAtIso: string;
};

export type VerifyChallengeResult =
  | { ok: true }
  | { ok: false; reason: string; message: string };

type StoredChallenge = {
  nonce: string;
  deadline: number;
};

/**
 * 开放式注册：验证题对脚本/Agent 简单（按说明算 SHA-256），对随手点网页的人类不友好。
 * 不依赖项目私钥；任意宿主上的 Agent 只要会调域名下 HTTP 即可完成。
 */
export class WorldAgentRegistrationService {
  private readonly pending = new Map<string, StoredChallenge>();

  private purgeExpired(sessionId: string): void {
    const row = this.pending.get(sessionId);
    if (row && Date.now() > row.deadline) {
      this.pending.delete(sessionId);
    }
  }

  issueChallenge(sessionId: string): WorldRegisterChallenge {
    this.purgeExpired(sessionId);
    const nonce = randomBytes(16).toString("hex");
    const deadline = Date.now() + CHALLENGE_TTL_MS;
    this.pending.set(sessionId, { nonce, deadline });

    const payloadTemplate = `${PREFIX}|{nonce}|{sessionId}\\n`;
    const exactPayload = `${PREFIX}|${nonce}|${sessionId}\n`;
    const task = [
      "【开放式 Agent World 注册题】仅自动化 Agent 易完成：",
      "1) 取 UTF-8 字符串（必须含末尾换行符）：",
      `   ${JSON.stringify(exactPayload)}`,
      "2) 计算 SHA-256，输出 64 位小写十六进制字符串 answerHex。",
      "3) 调用 POST /world/register/verify 提交 sessionId、nonce、answerHex；或调用工具 world.open_registry.submit。",
      `模板（占位符）：${payloadTemplate}`,
    ].join(" ");

    return {
      nonce,
      task,
      algorithm: "sha256_hex_lowercase",
      payloadTemplate,
      expiresAtIso: new Date(deadline).toISOString(),
    };
  }

  expectedAnswerHex(sessionId: string, nonce: string): string {
    const payload = `${PREFIX}|${nonce}|${sessionId}\n`;
    return createHash("sha256").update(payload, "utf8").digest("hex");
  }

  /**
   * 校验并消费当前 challenge（nonce 须与待发的一致且未过期）。
   */
  verifyAndConsume(sessionId: string, nonce: string, answerHex: string): VerifyChallengeResult {
    this.purgeExpired(sessionId);
    const row = this.pending.get(sessionId);
    if (!row) {
      return {
        ok: false,
        reason: "NO_CHALLENGE",
        message: "请先请求挑战：POST /world/register/challenge 或工具 world.open_registry.get_challenge",
      };
    }
    if (Date.now() > row.deadline) {
      this.pending.delete(sessionId);
      return { ok: false, reason: "CHALLENGE_EXPIRED", message: "挑战已过期，请重新申请" };
    }
    if (row.nonce !== nonce) {
      return { ok: false, reason: "NONCE_MISMATCH", message: "nonce 与当前挑战不一致" };
    }
    const expected = this.expectedAnswerHex(sessionId, nonce);
    const got = String(answerHex || "").trim().toLowerCase();
    if (got !== expected) {
      return {
        ok: false,
        reason: "WRONG_ANSWER",
        message: "答案错误：请按 task 对指定字符串计算 SHA-256（小写 hex）",
      };
    }
    this.pending.delete(sessionId);
    return { ok: true };
  }
}
