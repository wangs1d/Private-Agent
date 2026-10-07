/**
 * 路由解耦实测探针（2026-10-07）：主模型=minimax，路由=auto 链选中的
 * openai 槽位（DeepSeek deepseek-flash）。同一批用例对比两种路由模型的
 * 意图判定，验证「你知道我的老婆是谁吧」这类闲聊不再被吸进任务面。
 *
 * 用法（server 目录下）：
 *   node --import tsx test/tmp-probe/probe-route-provider.ts
 *
 * 需要 OPENAI_API_KEY（指向 DeepSeek）+ MINIMAX_API_KEY（.env.local 自动加载）。
 * 真实外网调用；路由缓存键用零宽后缀区分新旧两轮，避免互相污染。
 */
import "../../src/config/load-server-env.js";
import { createExternalChatProviderFromEnv } from "../../src/external-model/resolve-provider.js";
import { resolveRouteChatProvider } from "../../src/external-model/route-chat-provider.js";
import { routeTurnByLlm } from "../../src/agent/llm-task-router.js";

const CASES = [
  "你知道我的老婆是谁吧",
  "在吗",
  "哈哈哈哈笑死我了",
  "别打了哥，真的，系统制裁你",
  "今天天气怎么样",
  "帮我看看我的快递到哪了",
  "比特币现在什么价",
];

async function probeOne(
  label: string,
  provider: unknown,
  text: string,
  cacheBust: string,
): Promise<void> {
  const t0 = Date.now();
  const d = await routeTurnByLlm(provider as never, "probe-route-provider", text + cacheBust);
  const ms = Date.now() - t0;
  console.log(
    `[${label}] "${text}" → plane=${d.plane} intent=${d.intent ?? "-"} conf=${d.confidence?.toFixed(2) ?? "-"} ${ms}ms | ${d.reasons.join(" ; ")}`,
  );
}

async function main(): Promise<void> {
  const mainProvider = createExternalChatProviderFromEnv();
  console.log(`主模型 provider: ${mainProvider?.id ?? "null"}`);
  const routeProvider = resolveRouteChatProvider(mainProvider);
  console.log(
    `路由 provider: ${(routeProvider as { id?: string } | null)?.id ?? "null"}\n`,
  );

  console.log("── 旧行为对照：路由跟随主模型 ──");
  for (const c of CASES) {
    try {
      await probeOne("旧", mainProvider, c, "");
    } catch (e) {
      console.log(`[旧] "${c}" → 异常 ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  console.log("\n── 新行为：路由固定（auto 链，独立于主模型）──");
  for (const c of CASES) {
    try {
      await probeOne("新", routeProvider, c, "\u200B");
    } catch (e) {
      console.log(`[新] "${c}" → 异常 ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
