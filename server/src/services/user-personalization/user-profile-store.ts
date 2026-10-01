import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const PROFILE_FILENAME = "USER_PROFILE.md";

function sanitizeActorId(actorId: string): string {
  const s = actorId.trim().slice(0, 128);
  return s.replace(/[^a-zA-Z0-9._-]/g, "_") || "default";
}

/** 默认模板自带的样板行（这些行不算「真实事实」） */
const TEMPLATE_BOILERPLATE_LINES = new Set([
  "（待了解：称呼、常用语言、所在地等）",
  "（待了解）",
  "（重要但不宜归类到以上的信息）",
  "回复偏好：精简直接，口语化，像身边熟人回话；少客服腔、少标题、少表格、少长解释",
]);

/**
 * 画像是否含有真实事实（非纯默认模板/系统样板）。
 * 判据：存在一条内容行不属于默认模板样板集——占位括号行与
 * 「语气风格：…（系统根据对话自动调整）」这类系统同步行也算样板。
 * 用于 prompt 注入闸：模板画像不注入，省 token 且不给 LLM 喂「待了解」噪声。
 */
export function hasRealProfileContent(profile: string): boolean {
  for (const raw of profile.split("\n")) {
    const line = raw.trim();
    if (!line.startsWith("- ")) continue;
    const content = line.slice(2).trim();
    if (!content) continue;
    if (TEMPLATE_BOILERPLATE_LINES.has(content)) continue;
    if (content.startsWith("（") && content.endsWith("）")) continue;
    if (/^语气风格：.*（系统根据对话自动调整）$/.test(content)) continue;
    return true;
  }
  return false;
}

export function defaultUserProfileMarkdown(actorId: string): string {
  const now = new Date().toISOString();
  return `# 用户画像

> 本文件由 Agent 在与你的对话中持续更新。最后更新：${now}
> 用户标识：\`${actorId}\`

## 基本信息

- （待了解：称呼、常用语言、所在地等）

## 兴趣与习惯

- （待了解）

## 沟通偏好

- 语气风格：自然均衡（系统根据对话自动调整）
- 回复偏好：精简直接，口语化，像身边熟人回话；少客服腔、少标题、少表格、少长解释

## 备注

- （重要但不宜归类到以上的信息）
`;
}

export class UserProfileStore {
  private readonly baseDir: string;

  constructor(baseDir?: string) {
    this.baseDir =
      baseDir?.trim() ||
      process.env.AGENT_USER_PROFILE_DIR?.trim() ||
      join(process.cwd(), "data", "user_profiles");
  }

  profilePath(actorId: string): string {
    return join(this.baseDir, sanitizeActorId(actorId), PROFILE_FILENAME);
  }

  async read(actorId: string): Promise<string> {
    const path = this.profilePath(actorId);
    try {
      const raw = await readFile(path, "utf8");
      return raw.trim() || defaultUserProfileMarkdown(actorId);
    } catch (e: unknown) {
      const code = e && typeof e === "object" && "code" in e ? String((e as NodeJS.ErrnoException).code) : "";
      if (code === "ENOENT") return defaultUserProfileMarkdown(actorId);
      throw e;
    }
  }

  async write(actorId: string, content: string): Promise<void> {
    const path = this.profilePath(actorId);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${content.trim()}\n`, "utf8");
  }

  /**
   * 级联删除该 actor 的画像文件与待消费轮次队列（隐私闭环：
   * clearAllMemoryForActor 的其余记忆库都清了，画像目录此前会残留）。
   */
  async deleteAll(actorId: string): Promise<boolean> {
    const dir = dirname(this.profilePath(actorId));
    try {
      await rm(dir, { recursive: true, force: true });
      return true;
    } catch {
      return false;
    }
  }
}
