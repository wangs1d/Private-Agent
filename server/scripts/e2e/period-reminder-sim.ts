/**
 * 周期临近提醒的进程内仿真：隔离「服务逻辑」与「服务端接线」。
 *   node --env-file=.env --env-file=.env.local --import tsx scripts/e2e/period-reminder-sim.ts
 */
import { config } from "dotenv";
import { join } from "node:path";

config({ path: join(process.cwd(), ".env") });
config({ path: join(process.cwd(), ".env.local") });

import { PeriodCareService } from "../../src/services/period-care-service.js";

const actor = process.env.E2E_ACTOR ?? "xiaoyu-e2e";
const svc = new PeriodCareService({
  dataDir: join(process.cwd(), "data", "period-care"),
  getPipeline: () => ({
    submitProposal: (p) => {
      console.log(`[sim] 提案已提交 kind=${p.kind} dedupKey=${p.dedupKey}`);
      console.log(`[sim] 文案: ${p.directText}`);
      return { verdict: "delivered" };
    },
  }),
});

await svc.load();
const status = svc.getStatus(actor);
console.log(`[sim] actor=${actor}`);
console.log(`[sim] 预测下次开始=${status.predictedNextStart} 距今天数=${status.daysUntilPredictedStart} 置信度=${status.confidence}`);
console.log(`[sim] 提醒设置: enabled=${svc.getSettings(actor).reminderEnabled} daysBefore=${svc.getSettings(actor).reminderDaysBefore} hour=${svc.getSettings(actor).reminderHour}`);
const now = new Date();
console.log(`[sim] now=${now.toString()} localDateKey 时区小时=${now.getHours()}`);

const fired = await svc.runDue(now);
console.log(`[sim] runDue 触发条数=${fired}`);

// 再跑一次验证同日去重
const fired2 = await svc.runDue(new Date(Date.now() + 65_000));
console.log(`[sim] +65s 再次触发（应为 0）=${fired2}`);
process.exit(0);
