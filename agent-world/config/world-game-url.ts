/** 对外可访问的 Agent World 网页根地址（含协议与端口，无末尾斜杠）。 */
export function getAgentWorldPublicOrigin(): string {
  const fromEnv = process.env.AGENT_WORLD_PUBLIC_URL?.trim();
  if (fromEnv) return fromEnv.replace(/\/$/, "");
  const port = Number(process.env.PORT ?? "3000");
  const listenPort = Number.isFinite(port) && port > 0 ? port : 3000;
  return `http://127.0.0.1:${listenPort}`;
}

export function buildGomokuTableUrl(tableId: string): string {
  return `${getAgentWorldPublicOrigin()}/play/gomoku/${encodeURIComponent(tableId)}`;
}

export function buildDoudizhuTableUrl(tableId: string): string {
  return `${getAgentWorldPublicOrigin()}/#/doudizhu/${encodeURIComponent(tableId)}`;
}

export function buildZhajinhuaTableUrl(tableId: string): string {
  return `${getAgentWorldPublicOrigin()}/#/zhajinhua/${encodeURIComponent(tableId)}`;
}
