import type { ExternalChatProvider } from "./types.js";
import { MoonshotKimiProvider } from "./providers/moonshot-kimi-provider.js";
import { OpenAiOfficialProvider } from "./providers/openai-official-provider.js";
import { FailoverChatProvider } from "./failover-chat-provider.js";
import { instantiateKnownProvider } from "./instantiate-provider.js";

/** 与 `EXTERNAL_MODEL_PROVIDER` 对齐 */
export type ExternalModelMode = "auto" | "none" | "moonshot-kimi" | "openai" | "failover";

function parseMode(): ExternalModelMode {
  const raw = (process.env.EXTERNAL_MODEL_PROVIDER ?? "").trim().toLowerCase();
  if (!raw || raw === "auto") return "auto";
  if (raw === "none" || raw === "off" || raw === "disabled") return "none";
  if (raw === "moonshot-kimi" || raw === "moonshot" || raw === "kimi") return "moonshot-kimi";
  if (raw === "openai") return "openai";
  if (raw === "failover") return "failover";
  console.warn(
    `[external-model] Unknown EXTERNAL_MODEL_PROVIDER="${raw}", falling back to auto.`,
  );
  return "auto";
}

function defaultFailoverChain(): string {
  return (process.env.EXTERNAL_MODEL_FAILOVER_CHAIN ?? "moonshot-kimi,openai").trim();
}

/**
 * 按 `EXTERNAL_MODEL_PROVIDER` 与各厂商密钥解析唯一的外部聊天实现。
 *
 * - `auto`（默认）：优先 `MOONSHOT_API_KEY`（Kimi），否则 `OPENAI_API_KEY`。
 * - `none`：不启用外部模型。
 * - `moonshot-kimi`：仅 Kimi；缺密钥则 null 并警告。
 * - `openai`：仅 OpenAI；缺密钥则 null 并警告。
 * - `failover`：按 `EXTERNAL_MODEL_FAILOVER_CHAIN`（默认 `moonshot-kimi,openai`）顺序尝试，链上至少一个已配置密钥才启用。
 */
export function createExternalChatProviderFromEnv(): ExternalChatProvider | null {
  const mode = parseMode();
  if (mode === "none") return null;

  const moonshot = new MoonshotKimiProvider();
  const openai = new OpenAiOfficialProvider();

  if (mode === "moonshot-kimi") {
    if (moonshot.isEnabled()) return moonshot;
    console.warn(
      "[external-model] EXTERNAL_MODEL_PROVIDER=moonshot-kimi but MOONSHOT_API_KEY is not set.",
    );
    return null;
  }

  if (mode === "openai") {
    if (openai.isEnabled()) return openai;
    console.warn(
      "[external-model] EXTERNAL_MODEL_PROVIDER=openai but OPENAI_API_KEY is not set.",
    );
    return null;
  }

  if (mode === "failover") {
    const chainStr = defaultFailoverChain();
    const tokens = chainStr.split(",").map((s) => s.trim()).filter(Boolean);
    const chain: ExternalChatProvider[] = [];
    for (const token of tokens) {
      const p = instantiateKnownProvider(token);
      if (!p) {
        console.warn(`[external-model] Unknown provider in failover chain: "${token}", skipped.`);
        continue;
      }
      chain.push(p);
    }
    if (chain.length === 0) {
      console.warn("[external-model] failover chain is empty after parsing.");
      return null;
    }
    const fb = new FailoverChatProvider(chain);
    if (!fb.isEnabled()) {
      console.warn(
        "[external-model] EXTERNAL_MODEL_PROVIDER=failover but no provider in chain has credentials.",
      );
      return null;
    }
    return fb;
  }

  // auto
  if (moonshot.isEnabled()) return moonshot;
  if (openai.isEnabled()) return openai;
  return null;
}
