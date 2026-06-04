import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const PROFILE_FILENAME = "USER_PROFILE.md";

function sanitizeActorId(actorId: string): string {
  const s = actorId.trim().slice(0, 128);
  return s.replace(/[^a-zA-Z0-9._-]/g, "_") || "default";
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

- 语气风格：自然均衡（系统将根据对话自动调整）
- 回复偏好：精简直接，口语化，像真人朋友聊天

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
}
