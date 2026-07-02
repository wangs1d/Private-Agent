export interface MeituanConfig {
  accessToken: string;
  skillId: string;
  apiBaseUrl: string;
}

export function getMeituanConfig(env: NodeJS.ProcessEnv = process.env): MeituanConfig {
  return {
    accessToken: env.MEITUAN_AI_HUB_TOKEN?.trim() || "",
    skillId: env.MEITUAN_AI_HUB_SKILL_ID?.trim() || "19",
    apiBaseUrl: env.MEITUAN_AI_HUB_API_BASE?.trim() || "https://developer.meituan.com/api/v2/ai-hub",
  };
}
