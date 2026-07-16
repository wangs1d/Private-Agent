/**
 * 美团真实搜索/下单端到端测试脚本。
 *
 * 用法：
 *   npx tsx scripts/test-meituan-shopping.ts <cookie-json-path> [action] [query]
 *
 * 参数：
 *   cookie-json-path  Cookie-Editor 导出的 JSON 文件路径
 *   action            search | place-stage1 | place-stage2 | track
 *                     默认 search
 *   query             搜索关键词（search / place-stage1 时必填）
 *                     place-stage2 时传 confirmationToken
 *
 * 示例：
 *   # 1. 搜索肯德基
 *   npx tsx scripts/test-meituan-shopping.ts ./meituan-cookies.json search 肯德基
 *
 *   # 2. 走到结算页（不下单）
 *   npx tsx scripts/test-meituan-shopping.ts ./meituan-cookies.json place-stage1 肯德基
 *
 *   # 3. 确认下单（花真钱）
 *   npx tsx scripts/test-meituan-shopping.ts ./meituan-cookies.json place-stage2 <token-from-stage1>
 *
 *   # 4. 查订单
 *   npx tsx scripts/test-meituan-shopping.ts ./meituan-cookies.json track
 *
 * 安全：place-stage2 会真实提交订单花真钱，执行前会打印订单摘要要求确认。
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

import { BrowserSessionService } from "../src/services/browser-session-service.js";
import { ShoppingOrderService } from "../src/services/shopping-order-service.js";
import type { ImportedBrowserCookie } from "../src/services/browser-session-types.js";

const ACTOR_ID = "test-meituan-e2e";
const PLATFORM = "meituan";

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 1) {
    console.error("用法: npx tsx scripts/test-meituan-shopping.ts <cookie-json-path> [action] [query-or-token]");
    console.error("  action: search (默认) | place-stage1 | place-stage2 | track");
    process.exit(1);
  }

  const cookiePath = args[0]!;
  const action = (args[1] ?? "search") as "search" | "place-stage1" | "place-stage2" | "track";
  const queryOrToken = args[2] ?? "";

  // 1. 读取 Cookie JSON
  console.log(`\n[1/4] 读取 Cookie 文件: ${cookiePath}`);
  let cookies: ImportedBrowserCookie[];
  try {
    const raw = await readFile(cookiePath, "utf8");
    cookies = JSON.parse(raw);
    if (!Array.isArray(cookies) || cookies.length === 0) {
      throw new Error("Cookie 文件不是非空 JSON 数组");
    }
    console.log(`  ✓ 读取 ${cookies.length} 条 Cookie`);
  } catch (e) {
    console.error(`  ✗ 读取 Cookie 文件失败: ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  }

  // 2. 在临时数据目录中初始化 service
  const tempDir = await mkdtemp(join(tmpdir(), "meituan-e2e-"));
  process.env.BROWSER_SESSION_DATA_DIR = tempDir;
  console.log(`\n[2/4] 初始化服务 (临时目录: ${tempDir})`);

  const browserSessionService = new BrowserSessionService();
  const shoppingOrderService = new ShoppingOrderService({ browserSessionService });

  // 3. 导入 Cookie + 授权
  console.log(`\n[3/4] 导入美团 Cookie 并授权 agentAllowed=true`);
  try {
    await browserSessionService.importCookies(ACTOR_ID, PLATFORM, cookies, { agentAllowed: true });
    console.log(`  ✓ Cookie 已导入并授权`);
  } catch (e) {
    console.error(`  ✗ 导入 Cookie 失败: ${e instanceof Error ? e.message : e}`);
    console.error("  提示: 确保 Cookie 的 domain 是 .meituan.com 或 www.meituan.com");
    await cleanup(tempDir, shoppingOrderService);
    process.exit(1);
  }

  // 4. 执行操作
  console.log(`\n[4/4] 执行操作: ${action}`);
  const ctx = {
    sessionId: "test-meituan-e2e",
    userId: "test-user-meituan",
    agentAccessMode: "full" as const,
  };

  try {
    switch (action) {
      case "search": {
        if (!queryOrToken) {
          console.error("  ✗ search 需要搜索关键词，例如: npx tsx scripts/test-meituan-shopping.ts ./cookies.json search 肯德基");
          process.exit(1);
        }
        console.log(`  搜索关键词: ${queryOrToken}`);
        console.log(`  正在启动 Playwright 无头浏览器...`);
        const result = await shoppingOrderService.searchProduct(ctx, PLATFORM, queryOrToken, { limit: 5 });
        console.log(`\n========== 搜索结果 ==========`);
        console.log(JSON.stringify(result, null, 2));
        break;
      }
      case "place-stage1": {
        if (!queryOrToken) {
          console.error("  ✗ place-stage1 需要商品关键词");
          process.exit(1);
        }
        console.log(`  商品: ${queryOrToken}`);
        console.log(`  正在启动 Playwright 走到结算页（不点提交订单）...`);
        const result = await shoppingOrderService.placeOrder(ctx, PLATFORM, queryOrToken, 1, false, undefined);
        console.log(`\n========== 订单摘要（阶段一） ==========`);
        console.log(JSON.stringify(result, null, 2));
        if (result.ok) {
          console.log(`\n⚠️  确认 token: ${(result as { confirmationToken?: string }).confirmationToken}`);
          console.log(`如需真实下单，运行:`);
          console.log(`  npx tsx scripts/test-meituan-shopping.ts ${cookiePath} place-stage2 ${(result as { confirmationToken?: string }).confirmationToken}`);
        }
        break;
      }
      case "place-stage2": {
        if (!queryOrToken) {
          console.error("  ✗ place-stage2 需要 confirmationToken（来自阶段一）");
          process.exit(1);
        }
        console.log(`  ⚠️  警告: 这将真实提交订单并花真钱！`);
        console.log(`  confirmationToken: ${queryOrToken}`);
        console.log(`  3 秒后开始执行...`);
        await new Promise((r) => setTimeout(r, 3000));
        const result = await shoppingOrderService.placeOrder(ctx, PLATFORM, queryOrToken, 1, true, queryOrToken);
        console.log(`\n========== 下单结果（阶段二） ==========`);
        console.log(JSON.stringify(result, null, 2));
        break;
      }
      case "track": {
        console.log(`  正在查询最近美团订单...`);
        const result = await shoppingOrderService.trackOrder(ctx, PLATFORM, undefined);
        console.log(`\n========== 订单状态 ==========`);
        console.log(JSON.stringify(result, null, 2));
        break;
      }
      default:
        console.error(`  ✗ 未知 action: ${action}（支持: search | place-stage1 | place-stage2 | track）`);
        process.exit(1);
    }
  } catch (e) {
    console.error(`\n✗ 执行失败: ${e instanceof Error ? e.message : e}`);
    if (e instanceof Error && e.stack) {
      console.error(e.stack);
    }
  } finally {
    await cleanup(tempDir, shoppingOrderService);
  }
}

async function cleanup(tempDir: string, service: ShoppingOrderService): Promise<void> {
  try {
    await service.dispose();
  } catch {}
  await rm(tempDir, { recursive: true, force: true });
}

main().catch((e) => {
  console.error("未捕获异常:", e);
  process.exit(1);
});
