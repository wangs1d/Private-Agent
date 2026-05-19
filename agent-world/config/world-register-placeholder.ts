/**
 * Agent 面向的「一键注册」占位开关：正式注册题（SHA-256 等）后续再实现/强化时，
 * 开发或内网可开启本开关，便于 Agent 单步完成注册。
 *
 * 生产环境请勿设置；默认关闭。
 */
export function allowAgentWorldPlaceholderRegister(): boolean {
  return process.env.AGENT_WORLD_PLACEHOLDER_REGISTER === "1";
}
