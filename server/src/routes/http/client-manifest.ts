// HTTP 路由：客户端版本清单（桌面客户端启动检查 + 后期 runtime 收回的总开关）
//
// GET /api/client/manifest —— 返回最新版本 / 最低可用版本 / 安装包下载地址 / 更新说明 / 运行通道。
//   - 发版流程：新版 setup.exe 传 OBS → 改 config/client-manifest.json。文件每次请求实时
//     读取，改完即生效（无需重启、无需重新构建）；后期可挂管理台直接写该文件。
//   - channel 总开关："byok" = 内测期 runtime 随安装包装到用户机器本地跑（自带 key）；
//     收回 runtime 切统一 API 服务时改 "platform"，客户端下次启动读到即切换，必要时同步
//     抬 minVersion 强制淘汰旧版。版本推送 / 强制升级 / 业务形态切换全在这一个接口完成。
//   - 环境变量 CLIENT_MANIFEST_* 可逐字段覆盖文件值（部署期不改文件的临时调整）。
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";

type ClientManifestDto = {
  latest: string;
  minVersion: string;
  url: string;
  notes: string;
  channel: string;
};

/** 内置兜底（config/client-manifest.json 缺失/损坏时使用），与当前客户端版本对齐 */
const DEFAULT_MANIFEST: ClientManifestDto = {
  latest: "0.1.0",
  minVersion: "0.1.0",
  url: "",
  notes: "",
  channel: "byok",
};

const ENV_BY_FIELD = {
  latest: "CLIENT_MANIFEST_LATEST",
  minVersion: "CLIENT_MANIFEST_MIN_VERSION",
  url: "CLIENT_MANIFEST_URL",
  notes: "CLIENT_MANIFEST_NOTES",
  channel: "CLIENT_MANIFEST_CHANNEL",
} as const;

async function readClientManifest(): Promise<ClientManifestDto> {
  let file: Partial<ClientManifestDto> = {};
  try {
    file = JSON.parse(
      await readFile(
        join(process.cwd(), "config", "client-manifest.json"),
        "utf8",
      ),
    ) as Partial<ClientManifestDto>;
  } catch {
    // 文件缺失/损坏：回退内置兜底。接口必须始终可用，客户端启动检查强依赖它。
  }
  const merged: ClientManifestDto = { ...DEFAULT_MANIFEST };
  for (const field of Object.keys(DEFAULT_MANIFEST) as (keyof ClientManifestDto)[]) {
    const fromFile = file[field];
    if (typeof fromFile === "string") merged[field] = fromFile;
    const fromEnv = process.env[ENV_BY_FIELD[field]];
    if (fromEnv && fromEnv.length > 0) merged[field] = fromEnv;
  }
  return merged;
}

export function registerClientManifestRoutes(app: FastifyInstance): void {
  app.get("/api/client/manifest", async () => {
    const manifest = await readClientManifest();
    return { ok: true, ...manifest };
  });
}
