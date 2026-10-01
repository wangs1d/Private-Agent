/**
 * 本地向量引擎的回环 HTTP 端点：把 ONNX 引擎包装成 OpenAI 兼容 `/v1/embeddings`。
 *
 * 为什么要 HTTP 而不是进程内直调：mem0ai 的 OpenAIEmbedder 只认 baseURL，包一层
 * OpenAI 兼容端点后 mem0 / 混合召回 / 遗忘补捞等所有嵌入消费方零改造接入。
 * 仅绑定 127.0.0.1，鉴权用启动期随机 token（防本机其他进程误打）。
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";

import type { LocalEmbeddingEngine } from "./local-embedding-engine.js";

export type LocalEmbeddingEndpoint = {
  /** 纯 base URL（如 http://127.0.0.1:53124/v1），消费方自行拼 /embeddings */
  baseUrl: string;
  apiKey: string;
  model: string;
  dims: number;
};

const MAX_BODY_BYTES = 8 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

export async function startLocalEmbeddingServer(engine: LocalEmbeddingEngine): Promise<LocalEmbeddingEndpoint> {
  const apiKey = `local-${randomBytes(12).toString("hex")}`;

  const server = createServer((req, res) => {
    void handle(req, res).catch((err: unknown) => {
      if (!res.headersSent) sendJson(res, 500, { error: { message: String(err) } });
      else res.end();
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = req.url ?? "";
    if (req.method === "GET" && (url === "/health" || url === "/v1/health")) {
      sendJson(res, 200, { ok: true, model: engine.model, dims: engine.dims });
      return;
    }
    if (req.method !== "POST" || !/^\/(v1\/)?embeddings$/.test(url)) {
      sendJson(res, 404, { error: { message: "not found" } });
      return;
    }
    if ((req.headers.authorization ?? "") !== `Bearer ${apiKey}`) {
      sendJson(res, 401, { error: { message: "unauthorized" } });
      return;
    }

    const parsed = JSON.parse(await readBody(req)) as {
      input?: string | string[];
      model?: string;
      encoding_format?: string;
    };
    const rawInput = parsed.input;
    const inputs = Array.isArray(rawInput) ? rawInput : rawInput != null ? [rawInput] : [];
    if (inputs.length === 0 || inputs.some((t) => typeof t !== "string")) {
      sendJson(res, 400, { error: { message: "input must be a string or string[]" } });
      return;
    }

    const vectors = await engine.embed(inputs);
    // openai-node v6 起默认 encoding_format=base64 且无条件按 base64 解码响应；
    // 必须按请求格式回包，否则 SDK 会把 JSON 数组当 base64 串解出垃圾维度
    const asBase64 = parsed.encoding_format === "base64";
    sendJson(res, 200, {
      object: "list",
      model: engine.model,
      data: vectors.map((embedding, index) => ({
        object: "embedding",
        index,
        embedding: asBase64
          ? Buffer.from(new Float32Array(embedding).buffer).toString("base64")
          : embedding,
      })),
      usage: { prompt_tokens: 0, total_tokens: 0 },
    });
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  server.unref();
  // 慢请求看门狗：回环本地推理不该超过 30s，超时兜底避免调用方悬挂
  server.requestTimeout = REQUEST_TIMEOUT_MS;

  const { port } = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${port}/v1`, apiKey, model: engine.model, dims: engine.dims };
}
