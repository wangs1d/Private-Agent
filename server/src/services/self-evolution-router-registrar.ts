/**
 * 自我进化 → tool-router 注册桥接器
 *
 * 把自我进化生成的 Skill 注册到 tool-router 的 registry 中，
 * 使其能被四级分层路由搜索到。同时提供发现和替换工具的能力。
 */

import { readFile, writeFile, readdir, stat } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { homedir } from "node:os";

import type { SkillMetadata } from "../skills/types.js";

// ============================================================
// 类型
// ============================================================

/** Tool-router 的 ResourceRecord 扁平结构（与 models.py 对齐） */
export interface ToolRouterResourceRecord {
  level1: {
    resource_id: string;
    tenant_id: string;
    resource_type: "tool" | "skill" | "mcp_server";
    name: string;
    description: string;
    domain: string;
    capability: string[];
    tags: string[];
    version: string;
    environment: "dev" | "staging" | "prod";
    status: "online" | "offline" | "deprecated";
    base_score: number;
    embedding: number[];
    latency_ms: number;
    created_at: string;
  };
  level2: {
    input_type: string;
    output_type: string;
    use_cases: string[];
    limitations: string[];
    preconditions: string[];
    dependencies: string[];
  };
  level3: {
    tool: Record<string, unknown> | null;
    skill: {
      workflow: string[];
      child_resources: string[];
      retry_policy: Record<string, unknown>;
      fallback_resources: string[];
    } | null;
    mcp_server: Record<string, unknown> | null;
  };
  auth_level: string;
  history_success_score: number;
  failure_penalty: number;
  latency_score: number;
  consecutive_failures: number;
}

interface ToolRouterListResponse {
  resources: Array<{
    name: string;
    resource_type: string;
    domain: string;
    description: string;
    tags: string[];
  }>;
}

// ============================================================
// 工具函数
// ============================================================

function resolveToolRouterHttpUrl(): string | null {
  const url = process.env.TOOL_ROUTER_HTTP_URL?.trim();
  if (!url) return null;
  return url.replace(/\/+$/, "");
}

function resolvePythonBin(): string {
  const candidates = [
    process.env.TOOL_ROUTER_PYTHON_BIN?.trim(),
    process.env.CODEX_PYTHON_BIN?.trim(),
    join(
      homedir(),
      ".cache",
      "codex-runtimes",
      "codex-primary-runtime",
      "dependencies",
      "python",
      process.platform === "win32" ? "python.exe" : "bin/python3",
    ),
    process.platform === "win32"
      ? join(homedir(), ".cache", "codex-runtimes", "codex-primary-runtime", "dependencies", "python", "python.exe")
      : undefined,
    "python",
    "python3",
  ].filter((value): value is string => Boolean(value));

  for (const candidate of candidates) {
    try {
      if (candidate.includes("\\") || candidate.includes("/")) {
        if (!existsSync(candidate)) continue;
        return candidate;
      }
      return candidate;
    } catch {
      continue;
    }
  }
  return "python";
}

function resolveToolRouterRoot(): string | null {
  // 1) 环境变量
  const explicit = process.env.TOOL_ROUTER_ROOT?.trim();
  if (explicit && existsSync(explicit)) return explicit;

  // 2) 从当前模块路径（server/src/services/）上溯到仓库根
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, "tool-router");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  // 3) cwd 上溯
  dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, "tool-router");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** 把 SkillMetadata 转为 tool-router 可识别的 ResourceRecord */
export function skillMetadataToResourceRecord(
  metadata: SkillMetadata,
  skillName: string,
): ToolRouterResourceRecord {
  const now = new Date().toISOString();
  const domain = metadata.tags?.find((t) => t.startsWith("domain:"))?.slice(7) ?? "evolved";
  const tags = metadata.tags ?? [];
  const description = metadata.description || `Self-evolved skill: ${skillName}`;

  return {
    level1: {
      resource_id: skillName,
      tenant_id: "default",
      resource_type: "skill",
      name: skillName,
      description,
      domain,
      capability: [`${domain}.execute`, `${domain}.general`, "self.skill"],
      tags,
      version: metadata.version || "1.0.0",
      environment: "dev",
      status: "online",
      base_score: 0.55,
      embedding: hashTextToVector(`${skillName} ${description} ${domain}`, 64),
      latency_ms: 50,
      created_at: now,
    },
    level2: {
      input_type: `object:${skillName}Input`,
      output_type: "json",
      use_cases: [description, ...(metadata.tags ?? []).slice(0, 10)],
      limitations: ["skill dependencies must be online before execution"],
      preconditions: ["skill must be enabled for the current actor"],
      dependencies: metadata.dependencies ?? [],
    },
    level3: {
      tool: null,
      skill: {
        workflow: ["intent_router", "retrieval", "plan", "deliver"],
        child_resources: [],
        retry_policy: { max_retries: 0, backoff_ms: 250 },
        fallback_resources: [],
      },
      mcp_server: null,
    },
    auth_level: "default",
    history_success_score: 0.5,
    failure_penalty: 0.0,
    latency_score: 0.5,
    consecutive_failures: 0,
  };
}

/** 简单哈希：将文本映射为 64 维向量（用于 tool-router 层级路由的初始 embedding） */
function hashTextToVector(text: string, dims: number): number[] {
  const vector: number[] = new Array(dims).fill(0);
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    const idx = i % dims;
    vector[idx] += (code % 10) / 10;
  }
  // 归一化
  const mag = Math.sqrt(vector.reduce((s, v) => s + v * v, 0)) || 1;
  return vector.map((v) => v / mag);
}

// ============================================================
// 注册 / 列表 / 删除 API
// ============================================================

/**
 * 把新生成的 skill 注册到 tool-router registry。
 * 优先走 HTTP REST；回退到 stdio bridge。
 */
export async function registerSkillToToolRouter(
  metadata: SkillMetadata,
  skillName: string,
): Promise<{ ok: boolean; error?: string }> {
  const resource = skillMetadataToResourceRecord(metadata, skillName);

  // 优先 HTTP
  const httpUrl = resolveToolRouterHttpUrl();
  if (httpUrl) {
    try {
      const response = await fetch(`${httpUrl}/api/resource/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ resource }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) {
        return { ok: false, error: `HTTP ${response.status}` };
      }
      const payload = (await response.json()) as { ok?: boolean; error?: string };
      if (payload.ok === false) {
        return { ok: false, error: payload.error ?? "unknown error" };
      }
      console.log(`[SelfEvolutionRouterRegistrar] ✅ 已注册 '${skillName}' 到 tool-router (HTTP)`);
      return { ok: true };
    } catch (err) {
      console.warn(`[SelfEvolutionRouterRegistrar] HTTP 注册失败，回退 stdio: ${err instanceof Error ? err.message : err}`);
    }
  }

  // 回退 stdio bridge
  try {
    const root = resolveToolRouterRoot();
    if (!root) {
      return { ok: false, error: "tool-router root not found" };
    }
    const pythonBin = resolvePythonBin();
    const script = join(root, "scripts", "bridge_worker.py");
    if (!existsSync(script)) {
      return { ok: false, error: `bridge_worker.py not found at ${script}` };
    }

    const result = await runStdioCommand(pythonBin, script, "register_resource", { resource });
    if (!result?.ok) {
      return { ok: false, error: result?.error ?? "stdio register failed" };
    }
    console.log(`[SelfEvolutionRouterRegistrar] ✅ 已注册 '${skillName}' 到 tool-router (stdio)`);
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `stdio 注册失败: ${msg}` };
  }
}

/**
 * 从 tool-router 获取当前注册的所有资源列表。
 */
export async function listToolRouterResources(): Promise<ToolRouterListResponse> {
  const httpUrl = resolveToolRouterHttpUrl();
  if (httpUrl) {
    try {
      const response = await fetch(`${httpUrl}/api/resource/health-check`, {
        method: "GET",
        signal: AbortSignal.timeout(5_000),
      });
      if (response.ok) {
        const payload = (await response.json()) as any;
        return { resources: payload?.data?.catalog ?? [] };
      }
    } catch {
      // fallback
    }
  }

  try {
    const root = resolveToolRouterRoot();
    if (!root) return { resources: [] };
    const pythonBin = resolvePythonBin();
    const script = join(root, "scripts", "bridge_worker.py");
    if (!existsSync(script)) return { resources: [] };

    const result = await runStdioCommand(pythonBin, script, "list_resources", {});
    if (result?.ok && result?.data?.resources) {
      return { resources: result.data.resources };
    }
  } catch {
    // ignore
  }
  return { resources: [] };
}

/**
 * 从 tool-router 删除一个资源。
 */
export async function removeToolRouterResource(
  resourceId: string,
): Promise<{ ok: boolean; error?: string }> {
  // tool-router 没有直接的删除 API，标记为 deprecated
  // 用 register 覆盖 status 为 deprecated
  try {
    const httpUrl = resolveToolRouterHttpUrl();
    if (httpUrl) {
      const response = await fetch(`${httpUrl}/api/resource/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          resource: {
            level1: {
              resource_id: resourceId,
              resource_type: "skill",
              status: "deprecated",
            },
          },
        }),
        signal: AbortSignal.timeout(5_000),
      });
      return { ok: response.ok };
    }
  } catch {
    // ignore
  }
  return { ok: false, error: "tool-router not reachable" };
}

// ============================================================
// 工具：发现更好的替代方案
// ============================================================

/**
 * 扫描当前 tool-router 注册的资源，与外部发现对比，返回更优方案列表。
 */
export async function discoverBetterTools(
  externalScanResults: Array<{
    name: string;
    description: string;
    sourceUrl: string;
    domain: string;
    score: number;
  }>,
): Promise<Array<{
  currentName: string;
  currentDescription: string;
  alternativeName: string;
  alternativeDescription: string;
  sourceUrl: string;
  improvement: string;
}>> {
  const current = await listToolRouterResources();
  const replacements: Array<{
    currentName: string;
    currentDescription: string;
    alternativeName: string;
    alternativeDescription: string;
    sourceUrl: string;
    improvement: string;
  }> = [];

  for (const external of externalScanResults) {
    // 按 domain 对比当前注册的资源
    const candidates = current.resources.filter(
      (r) => r.domain === external.domain || r.tags?.includes(external.domain),
    );
    for (const candidate of candidates) {
      // 简单语义对比：如果外部方案的描述更丰富或得分更高，标记为替代方案
      if (external.score > 0.7 && external.description.length > candidate.description.length) {
        replacements.push({
          currentName: candidate.name,
          currentDescription: candidate.description,
          alternativeName: external.name,
          alternativeDescription: external.description,
          sourceUrl: external.sourceUrl,
          improvement: `外部发现更优方案: ${external.name}（${external.description}），来自 ${external.sourceUrl}`,
        });
      }
    }
  }

  return replacements;
}

// ============================================================
// 工具：读取/修改 tool-router 代码
// ============================================================

/**
 * 读取 tool-router 的指定代码文件内容。
 */
export async function readToolRouterCode(
  relativePath: string,
): Promise<{ ok: boolean; content?: string; error?: string }> {
  const root = resolveToolRouterRoot();
  if (!root) return { ok: false, error: "tool-router root not found" };

  const fullPath = join(root, relativePath);
  if (!fullPath.startsWith(root)) {
    return { ok: false, error: "Path traversal detected" };
  }
  if (!existsSync(fullPath)) {
    return { ok: false, error: `File not found: ${relativePath}` };
  }

  try {
    const content = await readFile(fullPath, "utf8");
    return { ok: true, content };
  } catch (err) {
    return { ok: false, error: `Read failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * 写入修改后的 tool-router 代码文件。
 */
export async function writeToolRouterCode(
  relativePath: string,
  content: string,
): Promise<{ ok: boolean; error?: string }> {
  const root = resolveToolRouterRoot();
  if (!root) return { ok: false, error: "tool-router root not found" };

  const fullPath = join(root, relativePath);
  if (!fullPath.startsWith(root)) {
    return { ok: false, error: "Path traversal detected" };
  }

  try {
    await writeFile(fullPath, content, "utf8");
    console.log(`[SelfEvolutionRouterRegistrar] ✅ 已写入 ${relativePath}`);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `Write failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * 列出 tool-router 目录下的所有 .py 文件。
 */
export async function listToolRouterCodeFiles(): Promise<string[]> {
  const root = resolveToolRouterRoot();
  if (!root) return [];

  const files: string[] = [];
  const dirsToVisit = [""];

  while (dirsToVisit.length > 0) {
    const relative = dirsToVisit.pop()!;
    const fullDir = join(root, relative);
    try {
      const entries = await readdir(fullDir, { withFileTypes: true });
      for (const entry of entries) {
        const relPath = relative ? `${relative}/${entry.name}` : entry.name;
        if (entry.isDirectory() && !entry.name.startsWith(".") && !entry.name.startsWith("__pycache__") && !entry.name.startsWith("node_modules") && !entry.name.startsWith(".venv")) {
          dirsToVisit.push(relPath);
        } else if (entry.isFile() && entry.name.endsWith(".py")) {
          files.push(relPath);
        }
      }
    } catch {
      continue;
    }
  }
  return files.sort();
}

// ============================================================
// 内部工具
// ============================================================

async function runStdioCommand(
  pythonBin: string,
  script: string,
  command: string,
  payload: Record<string, unknown>,
): Promise<any> {
  return new Promise((resolve, reject) => {
    const proc = spawn(pythonBin, [script], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const timeout = setTimeout(() => {
      proc.kill();
      reject(new Error("stdio timeout"));
    }, 15_000);

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    proc.on("close", (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new Error(`stdio exited ${code}: ${stderr.slice(0, 200)}`));
        return;
      }
      try {
        const lines = stdout.trim().split("\n").filter(Boolean);
        const last = lines[lines.length - 1];
        resolve(last ? JSON.parse(last) : null);
      } catch {
        reject(new Error(`stdio parse failed: ${stdout.slice(0, 200)}`));
      }
    });

    proc.on("error", reject);
    proc.stdin.write(`${JSON.stringify({ id: "1", command, payload })}\n`);
    proc.stdin.end();
  });
}